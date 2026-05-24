/**
 * Single source of truth for model pricing.
 * Prices are in CNY per 1k tokens (input / output).
 *
 * Migrated from providers/claude.ts, providers/openai.ts, and token-counter.ts
 * to eliminate duplication.
 */

import type { TokenUsage } from '@shared/types';

export interface ModelPrice {
  input: number;
  output: number;
  /** Cached prompt/input tokens, when the provider exposes a cheaper cache-hit bucket. */
  inputCacheHit?: number;
}

export const DEFAULT_PRICE: ModelPrice = { input: 0.036, output: 0.108 };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic Claude ────────────────────────────────────────────────────
  'claude-sonnet-4-6':          { input: 0.021,  output: 0.105 },
  'claude-opus-4-6':            { input: 0.105,  output: 0.525 },
  'claude-sonnet-4-5-20251001': { input: 0.021,  output: 0.105 },
  'claude-opus-4-5-20251001':   { input: 0.105,  output: 0.525 },
  'claude-haiku-4-5-20251001':  { input: 0.0055, output: 0.0275 },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  'gpt-4o':              { input: 0.036,    output: 0.108 },
  'gpt-4o-mini':         { input: 0.0108,   output: 0.0432 },
  // o-series reasoning models — $15/$60 and $1.1/$4.4 per 1M × 7.2 CNY/USD
  'o1':                  { input: 0.108,    output: 0.432 },
  'o3-mini':             { input: 0.00792,  output: 0.03168 },

  // ── DeepSeek ────────────────────────────────────────────────────────────
  'deepseek-chat':       { input: 0.001,    output: 0.002 },
  'deepseek-reasoner':   { input: 0.004,    output: 0.016 },
  'deepseek-v4-flash':   { input: 0.001,    output: 0.002, inputCacheHit: 0.00002 },
  'deepseek-v4-pro':     { input: 0.003,    output: 0.006, inputCacheHit: 0.000025 },

  // ── Grok (xAI) — $3/$15 and $0.3/$0.5 per 1M × 7.2 ─────────────────────
  'grok-3':              { input: 0.0216,   output: 0.108 },
  'grok-3-mini':         { input: 0.00216,  output: 0.0036 },

  // ── Google Gemini — USD/1M × 7.2 / 1000 ────────────────────────────────
  'gemini-2.5-pro':                    { input: 0.009,    output: 0.072   },  // $1.25/$10
  'gemini-2.5-flash':                  { input: 0.00108,  output: 0.00432 },  // $0.15/$0.60
  'gemini-2.5-flash-preview-04-17':    { input: 0.00108,  output: 0.00432 },
  'gemini-2.0-flash':                  { input: 0.00072,  output: 0.00288 },  // $0.10/$0.40
  'gemini-2.0-flash-lite':             { input: 0.00054,  output: 0.00216 },  // $0.075/$0.30
  'gemini-2.0-flash-thinking-exp':     { input: 0.00072,  output: 0.00288 },
  'gemini-1.5-pro-002':                { input: 0.009,    output: 0.036   },  // $1.25/$5
  'gemini-1.5-flash-002':              { input: 0.00054,  output: 0.00216 },  // $0.075/$0.30
  'gemini-1.5-flash-8b':               { input: 0.00027,  output: 0.00108 },  // $0.0375/$0.15

  // ── MiniMax ─────────────────────────────────────────────────────────────
  'MiniMax-Text-01':     { input: 0.0001,   output: 0.001 },
  'MiniMax-M1':          { input: 0.001,    output: 0.005 },

  // ── Qwen 2.5 (Alibaba) ─────────────────────────────────────────────────
  'qwen-turbo':          { input: 0.0003,   output: 0.0006 },
  'qwen-plus':           { input: 0.0008,   output: 0.002 },
  'qwen-max':            { input: 0.004,    output: 0.012 },

  // ── Qwen 3 (Alibaba, 2025-04 release) ──────────────────────────────────
  'qwen3-235b-a22b':     { input: 0.014,    output: 0.056 },
  'qwen3-32b':           { input: 0.004,    output: 0.012 },
  'qwen3-14b':           { input: 0.002,    output: 0.008 },
  'qwen3-8b':            { input: 0.0006,   output: 0.0024 },

  // ── Mistral AI — USD/1M × 7.2 ──────────────────────────────────────────
  'mistral-large-latest':          { input: 0.0144,   output: 0.0432 },
  'mistral-small-latest':          { input: 0.00144,  output: 0.00432 },
  'codestral-latest':              { input: 0.00216,  output: 0.00648 },

  // ── Groq — USD/1M × 7.2 ────────────────────────────────────────────────
  'llama-3.3-70b-versatile':       { input: 0.00425,  output: 0.00569 },
  'llama-3.1-8b-instant':          { input: 0.00036,  output: 0.000576 },
  'mixtral-8x7b-32768':            { input: 0.001728, output: 0.001728 },

  // ── Moonshot (Kimi) ────────────────────────────────────────────────────
  'moonshot-v1-8k':                { input: 0.012,    output: 0.012 },
  'moonshot-v1-32k':               { input: 0.024,    output: 0.024 },
  'moonshot-v1-128k':              { input: 0.06,     output: 0.06 },

  // ── Zhipu AI ───────────────────────────────────────────────────────────
  'glm-4':                         { input: 0.1,      output: 0.1 },
  'glm-4-flash':                   { input: 0.001,    output: 0.001 },
  'glm-4-air':                     { input: 0.001,    output: 0.001 },

  // ── ByteDance Doubao ───────────────────────────────────────────────────
  'doubao-pro-32k':                { input: 0.0008,   output: 0.002 },
  'doubao-lite-32k':               { input: 0.0003,   output: 0.0006 },

  // ── Perplexity — USD/1M × 7.2 ──────────────────────────────────────────
  'sonar-pro':                     { input: 0.0216,   output: 0.108 },
  'sonar':                         { input: 0.0072,   output: 0.0072 },

  // ── Cohere — USD/1M × 7.2 ──────────────────────────────────────────────
  'command-r-plus':                { input: 0.018,    output: 0.072 },
  'command-r':                     { input: 0.00108,  output: 0.00432 },
};

