import { z } from 'zod';
import { buildTool } from './index';
import { buildDagSearchResults } from '../../web/source-strategy';

interface WebSearchResult {
  results: Array<{ title: string; url: string; content: string }>;
  answer?: string;
}

export const webSearchTool = buildTool<
  { query: string; maxResults: number },
  WebSearchResult
>({
  name: 'web_search',
  description:
    '搜索网络获取最新权威资料。当需要最新官方文档、API 变更、最新版本信息，或权威示例时调用。返回摘要和来源链接。',
  inputSchema: z.object({
    query:      z.string().describe('搜索关键词（可包含中英文）'),
    maxResults: z.number().int().min(1).max(5).default(3),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: '搜索关键词（可包含中英文）' },
      maxResults: { type: 'number', description: '返回结果数量，1-5，默认 3' },
    },
    required: ['query'],
  },
  maxResultChars: 3000,
  execute: async ({ query, maxResults }, ctx) => {
    const max = Math.min(maxResults ?? 3, 5);
    const { answer, results } = await buildDagSearchResults(query, {
      provider: ctx.provider as string,
      model: ctx.model,
      signal: ctx.signal,
      maxResults: max,
    });
    return {
      results: results.map((r) => ({
        title:   r.title,
        url:     r.url,
        content: r.content.slice(0, 600),
      })),
      answer,
    };
  },
  formatResult: ({ results, answer }) => {
    const parts: string[] = [];
    if (answer) parts.push(`[搜索摘要] ${answer}`);
    parts.push(
      ...results.map(
        (r, i) => `[网络资料 ${i + 1}] ${r.title}\n来源：${r.url}\n${r.content}`,
      ),
    );
    return parts.join('\n\n---\n\n');
  },
});
