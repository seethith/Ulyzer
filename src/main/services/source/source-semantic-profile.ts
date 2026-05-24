import { createHash } from 'crypto';
import type { LLMMessage, LLMProvider, SourceRecord, SourceSemanticProfile, SourceSemanticProfileStatus } from '@shared/types';
import { getDb } from '../db/sqlite';
import { formatDocumentSummaryTreeForAgent } from '../documents/document-summary-tree';
import { LLMAdapter } from '../llm/adapter';
import { getSourceById, getSourceChunks } from './source-library';

const PROFILE_VERSION = 'v1_source_semantic_profile';
const MAX_PREVIEW_CHARS = 9000;
const MAX_ARRAY_ITEMS = 12;
const running = new Set<string>();

interface ProfileRow {
  source_id: string;
  status: SourceSemanticProfileStatus;
  summary: string | null;
  concepts_json: string | null;
  suitable_for_json: string | null;
  difficulty: string | null;
  content_types_json: string | null;
  quality_notes: string | null;
  node_hints_json: string | null;
  model: string | null;
  content_hash: string | null;
  error: string | null;
  updated_at: string | null;
}

interface SettingsRow {
  default_provider: string | null;
  default_model: string | null;
}

interface MetaRow {
  content_hash: string | null;
  chunk_count: number | null;
  processing_state: string | null;
}

function jsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text.slice(0, 48));
    if (out.length >= MAX_ARRAY_ITEMS) break;
  }
  return out;
}

