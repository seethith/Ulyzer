import { z } from 'zod';
import { buildTool } from './index';
import { collectEvidencePack, formatEvidencePack, summarizeEvidencePack } from '../../web/research-pipeline';
import { blockWebMessage } from '../search-mode-guard';

interface WebSearchResult {
  found: boolean;
  summary: string;
}

export const webSearchTool = buildTool<
  { query: string; maxResults: number },
  WebSearchResult
>({
  name: 'web_search',
  description:
    '搜索网络获取最新权威资料。当需要最新官方文档、API 变更、最新版本信息，或权威示例时调用。返回按学习资料槽位组织的资料包，包含来源、质量判断、用途概览、证据片段和检索缺口。',
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
  maxResultChars: 6000,
  execute: async ({ query, maxResults }, ctx) => {
    const blocked = blockWebMessage(ctx.searchMode, ctx.language);
    if (blocked) return { found: false, summary: blocked };
    const max = Math.min(maxResults ?? 3, 5);
    const pack = await collectEvidencePack({
      query,
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      mode: 'web',
      maxWebResults: max,
      provider: ctx.provider as string,
      model: ctx.model,
      language: ctx.language,
      signal: ctx.signal,
      onProgress: (message) => ctx.onProgress?.(message),
      onUsage: (usage) => ctx.runContext?.addUsage(usage),
    });
    ctx.onProgress?.(summarizeEvidencePack(pack, ctx.language));
    return {
      found: pack.sources.length > 0 || pack.chunks.length > 0,
      summary: formatEvidencePack(pack, ctx.language),
    };
  },
  formatResult: ({ summary }) => summary,
});