/**
 * Look up price by model name. Returns DEFAULT_PRICE for unknown models.
 * Performs prefix matching for versioned models (e.g., 'gpt-4o-2024-11-20' → 'gpt-4o').
 */
export function getPrice(model: string): ModelPrice {
  const modelKeys = [model];
  const routedName = model.includes('/') ? model.split('/').pop() : null;
  if (routedName && routedName !== model) modelKeys.push(routedName);
  for (const key of modelKeys) {
    if (MODEL_PRICES[key]) return MODEL_PRICES[key];
  }
  // Prefix fallback: try matching the longest registered model prefix
  const candidates = Object.keys(MODEL_PRICES)
    .filter((m) => modelKeys.some((key) => key.startsWith(m)))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) return MODEL_PRICES[candidates[0]];
  return DEFAULT_PRICE;
}

export function getModelPrice(provider: string, model: string): ModelPrice {
  const staticPrice = getPrice(model);
  try {
    const { getDb } = require('../db/sqlite') as {
      getDb: () => {
        prepare: (sql: string) => {
          get: (...args: unknown[]) => { input_price: number | null; output_price: number | null } | undefined;
        };
      };
    };
    const row = getDb()
      .prepare('SELECT input_price, output_price FROM provider_models WHERE provider_id = ? AND model_id = ?')
      .get(provider, model);
    if (row?.input_price !== null && row?.input_price !== undefined && row?.output_price !== null && row?.output_price !== undefined) {
      return { ...staticPrice, input: row.input_price, output: row.output_price };
    }
  } catch {
    // Database may be unavailable in isolated tests; fall back to static prices.
  }
  return staticPrice;
}

export function calculateUsageCostCny(usage: Partial<TokenUsage>, price: ModelPrice): number {
  const outputTokens = usage.outputTokens ?? 0;
  const cacheHit = usage.inputCacheHitTokens ?? 0;
  const cacheMiss = usage.inputCacheMissTokens ?? 0;

  if (cacheHit > 0 || cacheMiss > 0) {
    const inputCost =
      (cacheMiss / 1000) * price.input +
      (cacheHit / 1000) * (price.inputCacheHit ?? price.input);
    return inputCost + (outputTokens / 1000) * price.output;
  }

  return ((usage.inputTokens ?? 0) / 1000) * price.input + (outputTokens / 1000) * price.output;
}
