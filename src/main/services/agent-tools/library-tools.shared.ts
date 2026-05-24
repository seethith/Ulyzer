import type { AgentType, SourceRecord, TokenUsage } from '@shared/types';
import { hybridRetrieve } from '../retrieval/hybrid-retriever';
import { findSourceById, getSourceChunks } from '../source/source-library';
import { classifyTrustLevel } from '../web/source-authority';
import { formatStructuredDocumentForAgent, structuredDocumentHint, type DocumentReadOptions } from '../documents/document-reader';
import { formatSourceSemanticProfileForAgent } from '../source/source-semantic-format';
import { formatSourceLearningMetadataForAgent } from '../learning-search/learning-source-metadata';

function sourceLine(index: number, input: SourceRecord): string {
  const trust = classifyTrustLevel({
    kind: input.kind as 'web' | 'upload' | 'generated',
    host: input.host,
    url: input.url,
    trustScore: input.trustScore,
  });
  return [
    `[参考资料 ${index + 1}] ${input.title}`,
    `source_id：${input.id}`,
    input.remark ? `备注：${input.remark}` : null,
    `来源：${input.url ?? input.filePath ?? input.kind}`,
    input.origin ? `资料层级：${sourceOriginLabel(input.origin)}` : null,
    `可信度：${trust} · ${input.trustScore.toFixed(2)}`,
    formatSourceLearningMetadataForAgent(input.id),
    formatSourceSemanticProfileForAgent(input, { maxItems: 5 }),
    structuredDocumentHint(input.id),
  ].filter(Boolean).join('\n');
}

function sourceOriginLabel(origin: string): string {
  switch (origin) {
    case 'chat_attachment': return '对话附件';
    case 'web_collected': return '自动搜集网页';
    case 'ai_generated': return 'AI生成资料';
    case 'user_import':
    default: return '用户导入资料';
  }
}

export async function searchLibraryForAgent(input: {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  query: string;
  limit?: number;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  llmRerank?: boolean;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<string> {
  const result = await hybridRetrieve({
    courseId: input.courseId,
    nodeId: input.nodeId,
    agentType: input.agentType,
    query: input.query,
    taskType: 'chat',
    limit: Math.min(input.limit ?? 5, 8),
    llmRerank: input.llmRerank,
    rerankProvider: input.provider,
    rerankModel: input.model,
    signal: input.signal,
    onUsage: input.onUsage,
  });

  if (result.sources.length === 0 || result.candidates.length === 0) {
    return '未找到相关参考资料。可尝试换一个更具体的关键词，或请用户补充参考资料。';
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  result.candidates.forEach((chunk, index) => {
    const source = result.sources.find((item) => item.id === chunk.sourceId);
    if (!source) return;
    if (!seen.has(source.id)) {
      lines.push(sourceLine(seen.size, source));
      seen.add(source.id);
    }
    lines.push(
      `[片段 ${index + 1}] ${chunk.locator ?? '摘录'}\n${chunk.text.slice(0, 700)}`,
    );
  });

  return lines.join('\n\n---\n\n');
}

export async function readSourceForAgent(input: {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  sourceId: string;
  maxChunks?: number;
  page?: number;
  pageStart?: number;
  pageEnd?: number;
  unitIndex?: number;
  maxBlocks?: number;
}): Promise<string> {
  const source = findSourceById(input.courseId, input.sourceId, {
    nodeId: input.nodeId,
    agentType: input.agentType,
  });
  if (!source) {
    return `未找到 source_id=${input.sourceId} 对应的参考资料，或当前助手无权访问。`;
  }

  const structured = formatStructuredDocumentForAgent(source, {
    page: input.page,
    pageStart: input.pageStart,
    pageEnd: input.pageEnd,
    unitIndex: input.unitIndex,
    maxBlocks: input.maxBlocks ?? (input.maxChunks ? input.maxChunks * 6 : undefined),
    maxUnits: input.maxChunks ? input.maxChunks * 8 : undefined,
  } satisfies DocumentReadOptions);
  if (structured) return structured;

  const chunks = getSourceChunks(source.id, Math.min(input.maxChunks ?? 5, 8));
  if (chunks.length === 0) {
    return [
      `参考资料：${source.title}`,
      `source_id：${source.id}`,
      `来源：${source.url ?? source.filePath ?? source.kind}`,
      formatSourceSemanticProfileForAgent(source, { maxItems: 6 }),
      '当前参考资料已存在，但还没有可读片段。',
    ].join('\n');
  }

  const lines = [
    `参考资料：${source.title}`,
    `source_id：${source.id}`,
    source.remark ? `备注：${source.remark}` : null,
    `来源：${source.url ?? source.filePath ?? source.kind}`,
    formatSourceLearningMetadataForAgent(source.id),
    formatSourceSemanticProfileForAgent(source, { maxItems: 6 }),
  ].filter(Boolean) as string[];

  for (const [index, chunk] of chunks.entries()) {
    lines.push(`\n[片段 ${index + 1}] ${chunk.locator ?? '摘录'}\n${chunk.text}`);
  }

  return lines.join('\n');
}
