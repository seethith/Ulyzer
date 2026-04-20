// Token counting utility.
// Uses tiktoken for accurate counts when available, falls back to char/4 heuristic.

import type { LLMProvider } from '@shared/types';

// CNY cost per 1k tokens — mirrors the provider files
const COST_TABLE: Record<string, { input: number; output: number }> = {
  'anthropic:claude-sonnet-4-5-20251001': { input: 0.021,  output: 0.105 },
  'anthropic:claude-opus-4-5-20251001':   { input: 0.105,  output: 0.525 },
  'anthropic:claude-haiku-4-5-20251001':  { input: 0.0055, output: 0.0275 },
  'openai:gpt-4o':                        { input: 0.036,  output: 0.108 },
  'openai:gpt-4o-mini':                   { input: 0.0108, output: 0.0432 },
  'deepseek:deepseek-chat':               { input: 0.001,  output: 0.002 },
  'deepseek:deepseek-reasoner':           { input: 0.004,  output: 0.016 },
};

type Encoding = { encode(text: string): Uint32Array; free(): void };
let enc: Encoding | null = null;

function getEncoding(): Encoding | null {
  if (enc) return enc;
  try {
    const { encoding_for_model } = require('tiktoken') as {
      encoding_for_model: (model: string) => Encoding;
    };
    enc = encoding_for_model('gpt-4');
    return enc;
  } catch {
    return null;
  }
}

export function countTokens(text: string): number {
  const encoding = getEncoding();
  if (encoding) {
    return encoding.encode(text).length;
  }
  // Fallback: ~4 chars per token (reasonable for mixed Chinese/English)
  return Math.ceil(text.length / 4);
}

export function estimateCost(
  provider: LLMProvider,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const key = `${provider}:${model}`;
  const price = COST_TABLE[key];
  if (!price) return 0;
  return (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
}
