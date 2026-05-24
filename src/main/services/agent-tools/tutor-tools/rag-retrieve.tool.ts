import { z } from 'zod';
import { buildTool } from './index';
import { hybridRetrieve } from '../../retrieval/hybrid-retriever';
import type { RagChunk } from '@shared/types';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';

export const ragRetrieveTool = buildTool<{ query: string; limit: number }, RagChunk[]>({
  name: 'rag_retrieve',
  description: toolDescription('rag_retrieve') +
    ' 注意：本工具只检索已经索引的节点历史资料/已生成产物，用于避免重复；它不是本轮预检索参考来源包。本轮事实来源以上下文中的权威参考来源为准。',
  inputSchema: z.object({
    query: z.string().describe(toolPropertyDescription('rag_retrieve', 'query')),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: toolPropertyDescription('rag_retrieve', 'query') },
      limit: { type: 'number', description: toolPropertyDescription('rag_retrieve', 'limit') },
    },
    required: ['query'],
  },
  maxResultChars: 4000,
  execute: async ({ query, limit }, { courseId, nodeId, signal }) => {
    const result = await hybridRetrieve({
      courseId,
      nodeId,
      agentType: 'sub_tutor',
      query,
      taskType: 'chat',
      limit,
      sourceKinds: ['generated'],
      signal,
    });
    return result.candidates.map((candidate, index) => {
      const source = result.sources.find((item) => item.id === candidate.sourceId);
      return {
        id: candidate.chunkId,
        fileId: candidate.sourceId,
        nodeId,
        chunkIndex: index,
        sourceName: source?.title ?? source?.filePath ?? '',
        content: candidate.text,
      } satisfies RagChunk;
    });
  },
  formatResult: (chunks) => {
    if (chunks.length === 0) return '（暂无已索引的历史资料；这不代表本轮没有参考来源，请优先使用上下文中的权威参考来源包。）';
    return chunks
      .map((c, i) => `[已有资料 ${i + 1}${c.sourceName ? `：${c.sourceName}` : ''}]\n${c.content}`)
      .join('\n\n---\n\n');
  },
});
