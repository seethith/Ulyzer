import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';
import type { ResearchTaskType } from '@shared/types';
import { tavilySearch } from '../services/web/tavily';
import type { TavilyResult } from '../services/web/tavily';
import { exaSearch } from '../services/web/exa';
import { youtubeSearch } from '../services/web/youtube';
import { filterByQuality } from '../services/web/quality-filter';
import type { FilteredResult } from '../services/web/quality-filter';
import type { YouTubeResult } from '../services/web/youtube';
import { dedupeAndRankSources } from '../services/web/source-dedupe';
import {
  assessSourceRisk,
  classifySourceTier,
  lowQualityDomainsFor,
  normalizeUrl,
  type SourceRiskLevel,
  type SourceTier,
} from '../services/web/source-authority';

const LOW_QUALITY_IPC = ['answers.com', 'ehow.com', 'blurtit.com', 'weknowtheanswer.com', 'ask.com'];

interface WebSearchOptions {
  searchDepth?: 'basic' | 'advanced';
  maxResults?: number;
  learningSource?: boolean;
  taskType?: ResearchTaskType;
}

interface LearningSourceSearchResult extends FilteredResult {
  sourceTier: SourceTier;
  riskLevel: SourceRiskLevel;
  riskReasons: string[];
  trustLevel: string;
  provider?: 'tavily' | 'exa' | 'library' | 'reflection';
  normalizedUrl: string;
  recommended: boolean;
}

function inferTaskType(query: string, explicit?: ResearchTaskType): ResearchTaskType {
  if (explicit) return explicit;
  if (/路线|课程|大纲|教学大纲|学习路径|roadmap|syllabus|curriculum|outline/i.test(query)) return 'roadmap';
  if (/练习|题目|习题|实践|作业|评分|rubric|practice|exercise|problem|assignment/i.test(query)) return 'practice';
  if (/答案|解析|answer|solution/i.test(query)) return 'answer';
  if (/最新|版本|api|release|current|latest/i.test(query)) return 'freshness';
  return 'theory';
}

async function learningSourceSearch(
  query: string,
  options: WebSearchOptions = {},
): Promise<LearningSourceSearchResult[]> {
  const maxResults = Math.min(options.maxResults ?? 8, 10);
  const taskType = inferTaskType(query, options.taskType);
  const excludeDomains = lowQualityDomainsFor(query);
  const searchDepth = options.searchDepth ?? 'basic';
  const [primary, focused, exa] = await Promise.allSettled([
    tavilySearch(query, { searchDepth, excludeDomains, maxResults }),
    tavilySearch(`${query} open textbook lecture notes worked examples`, {
      searchDepth,
      excludeDomains,
      maxResults,
    }),
    exaSearch(`${query} authoritative learning resource lecture notes examples`, {
      numResults: maxResults,
      useAutoprompt: true,
    }),
  ]);

  const candidates: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    provider: 'tavily' | 'exa';
    publishedDate?: string;
  }> = [];
  for (const settled of [primary, focused]) {
    if (settled.status !== 'fulfilled') continue;
    for (const result of settled.value.results) {
      candidates.push({
        title: result.title,
        url: result.url,
        content: result.content,
        score: result.score,
        provider: 'tavily',
        publishedDate: result.publishedDate,
      });
    }
  }
  if (exa.status === 'fulfilled') {
    for (const result of exa.value.results) {
      candidates.push({
        title: result.title,
        url: result.url,
        content: result.text.slice(0, 900),
        score: result.score,
        provider: 'exa',
      });
    }
  }

  return dedupeAndRankSources(candidates, { query, taskType, maxResults: maxResults + 4 })
    .map((candidate) => {
      const risk = assessSourceRisk({
        title: candidate.title,
        url: candidate.url,
        content: candidate.content,
        trustScore: candidate.trustScore,
      });
      const sourceTier = classifySourceTier({
        url: candidate.url,
        trustScore: candidate.trustScore,
      });
      return {
        title: candidate.title,
        url: normalizeUrl(candidate.url),
        content: candidate.content,
        trustScore: candidate.trustScore,
        publishedDate: candidate.publishedDate,
        sourceTier,
        riskLevel: risk.level,
        riskReasons: risk.reasons,
        trustLevel: candidate.trustLevel,
        provider: candidate.provider,
        normalizedUrl: candidate.normalizedUrl,
        recommended: risk.level === 'low' && candidate.trustScore >= 0.5,
      } satisfies LearningSourceSearchResult;
    })
    .filter((result) => result.riskLevel !== 'blocked' && result.riskLevel !== 'high')
    .slice(0, maxResults);
}

export function registerWebHandlers(): void {
  /**
   * Renderer → invoke → filtered web search results.
   * Returns empty array instead of error when API key is not configured.
   */
  ipcMain.handle(
    IPC.WEB_SEARCH,
    async (
      _e,
      query: string,
      options?: WebSearchOptions
    ): Promise<IpcResponse<FilteredResult[]>> => {
      try {
        if (options?.learningSource) {
          return { success: true, data: await learningSourceSearch(query, options) };
        }
        const maxResults = options?.maxResults ?? 5;
        const [res1, res2, exaIpcRes] = await Promise.allSettled([
          tavilySearch(query, options),
          tavilySearch(`${query} guide tutorial overview`, {
            searchDepth: options?.searchDepth ?? 'basic',
            excludeDomains: LOW_QUALITY_IPC,
            maxResults,
          }),
          exaSearch(query, { numResults: maxResults }),
        ]);
        const byUrl = new Map<string, TavilyResult>();
        for (const settled of [res1, res2]) {
          if (settled.status !== 'fulfilled') continue;
          for (const r of settled.value.results) {
            const existing = byUrl.get(r.url);
            if (!existing || r.score > existing.score) byUrl.set(r.url, r);
          }
        }
        if (exaIpcRes.status === 'fulfilled') {
          for (const r of exaIpcRes.value.results) {
            const existing = byUrl.get(r.url);
            if (!existing || r.score > existing.score) {
              byUrl.set(r.url, { title: r.title, url: r.url, content: r.text.slice(0, 600), score: r.score });
            }
          }
        }
        const filtered = filterByQuality([...byUrl.values()]);
        return { success: true, data: filtered };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  /**
   * Renderer → invoke → YouTube video search results.
   * Returns empty array when API key is not configured.
   */
  ipcMain.handle(
    IPC.WEB_SEARCH_VIDEO,
    async (
      _e,
      query: string,
      options?: { maxResults?: number; keywords?: string[] }
    ): Promise<IpcResponse<YouTubeResult[]>> => {
      try {
        const results = await youtubeSearch(query, options);
        return { success: true, data: results };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
