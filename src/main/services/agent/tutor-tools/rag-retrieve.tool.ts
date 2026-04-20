import { z } from 'zod';
import { buildTool } from './index';
import { retrieveChunks } from '../../rag/retriever';
import type { RagChunk } from '@shared/types';

export const ragRetrieveTool = buildTool<{ query: string; limit: number }, RagChunk[]>({
  name: 'rag_retrieve',
  description:
    '检索当前节点已有的参考资料片段。生成内容前必须先调用此工具，了解现有内容以避免重复。返回相关资料片段列表。',
  inputSchema: z.object({
    query: z.string().describe('检索关键词，通常是概念名称或问题关键词'),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词，通常是概念名称或问题关键词' },
      limit: { type: 'number', description: '返回条数，1-10，默认 5' },
    },
    required: ['query'],
  },
  maxResultChars: 4000,
  execute: async ({ query, limit }, { nodeId }) => {
    return retrieveChunks(nodeId, query, limit);
  },
  formatResult: (chunks) => {
    if (chunks.length === 0) return '（暂无已索引的参考资料，可直接生成）';
    return chunks
      .map((c, i) => `[已有资料 ${i + 1}${c.sourceName ? `：${c.sourceName}` : ''}]\n${c.content}`)
      .join('\n\n---\n\n');
  },
});
