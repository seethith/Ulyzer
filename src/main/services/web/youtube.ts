import { getApiKey } from '../../utils/keychain';

export interface YouTubeResult {
  title: string;
  videoId: string;
  url: string;
  channelTitle: string;
  description: string;
}

/**
 * Search YouTube for educational videos via the YouTube Data API v3.
 * Returns an empty array (not an error) when the API key is not configured.
 *
 * Free quota: ~10 000 units/day. Each search request costs 100 units.
 * Targets medium-length videos (4-20 min) which are ideal for tutorials.
 */
export async function youtubeSearch(
  query: string,
  options?: {
    maxResults?: number;
    /** Extra keywords appended to the query, e.g. ['教程', '慢动作'] */
    keywords?: string[];
    /** 'medium' = 4-20 min (default), 'short' = <4 min, 'long' = >20 min */
    duration?: 'short' | 'medium' | 'long';
  }
): Promise<YouTubeResult[]> {
  const apiKey = await getApiKey('youtube');
  if (!apiKey) return [];

  const fullQuery = options?.keywords?.length
    ? `${query} ${options.keywords.join(' ')}`
    : query;

  const params = new URLSearchParams({
    part: 'snippet',
    q: fullQuery,
    type: 'video',
    videoDuration: options?.duration ?? 'medium',
    maxResults: String(options?.maxResults ?? 5),
    relevanceLanguage: 'zh',
    key: apiKey,
  });

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
  );

  if (!res.ok) {
    throw new Error(`YouTube search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    items?: Array<{
      id: { videoId: string };
      snippet: {
        title: string;
        channelTitle: string;
        description: string;
      };
    }>;
  };

  return (data.items ?? []).map((item) => ({
    title: item.snippet.title,
    videoId: item.id.videoId,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    channelTitle: item.snippet.channelTitle,
    description: item.snippet.description.slice(0, 200),
  }));
}