function rowToProfile(row: ProfileRow): SourceSemanticProfile {
  return {
    sourceId: row.source_id,
    status: row.status,
    summary: row.summary,
    concepts: jsonArray(row.concepts_json),
    suitableFor: jsonArray(row.suitable_for_json),
    difficulty: row.difficulty,
    contentTypes: jsonArray(row.content_types_json),
    qualityNotes: row.quality_notes,
    nodeHints: jsonArray(row.node_hints_json),
    model: row.model,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function readProfile(sourceId: string): SourceSemanticProfile | null {
  const row = getDb()
    .prepare<[string], ProfileRow>('SELECT * FROM source_semantic_profiles WHERE source_id = ?')
    .get(sourceId);
  return row ? rowToProfile(row) : null;
}

function writeProfile(input: {
  source: SourceRecord;
  status: SourceSemanticProfileStatus;
  summary?: string | null;
  concepts?: string[];
  suitableFor?: string[];
  difficulty?: string | null;
  contentTypes?: string[];
  qualityNotes?: string | null;
  nodeHints?: string[];
  model?: string | null;
  contentHash?: string | null;
  error?: string | null;
}): SourceSemanticProfile {
  getDb().prepare(
    `INSERT INTO source_semantic_profiles (
       source_id, course_id, status, summary, concepts_json, suitable_for_json,
       difficulty, content_types_json, quality_notes, node_hints_json, model,
       content_hash, error, updated_at
     ) VALUES (
       @source_id, @course_id, @status, @summary, @concepts_json, @suitable_for_json,
       @difficulty, @content_types_json, @quality_notes, @node_hints_json, @model,
       @content_hash, @error, datetime('now')
     )
     ON CONFLICT(source_id) DO UPDATE SET
       course_id = excluded.course_id,
       status = excluded.status,
       summary = excluded.summary,
       concepts_json = excluded.concepts_json,
       suitable_for_json = excluded.suitable_for_json,
       difficulty = excluded.difficulty,
       content_types_json = excluded.content_types_json,
       quality_notes = excluded.quality_notes,
       node_hints_json = excluded.node_hints_json,
       model = excluded.model,
       content_hash = excluded.content_hash,
       error = excluded.error,
       updated_at = datetime('now')`,
  ).run({
    source_id: input.source.id,
    course_id: input.source.courseId,
    status: input.status,
    summary: input.summary ?? null,
    concepts_json: JSON.stringify(input.concepts ?? []),
    suitable_for_json: JSON.stringify(input.suitableFor ?? []),
    difficulty: input.difficulty ?? null,
    content_types_json: JSON.stringify(input.contentTypes ?? []),
    quality_notes: input.qualityNotes ?? null,
    node_hints_json: JSON.stringify(input.nodeHints ?? []),
    model: input.model ?? null,
    content_hash: input.contentHash ?? null,
    error: input.error ?? null,
  });
  return readProfile(input.source.id)!;
}

function sourceMeta(sourceId: string): MetaRow | null {
  return getDb()
    .prepare<[string], MetaRow>(
      'SELECT content_hash, chunk_count, processing_state FROM source_document_meta WHERE source_id = ?',
    )
    .get(sourceId) ?? null;
}

function configuredModel(): { provider: LLMProvider; model: string } | null {
  const row = getDb()
    .prepare<[], SettingsRow>('SELECT default_provider, default_model FROM settings WHERE id = 1')
    .get();
  const provider = row?.default_provider?.trim();
  const model = row?.default_model?.trim();
  if (!provider || !model) return null;
  return { provider: provider as LLMProvider, model };
}

function compact(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function previewHash(source: SourceRecord, preview: string, meta: MetaRow | null): string {
  const hash = createHash('sha256');
  hash.update(PROFILE_VERSION);
  hash.update('|');
  hash.update(meta?.content_hash ?? '');
  hash.update('|');
  hash.update(source.title ?? '');
  hash.update('|');
  hash.update(source.remark ?? '');
  hash.update('|');
  hash.update(preview);
  return `${PROFILE_VERSION}:${hash.digest('hex')}`;
}

function buildPreview(source: SourceRecord): { preview: string; hash: string; chunkCount: number; meta: MetaRow | null } {
  const meta = sourceMeta(source.id);
  const summaryTree = formatDocumentSummaryTreeForAgent(source.id, {
    maxOutline: 24,
    maxConcepts: 16,
    maxPractice: 12,
    maxHints: 12,
  });
  const chunks = getSourceChunks(source.id, 8);
  const chunkText = chunks
    .map((chunk, index) => `[片段 ${index + 1}] ${chunk.locator ?? ''}\n${chunk.text}`)
    .join('\n\n');
  const preview = [
    `资料名称：${source.title}`,
    source.remark ? `用户备注：${source.remark}` : null,
    source.url ? `URL：${source.url}` : source.filePath ? `文件：${source.filePath}` : null,
    `来源类型：${source.kind} / ${source.origin}`,
    source.mediaType ? `媒体类型：${source.mediaType}` : null,
    summaryTree ? `\n[文档结构摘要]\n${summaryTree}` : null,
    chunkText ? `\n[代表性片段]\n${chunkText}` : null,
  ].filter(Boolean).join('\n');
  return {
    preview: preview.slice(0, MAX_PREVIEW_CHARS),
    hash: previewHash(source, preview.slice(0, MAX_PREVIEW_CHARS), meta),
    chunkCount: chunks.length,
    meta,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  const json = first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('LLM 返回不是 JSON 对象。');
  return parsed as Record<string, unknown>;
}

async function callProfileModel(input: { source: SourceRecord; preview: string; provider: LLMProvider; model: string }): Promise<{
  summary: string;
  concepts: string[];
  suitableFor: string[];
  difficulty: string | null;
  contentTypes: string[];
  qualityNotes: string | null;
  nodeHints: string[];
}> {
  let raw = '';
  let streamError: Error | null = null;
  const messages: LLMMessage[] = [{
    role: 'user',
    content:
      `请为这份学习参考资料生成“内部 AI 语义档案”。这不是用户备注，不要替用户表达意图，只分析资料内容。\n` +
      `只输出合法 JSON 对象，不要 Markdown。\n\n` +
      `字段：\n` +
      `summary: 80字以内中文摘要\n` +
      `concepts: 3-12个资料实际覆盖的知识点/主题，自由短词\n` +
      `suitable_for: 从 ["route_planning","theory_material","practice_generation","project_case","official_reference","background_reading","troubleshooting","assessment"] 中选择0-5项\n` +
      `difficulty: "beginner" | "intermediate" | "advanced" | "mixed" | null\n` +
      `content_types: 从 ["concept_explanation","examples","exercises","solutions","code","formulas","tables","figures","syllabus","case_study","reference"] 中选择0-6项\n` +
      `quality_notes: 80字以内，说明资料质量、局限或适用注意点\n` +
      `node_hints: 0-10个可能匹配路线图/节点的知识点短词\n\n` +
      `资料预览：\n${input.preview}`,
  }];
  await LLMAdapter.stream({
    provider: input.provider,
    model: input.model,
    systemPrompt: '你是学习资料分析器，负责把资料预处理成内部语义档案。只输出 JSON。',
    messages,
    maxTokens: 1200,
    temperature: 0,
    jsonMode: true,
    usageContext: {
      sessionId: input.source.sessionId,
      courseId: input.source.courseId,
      source: 'source_semantic_profile',
    },
    onChunk: (chunk) => { raw += chunk; },
    onComplete: () => {},
    onError: (error) => { streamError = error; },
  });
  if (streamError) throw streamError;
  const obj = parseJsonObject(raw);
  return {
    summary: typeof obj.summary === 'string' ? compact(obj.summary, 160) : '',
    concepts: normalizeStringArray(obj.concepts),
    suitableFor: normalizeStringArray(obj.suitable_for),
    difficulty: typeof obj.difficulty === 'string' ? compact(obj.difficulty, 32) : null,
    contentTypes: normalizeStringArray(obj.content_types),
    qualityNotes: typeof obj.quality_notes === 'string' ? compact(obj.quality_notes, 160) : null,
    nodeHints: normalizeStringArray(obj.node_hints),
  };
}

export async function rebuildSourceSemanticProfile(sourceId: string, options?: { force?: boolean }): Promise<SourceSemanticProfile | null> {
  const source = getSourceById(sourceId);
  if (!source) return null;
  if (source.origin === 'chat_attachment' || source.origin === 'ai_generated') {
    return writeProfile({
      source,
      status: 'skipped',
      error: '对话附件或 AI 生成资料暂不自动生成语义档案。',
    });
  }

  const { preview, hash, chunkCount, meta } = buildPreview(source);
  const existing = readProfile(sourceId);
  if (!options?.force && existing?.status === 'ready') {
    const row = getDb()
      .prepare<[string], { content_hash: string | null }>('SELECT content_hash FROM source_semantic_profiles WHERE source_id = ?')
      .get(sourceId);
    if (row?.content_hash === hash) return existing;
  }

  if (meta?.processing_state === 'pending' || meta?.processing_state === 'partial') {
    return writeProfile({ source, status: 'pending', contentHash: hash, error: '资料仍在解析/OCR，稍后可重新分析。' });
  }
  if (!preview.trim() || chunkCount === 0) {
    return writeProfile({ source, status: 'skipped', contentHash: hash, error: '资料暂无可分析正文。' });
  }
  const configured = configuredModel();
  if (!configured) {
    return writeProfile({ source, status: 'skipped', contentHash: hash, error: '未配置默认模型，无法生成 AI 语义档案。' });
  }

  writeProfile({ source, status: 'pending', contentHash: hash, model: `${configured.provider}/${configured.model}` });
  try {
    const profile = await callProfileModel({
      source,
      preview,
      provider: configured.provider,
      model: configured.model,
    });
    return writeProfile({
      source,
      status: 'ready',
      ...profile,
      model: `${configured.provider}/${configured.model}`,
      contentHash: hash,
      error: null,
    });
  } catch (error) {
    return writeProfile({
      source,
      status: 'failed',
      model: `${configured.provider}/${configured.model}`,
      contentHash: hash,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function scheduleSourceSemanticProfile(sourceId: string, options?: { force?: boolean; delayMs?: number }): void {
  if (running.has(sourceId)) return;
  running.add(sourceId);
  setTimeout(() => {
    void rebuildSourceSemanticProfile(sourceId, options)
      .catch(() => {})
      .finally(() => running.delete(sourceId));
  }, options?.delayMs ?? 150);
}
