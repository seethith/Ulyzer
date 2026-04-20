/**
 * search_videos chat tool — searches YouTube for educational videos via
 * the YouTube Data API v3. Returns an empty-result summary when the API
 * key is not configured (non-fatal).
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { youtubeSearch } from '../../web/youtube';

interface VideoSearchResult {
  success: boolean;
  summary: string;
}

export const searchVideosTool: TutorTool<
  { query: string; keywords?: string[] },
  VideoSearchResult
> = buildTool({
  name: 'search_videos',
  description:
    '【做什么】通过 YouTube Data API 搜索与知识点相关的教学视频，返回标题 + 链接 + 频道。' +
    '【何时调用】用户说"帮我找视频"/"推荐教学视频"/"有没有视频讲这个"/"视频资源" 等。' +
    '【限制】需要配置 YouTube API Key（设置页面）；无 Key 时返回空结果不报错。',
  inputSchema: z.object({
    query:    z.string().describe('搜索关键词，如节点名称或具体知识点'),
    keywords: z.array(z.string()).optional().describe('附加关键词，如 ["教程","讲解"]'),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query:    { type: 'string',  description: '搜索关键词' },
      keywords: { type: 'array', items: { type: 'string' }, description: '附加关键词（可不填）' },
    },
  },
  maxResultChars: 800,
  isReadOnly: true,
  execute: async (input, _ctx): Promise<VideoSearchResult> => {
    try {
      const results = await youtubeSearch(input.query, {
        keywords:   input.keywords,
        maxResults: 5,
        duration:   'medium',
      });
      if (results.length === 0) {
        return {
          success: false,
          summary: '未找到相关视频，或未配置 YouTube API Key（可在设置页面添加）。',
        };
      }
      const lines = results.map(
        (v) => `- [${v.title}](${v.url}) — ${v.channelTitle}`,
      );
      return { success: true, summary: lines.join('\n') };
    } catch (err) {
      return {
        success: false,
        summary: `视频搜索出错：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  formatResult: (r) => r.summary,
});
