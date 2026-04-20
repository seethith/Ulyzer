import { getApiKey } from '../../utils/keychain';

export interface ExaResult {
  title: string;
  url: string;
  text: string;
  score: number;
  publishedDate?: string;
}

export interface ExaResponse {
  results: ExaResult[];
}

/**
 * Semantic neural search via Exa API.
 * Returns empty result (not an error) when the API key is not configured,
 * so callers can degrade gracefully.
 *
 * Exa excels at finding authoritative docs, academic papers, GitHub repos,
 * and high-quality educational content via semantic understanding.
 */
export async function exaSearch(
  query: string,
  options?: {
    numResults?: number;
    type?: 'neural' | 'keyword';
    includeDomains?: string[];
    excludeDomains?: string[];
    category?: string;
    useAutoprompt?: boolean;
  }
): Promise<ExaResponse> {
  const apiKey = await getApiKey('exa');
  if (!apiKey) return { results: [] };

  const body: Record<string, unknown> = {
    query,
    numResults: options?.numResults ?? 5,
    type: options?.type ?? 'neural',
    useAutoprompt: options?.useAutoprompt ?? true,
    contents: { text: { maxCharacters: 600 } },
  };
  if (options?.includeDomains?.length) body['includeDomains'] = options.includeDomains;
  if (options?.excludeDomains?.length) body['excludeDomains'] = options.excludeDomains;
  if (options?.category) body['category'] = options.category;

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Exa search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    results: Array<{
      title?: string;
      url?: string;
      text?: string;
      score?: number;
      publishedDate?: string;
    }>;
  };

  return {
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      text: r.text ?? '',
      score: r.score ?? 0.5,
      publishedDate: r.publishedDate,
    })),
  };
}
