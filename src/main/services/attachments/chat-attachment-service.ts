import { randomUUID } from 'crypto';
import { attachmentMimeType } from '@shared/attachment-formats';
import type {
  AgentType,
  ChatAttachmentPrepareRequest,
  ChatAttachmentStatusRequest,
  FileAttachment,
  SourceRecord,
  SourceScope,
  SourceUsage,
} from '@shared/types';
import { listDocumentJobs } from '../documents/document-jobs';
import { ingestUploadSource } from '../documents/document-ingest';
import { deleteSource, getSourceById } from '../source/source-library';

function scopeForChatAttachment(agentType: AgentType, nodeId?: string): SourceScope {
  if (agentType === 'main_tutor') return 'main_private';
  return nodeId ? 'node_private' : 'main_private';
}

function usageForScope(scope: SourceScope): SourceUsage {
  if (scope === 'main_private') return 'planning_only';
  return 'node_local';
}

function decodePreparedBuffer(input: ChatAttachmentPrepareRequest): Buffer | undefined {
  if (input.filePath) return undefined;
  if (input.base64) return Buffer.from(input.base64, 'base64');
  if (input.content !== undefined) return Buffer.from(input.content, 'utf8');
  return undefined;
}

function latestOcrJob(sourceId: string) {
  return [
    ...listDocumentJobs({ sourceId, state: 'running', limit: 5 }),
    ...listDocumentJobs({ sourceId, state: 'pending', limit: 5 }),
  ].find((job) => job.jobType === 'ocr');
}

function readableContentCount(source: SourceRecord): number {
  return (source.documentBlockCount ?? 0)
    + (source.documentTextUnitCount ?? 0)
    + (source.chunkCount ?? 0);
}

function attachmentFromSource(input: {
  attachmentId: string;
  source: SourceRecord;
  fallbackName?: string;
  fallbackMimeType?: string;
  fallbackSize?: number;
}): FileAttachment {
  const source = input.source;
  const job = latestOcrJob(source.id);
  const pendingOcr = source.documentOcrPendingCount ?? 0;
  const failed = source.processingState === 'failed'
    || Boolean(source.processingError?.includes('OCR 未识别到可用文本'));

  if (job) {
    return {
      id: input.attachmentId,
      name: source.title || input.fallbackName || '附件',
      mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
      size: input.fallbackSize ?? 0,
      sourceId: source.id,
      status: 'ocr',
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal || pendingOcr || undefined,
      message: `OCR中 ${job.progressCurrent}/${job.progressTotal || pendingOcr || '?'} 页`,
      processingError: source.processingError ?? null,
    };
  }

  if (failed) {
    return {
      id: input.attachmentId,
      name: source.title || input.fallbackName || '附件',
      mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
      size: input.fallbackSize ?? 0,
      sourceId: source.id,
      status: 'failed',
      message: source.processingError || '解析失败。',
      processingError: source.processingError ?? null,
    };
  }

  if (source.processingState === 'pending') {
    return {
      id: input.attachmentId,
      name: source.title || input.fallbackName || '附件',
      mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
      size: input.fallbackSize ?? 0,
      sourceId: source.id,
      status: pendingOcr > 0 ? 'ocr' : 'processing',
      progressCurrent: 0,
      progressTotal: pendingOcr || undefined,
      message: pendingOcr > 0 ? `等待 OCR ${pendingOcr} 页` : '正在解析附件',
      processingError: source.processingError ?? null,
    };
  }

  if (source.processingState === 'partial' || pendingOcr > 0) {
    return {
      id: input.attachmentId,
      name: source.title || input.fallbackName || '附件',
      mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
      size: input.fallbackSize ?? 0,
      sourceId: source.id,
      status: 'partial',
      progressCurrent: Math.max(0, (source.documentUnitCount ?? 0) - pendingOcr),
      progressTotal: source.documentUnitCount || undefined,
      message: `已解析部分内容，剩余 ${pendingOcr} 页待 OCR`,
      processingError: source.processingError ?? null,
    };
  }

  if (readableContentCount(source) === 0) {
    return {
      id: input.attachmentId,
      name: source.title || input.fallbackName || '附件',
      mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
      size: input.fallbackSize ?? 0,
      sourceId: source.id,
      status: 'failed',
      message: source.processingError ?? '未提取到可用正文。',
      processingError: source.processingError ?? '未提取到可用正文。',
    };
  }

  return {
    id: input.attachmentId,
    name: source.title || input.fallbackName || '附件',
    mimeType: source.mediaType || input.fallbackMimeType || attachmentMimeType(source.title),
    size: input.fallbackSize ?? 0,
    sourceId: source.id,
    status: 'ready',
    progressCurrent: source.documentUnitCount || source.chunkCount || undefined,
    progressTotal: source.documentUnitCount || source.chunkCount || undefined,
    message: '解析完成',
    processingError: source.processingError ?? null,
  };
}

function sourceStatus(input: {
  attachmentId: string;
  sourceId: string;
  fallbackName?: string;
  fallbackMimeType?: string;
  fallbackSize?: number;
}): FileAttachment {
  const source = getSourceById(input.sourceId);
  if (!source) {
    return {
      id: input.attachmentId,
      name: input.fallbackName || '附件',
      mimeType: input.fallbackMimeType || 'application/octet-stream',
      size: input.fallbackSize ?? 0,
      sourceId: input.sourceId,
      status: 'failed',
      message: '附件资料已不存在。',
      processingError: '附件资料已不存在。',
    };
  }
  return attachmentFromSource({ ...input, source });
}

export async function prepareChatAttachment(input: ChatAttachmentPrepareRequest): Promise<FileAttachment> {
  const mimeType = attachmentMimeType(input.name, input.mimeType);
  const sourceId = randomUUID();
  const scope = scopeForChatAttachment(input.agentType, input.nodeId);
  const usage = usageForScope(scope);
  const buffer = decodePreparedBuffer(input);
  if (!input.filePath && !buffer) throw new Error('附件内容为空，无法解析。');

  const record = await ingestUploadSource({
    id: sourceId,
    courseId: input.courseId,
    nodeId: input.nodeId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    scope,
    usage,
    origin: 'chat_attachment',
    title: input.name,
    remark: '对话附件',
    originalPath: input.originalPath ?? input.filePath ?? null,
    filePath: input.filePath,
    buffer,
    mimeType,
  });

  return sourceStatus({
    attachmentId: input.attachmentId,
    sourceId: record.id,
    fallbackName: input.name,
    fallbackMimeType: mimeType,
    fallbackSize: input.size,
  });
}

export function getPreparedChatAttachmentStatus(input: ChatAttachmentStatusRequest): FileAttachment {
  return sourceStatus({
    attachmentId: input.attachmentId,
    sourceId: input.sourceId,
  });
}

export function removePreparedChatAttachment(input: ChatAttachmentStatusRequest): void {
  void input.attachmentId;
  deleteSource(input.sourceId);
}
