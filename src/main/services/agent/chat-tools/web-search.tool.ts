/**
 * web_search chat tool — lets the sub-tutor AI search the web during conversation.
 * Triggered for: error messages, latest API versions, official docs, current-year info.
 * Reuses the same tavilySearch + filterByQuality pipeline as the main-tutor and dag-tools.
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { buildDagSearchResults } from '../../web/source-strategy';

interface WebSearchResult { found: boolean; summary: string }

export const webSearchChatTool: TutorTool<{ query: string; maxResults?: number }, WebSearchResult> = buildTool({
  name: 'web_search',
  description:
    '【做什么】搜索网络获取最新参考资料，返回相关网页摘要和来源链接。' +
    '【何时调用】用户遇到报错信息（粘贴了错误日志）、询问某库/框架的最新版本或 API 变更、需要查官方文档、或问题涉及当年发布的新技术时。' +
    '【限制】不适合解释基础概念（直接回答更快）；不适合查询已在节点资料中存在的内容（用 search_knowledge 更好）；每次只搜一个聚焦查询。',
  inputSchema: z.object({
    query:      z.string().min(1),
    maxResults: z.number().int().min(1).max(5).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query:      { type: 'string', description: '搜索关键词（中英文均可，尽量精确）' },
      maxResults: { type: 'number', description: '返回结果数量，1-5，默认 3' },
    },
  },
  maxResultChars: 3000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<WebSearchResult> => {
    const max = Math.min(input.maxResults ?? 3, 5);
    ctx.onProgress?.(`🔍 搜索：${input.query}\n`);
    try {
      const { answer, results } = await buildDagSearchResults(input.query, {
        provider: ctx.provider as string,
        model: ctx.model,
        signal: ctx.signal,
        maxResults: max,
      });
      if (results.length === 0 && !answer) {
        return { found: false, summary: '未找到相关结果，请尝试换一个查询词。' };
      }
      const parts: string[] = [];
      if (answer) parts.push(`[搜索摘要] ${answer}`);
      parts.push(
        ...results.map((r, i) =>
          `[网络资料 ${i + 1}] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 600)}`,
        ),
      );
      return { found: true, summary: parts.join('\n\n') };
    } catch (err) {
      return { found: false, summary: `搜索失败：${String(err)}` };
    }
  },
  formatResult: (r) => r.summary,
});
