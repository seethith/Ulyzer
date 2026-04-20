import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';
import { tavilySearch } from '../services/web/tavily';
import type { TavilyResult } from '../services/web/tavily';
import { exaSearch } from '../services/web/exa';
import { youtubeSearch } from '../services/web/youtube';
import { filterByQuality } from '../services/web/quality-filter';
import type { FilteredResult } from '../services/web/quality-filter';
import type { YouTubeResult } from '../services/web/youtube';

const LOW_QUALITY_IPC = ['answers.com', 'ehow.com', 'blurtit.com', 'weknowtheanswer.com', 'ask.com'];

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
      options?: { searchDepth?: 'basic' | 'advanced'; maxResults?: number }
    ): Promise<IpcResponse<FilteredResult[]>> => {
      try {
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
