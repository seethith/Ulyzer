import { getApiKey } from '../../utils/keychain';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
}

/**
 * Search the web via Tavily API.
 * Returns an empty result (not an error) when the API key is not configured,
 * so callers can degrade gracefully.
 */
export async function tavilySearch(
  query: string,
  options?: {
    searchDepth?: 'basic' | 'advanced';
    includeDomains?: string[];
    excludeDomains?: string[];
    maxResults?: number;
  }
): Promise<TavilyResponse> {
  const apiKey = await getApiKey('tavily');
  if (!apiKey) return { results: [] };

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: options?.searchDepth ?? 'basic',
      include_domains: options?.includeDomains,
      exclude_domains: options?.excludeDomains,
      max_results: options?.maxResults ?? 5,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<TavilyResponse>;
}
