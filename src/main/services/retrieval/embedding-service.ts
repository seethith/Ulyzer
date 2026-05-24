import { getApiKey } from '../../utils/keychain';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
}

export class EmbeddingUnavailableError extends Error {
  constructor(message = 'Embedding provider unavailable') {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

export function getEmbeddingModelInfo(): EmbeddingModelInfo {
  return {
    provider: 'openai',
    model: process.env.ULYZER_EMBEDDING_MODEL || DEFAULT_MODEL,
    dimensions: Number(process.env.ULYZER_EMBEDDING_DIMENSIONS || DEFAULT_DIMENSIONS),
  };
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = await getApiKey('openai');
  if (!apiKey) throw new EmbeddingUnavailableError('OpenAI API key is not configured; semantic index is skipped.');

  const info = getEmbeddingModelInfo();
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: info.model,
      input: texts.map((text) => text.slice(0, 8000)),
    }),
  });

  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = data.data ?? [];
  return rows
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => row.embedding ?? []);
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text]);
  return embedding ?? [];
}
