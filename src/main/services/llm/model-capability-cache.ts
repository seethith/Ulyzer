import { getDb } from '../db/sqlite';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TIMEOUT_MS = 15_000;
const MODELS_DEV_SOURCE = 'models.dev';
const MAX_RAW_JSON_BYTES = 128 * 1024;
export const MODELS_DEV_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const PROVIDER_ID_TO_MODELS_DEV: Record<string, string[]> = {
  anthropic:  ['anthropic'],
  openai:     ['openai'],
  gemini:     ['google'],
  grok:       ['xai'],
  openrouter: ['openrouter'],
  deepseek:   ['deepseek'],
  qwen:       ['alibaba', 'alibaba-cn'],
  minimax:    ['minimax', 'minimax-cn'],
  mistral:    ['mistral'],
  groq:       ['groq'],
  together:   ['togetherai'],
  moonshot:   ['moonshotai', 'moonshotai-cn'],
  zhipu:      ['zhipuai'],
  perplexity: ['perplexity'],
  cohere:     ['cohere'],
};

interface ModelsDevProvider {
  id?: string;
  models?: Record<string, ModelsDevModel>;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  structured_outputs?: boolean;
  json_output?: boolean;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
  };
}

export interface CachedModelCapability {
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  supportsTools: boolean | null;
  supportsJson: boolean | null;
  supportsReasoning: boolean | null;
}

interface CacheRow {
  input_modalities: string | null;
  output_modalities: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  input_price: number | null;
  output_price: number | null;
  supports_tools: number | null;
  supports_json: number | null;
  supports_reasoning: number | null;
}

function providerToModelsDev(providerId: string): string[] {
  return PROVIDER_ID_TO_MODELS_DEV[providerId] ?? [];
}

async function fetchModelsDevApi(): Promise<Record<string, ModelsDevProvider>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    return await res.json() as Record<string, ModelsDevProvider>;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(value: unknown): string {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, 'utf8') <= MAX_RAW_JSON_BYTES
    ? json
    : JSON.stringify({ truncated: true });
}

function sanitizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function boolToDb(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function rowToCapability(row: CacheRow | undefined): CachedModelCapability | null {
  if (!row) return null;
  return {
    inputModalities:  parseStringArray(row.input_modalities),
    outputModalities: parseStringArray(row.output_modalities),
    contextWindow:    row.context_window ?? null,
    maxOutputTokens:  row.max_output_tokens ?? null,
    inputPrice:       row.input_price ?? null,
    outputPrice:      row.output_price ?? null,
    supportsTools:    row.supports_tools === null ? null : row.supports_tools === 1,
    supportsJson:     row.supports_json === null ? null : row.supports_json === 1,
    supportsReasoning: row.supports_reasoning === null ? null : row.supports_reasoning === 1,
  };
}

function modelLookupKeys(modelId: string): string[] {
  const keys = [modelId];
  const routedName = modelId.includes('/') ? modelId.split('/').pop() : null;
  if (routedName && routedName !== modelId) keys.push(routedName);
  return keys;
}

export function readCachedModelCapability(providerId: string, modelId: string): CachedModelCapability | null {
  try {
    const db = getDb();
    const stmt = db.prepare<[string, string, string], CacheRow>(
      `SELECT input_modalities, output_modalities, context_window, max_output_tokens,
              input_price, output_price, supports_tools, supports_json, supports_reasoning
         FROM model_capability_cache
        WHERE provider_id = ? AND model_id = ? AND source = ?`,
    );
    for (const key of modelLookupKeys(modelId)) {
      const row = stmt.get(providerId, key, MODELS_DEV_SOURCE);
      if (row) return rowToCapability(row);
    }
  } catch {
    // Capability cache is opportunistic. If DB is unavailable or not migrated yet,
    // callers should fall back to the curated local capability table.
  }
  return null;
}

export async function refreshModelsDevCapabilityCache(input?: {
  providerIds?: string[];
}): Promise<{ updated: number }> {
  const api = await fetchModelsDevApi();
  const providerIds = input?.providerIds?.length
    ? input.providerIds
    : Object.keys(PROVIDER_ID_TO_MODELS_DEV);
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO model_capability_cache (
       provider_id, model_id, source, source_provider_id, raw_json,
       input_modalities, output_modalities, context_window, max_output_tokens,
       input_price, output_price, supports_tools, supports_json, supports_reasoning,
       fetched_at
     ) VALUES (
       @provider_id, @model_id, @source, @source_provider_id, @raw_json,
       @input_modalities, @output_modalities, @context_window, @max_output_tokens,
       @input_price, @output_price, @supports_tools, @supports_json, @supports_reasoning,
       datetime('now')
     )
     ON CONFLICT(provider_id, model_id, source) DO UPDATE SET
       source_provider_id = excluded.source_provider_id,
       raw_json = excluded.raw_json,
       input_modalities = excluded.input_modalities,
       output_modalities = excluded.output_modalities,
       context_window = excluded.context_window,
       max_output_tokens = excluded.max_output_tokens,
       input_price = excluded.input_price,
       output_price = excluded.output_price,
       supports_tools = excluded.supports_tools,
       supports_json = excluded.supports_json,
       supports_reasoning = excluded.supports_reasoning,
       fetched_at = datetime('now')`,
  );

  let updated = 0;
  db.transaction(() => {
    for (const providerId of providerIds) {
      for (const modelsDevProviderId of providerToModelsDev(providerId)) {
        const provider = api[modelsDevProviderId];
        if (!provider?.models) continue;

        for (const rawModel of Object.values(provider.models)) {
          const modelId = rawModel.id;
          if (!modelId) continue;
          const inputModalities = rawModel.modalities?.input ?? ['text'];
          const outputModalities = rawModel.modalities?.output ?? ['text'];
          upsert.run({
            provider_id: providerId,
            model_id: modelId,
            source: MODELS_DEV_SOURCE,
            source_provider_id: modelsDevProviderId,
            raw_json: safeJson(rawModel),
            input_modalities: JSON.stringify(inputModalities),
            output_modalities: JSON.stringify(outputModalities),
            context_window: sanitizeNumber(rawModel.limit?.context ?? rawModel.limit?.input),
            max_output_tokens: sanitizeNumber(rawModel.limit?.output),
            input_price: sanitizeNumber(rawModel.cost?.input),
            output_price: sanitizeNumber(rawModel.cost?.output),
            supports_tools: boolToDb(rawModel.tool_call),
            supports_json: boolToDb(rawModel.structured_output ?? rawModel.structured_outputs ?? rawModel.json_output),
            supports_reasoning: boolToDb(rawModel.reasoning),
          });
          updated++;
        }
      }
    }
  })();

  return { updated };
}

export async function refreshStaleModelsDevCapabilityCache(maxAgeMs = MODELS_DEV_REFRESH_INTERVAL_MS): Promise<void> {
  const row = getDb()
    .prepare<[string], { fetched_at: string | null }>(
      'SELECT MAX(fetched_at) AS fetched_at FROM model_capability_cache WHERE source = ?',
    )
    .get(MODELS_DEV_SOURCE);
  const fetchedAt = row?.fetched_at ? Date.parse(`${row.fetched_at}Z`) : 0;
  if (fetchedAt && Date.now() - fetchedAt < maxAgeMs) return;
  await refreshModelsDevCapabilityCache();
}
