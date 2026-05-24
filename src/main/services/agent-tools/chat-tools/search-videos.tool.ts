/**
 * search_videos chat tool — searches YouTube for educational videos via
 * the YouTube Data API v3. Returns an empty-result summary when the API
 * key is not configured (non-fatal).
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { youtubeSearch } from '../../web/youtube';
import { message } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';

interface VideoSearchResult {
  success: boolean;
  summary: string;
}

export const searchVideosTool: TutorTool<
  { query: string; keywords?: string[] },
  VideoSearchResult
> = buildTool({
  name: 'search_videos',
  description: toolDescription('search_videos'),
  inputSchema: z.object({
    query:    z.string().describe(toolPropertyDescription('search_videos', 'query')),
    keywords: z.array(z.string()).optional().describe(toolPropertyDescription('search_videos', 'keywords')),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query:    { type: 'string',  description: toolPropertyDescription('search_videos', 'query') },
      keywords: { type: 'array', items: { type: 'string' }, description: toolPropertyDescription('search_videos', 'keywords') },
    },
  },
  maxResultChars: 800,
  isReadOnly: true,
  execute: async (input, ctx): Promise<VideoSearchResult> => {
    try {
      const results = await youtubeSearch(input.query, {
        keywords:   input.keywords,
        maxResults: 5,
        duration:   'medium',
      });
      if (results.length === 0) {
        return {
          success: false,
          summary: message('videoNoResults', ctx.language),
        };
      }
      const lines = results.map(
        (v) => `- [${v.title}](${v.url}) — ${v.channelTitle}`,
      );
      return { success: true, summary: lines.join('\n') };
    } catch (err) {
      return {
        success: false,
        summary: message('videoSearchFailed', ctx.language, { error: err instanceof Error ? err.message : String(err) }),
      };
    }
  },
  formatResult: (r) => r.summary,
});
