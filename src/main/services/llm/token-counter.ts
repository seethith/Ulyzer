// Token counting utility.
// Uses tiktoken for accurate counts when available, falls back to char/4 heuristic.

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

