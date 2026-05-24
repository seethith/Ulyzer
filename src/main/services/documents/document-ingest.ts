import { randomUUID } from 'crypto';
import {
  attachmentExt,
  attachmentMimeType,
  isAttachmentAudioExt,
  isAttachmentDocxExt,
  isAttachmentEpubExt,
  isAttachmentImageExt,
  isAttachmentMmExt,
  isAttachmentOdpExt,
  isAttachmentOdsExt,
  isAttachmentOdtExt,
  isAttachmentOpmlExt,
  isAttachmentPdfExt,
  isAttachmentPptxExt,
  isAttachmentRtfExt,
  isAttachmentTextExt,
  isAttachmentVideoExt,
  isAttachmentXmindExt,
  isAttachmentXlsxExt,
} from '@shared/attachment-formats';
import type { SourceOrigin, SourceRecord, SourceScope, SourceUsage } from '@shared/types';
import { buildAudioContent, buildImageContent, buildVideoContent } from '../source/media-ingestion';
import { getSourceById, importTextSource } from '../source/source-library';
import { copySourceAsset, writeSourceAsset } from '../source/source-assets';
import { setSourceProcessingError, setSourceProcessingState } from '../source/source-indexer';
import { documentAssetTextCharCount, parseDocumentFile } from './document-parser';
import { pdfOcrPendingMessage, persistDocumentAssetForSource } from './document-processing';

export interface IngestUploadSourceInput {
  id?: string;
  courseId: string;
  nodeId?: string | null;
  threadId?: string | null;
  sessionId?: string | null;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
  title: string;
  remark?: string;
  url?: string | null;
  originalPath?: string | null;
  filePath?: string | null;
  buffer?: Buffer;
  mimeType?: string | null;
}

function isTextLike(name: string, mimeType: string): boolean {
  const ext = attachmentExt(name);
  const mime = mimeType.toLowerCase();
  return mime.startsWith('text/')
    || mime.includes('json')
    || mime.includes('xml')
    || mime.includes('yaml')
    || isAttachmentTextExt(ext);
}

function uploadKind(name: string, mimeType: string): 'document' | 'image' | 'audio' | 'video' | 'text' {
  const ext = attachmentExt(name);
  if (
    isAttachmentPdfExt(ext) ||
    isAttachmentDocxExt(ext) ||
    isAttachmentPptxExt(ext) ||
    isAttachmentXlsxExt(ext) ||
    isAttachmentRtfExt(ext) ||
    isAttachmentEpubExt(ext) ||
    isAttachmentOdtExt(ext) ||
    isAttachmentOdsExt(ext) ||
    isAttachmentOdpExt(ext) ||
    isAttachmentOpmlExt(ext) ||
    isAttachmentMmExt(ext) ||
    isAttachmentXmindExt(ext) ||
    mimeType.includes('pdf') ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('presentationml') ||
    mimeType.includes('spreadsheetml') ||
    mimeType.includes('rtf') ||
    mimeType.includes('epub') ||
    mimeType.includes('opendocument') ||
    mimeType.includes('opml') ||
    mimeType.includes('freemind') ||
    mimeType.includes('xmind')
  ) {
    return 'document';
  }
  if (isAttachmentImageExt(ext) || mimeType.startsWith('image/')) return 'image';
  if (isAttachmentAudioExt(ext) || mimeType.startsWith('audio/')) return 'audio';
  if (isAttachmentVideoExt(ext) || mimeType.startsWith('video/')) return 'video';
  if (isTextLike(name, mimeType)) return 'text';
  return 'text';
}

async function ensureAssetPath(input: IngestUploadSourceInput & { sourceId: string; mimeType: string }): Promise<string> {
  if (input.filePath) {
    return copySourceAsset({
      courseId: input.courseId,
      sourceId: input.sourceId,
      sourcePath: input.filePath,
      fileName: input.title,
      mimeType: input.mimeType,
    });
  }
  if (!input.buffer) throw new Error('附件内容为空，无法导入。');
  return writeSourceAsset({
    courseId: input.courseId,
    sourceId: input.sourceId,
    fileName: input.title,
    mimeType: input.mimeType,
    buffer: input.buffer,
  });
}

function fetchFreshRecord(sourceId: string): SourceRecord {
  const record = getSourceById(sourceId);
  if (!record) throw new Error(`Source not found after ingest: ${sourceId}`);
  return record;
}

export async function ingestUploadSource(input: IngestUploadSourceInput): Promise<SourceRecord> {
  const sourceId = input.id ?? randomUUID();
  const mimeType = attachmentMimeType(input.title, input.mimeType ?? undefined);
  const assetPath = await ensureAssetPath({ ...input, sourceId, mimeType });
  const originalPath = input.originalPath ?? input.filePath ?? null;
  const kind = uploadKind(input.title, mimeType.toLowerCase());

  if (kind === 'audio' || kind === 'video') {
    const processed = kind === 'audio'
      ? await buildAudioContent({ title: input.title, filePath: assetPath, mimeType })
      : await buildVideoContent({ title: input.title, filePath: assetPath, mimeType });
    const record = importTextSource({
      id: sourceId,
      courseId: input.courseId,
      nodeId: input.nodeId ?? undefined,
      threadId: input.threadId ?? undefined,
      sessionId: input.sessionId ?? undefined,
      scope: input.scope,
      usage: input.usage,
      origin: input.origin,
      title: input.title,
      remark: input.remark,
      url: input.url ?? undefined,
      originalPath: originalPath ?? undefined,
      content: processed.content,
      filePath: assetPath,
      mimeType,
      processingState: processed.processingError ? 'failed' : 'ready',
      processingError: processed.processingError ?? null,
    });
    setSourceProcessingError(record.id, processed.processingError ?? null);
    setSourceProcessingState(record.id, processed.processingError ? 'failed' : 'ready');
    return fetchFreshRecord(record.id);
  }

  if (kind === 'image') {
    const processed = await buildImageContent({ title: input.title, filePath: assetPath, mimeType });
    const record = importTextSource({
      id: sourceId,
      courseId: input.courseId,
      nodeId: input.nodeId ?? undefined,
      threadId: input.threadId ?? undefined,
      sessionId: input.sessionId ?? undefined,
      scope: input.scope,
      usage: input.usage,
      origin: input.origin,
      title: input.title,
      remark: input.remark,
      url: input.url ?? undefined,
      originalPath: originalPath ?? undefined,
      content: '',
      filePath: assetPath,
      mimeType,
      processingState: processed.processingError ? 'failed' : 'ready',
      processingError: processed.processingError ?? null,
      skipIndex: true,
    });
    const asset = await parseDocumentFile({
      sourceId: record.id,
      courseId: input.courseId,
      nodeId: input.nodeId ?? null,
      title: input.title,
      fileName: input.title,
      originalPath,
      filePath: assetPath,
      mimeType,
      text: processed.content,
      sourceKind: 'upload',
    });
    persistDocumentAssetForSource({ sourceId: record.id, asset, filePath: assetPath, force: true });
    setSourceProcessingError(record.id, processed.processingError ?? null);
    setSourceProcessingState(record.id, processed.processingError ? 'failed' : 'ready');
    return fetchFreshRecord(record.id);
  }

  const asset = await parseDocumentFile({
    sourceId,
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    title: input.title,
    fileName: input.title,
    originalPath,
    filePath: assetPath,
    mimeType,
    buffer: input.buffer,
    sourceKind: 'upload',
  });
  const hasText = documentAssetTextCharCount(asset) > 0;
  const record = importTextSource({
    id: sourceId,
    courseId: input.courseId,
    nodeId: input.nodeId ?? undefined,
    threadId: input.threadId ?? undefined,
    sessionId: input.sessionId ?? undefined,
    scope: input.scope,
    usage: input.usage,
    origin: input.origin,
    title: input.title,
    remark: input.remark,
    url: input.url ?? undefined,
    originalPath: originalPath ?? undefined,
    content: '',
    filePath: assetPath,
    mimeType,
    processingState: asset.processingState,
    processingError: asset.processingError ?? null,
    skipIndex: true,
  });
  const { ocrStarted } = persistDocumentAssetForSource({
    sourceId: record.id,
    asset: { ...asset, sourceId: record.id },
    filePath: assetPath,
    force: true,
  });

  if (ocrStarted) {
    setSourceProcessingError(record.id, pdfOcrPendingMessage());
    setSourceProcessingState(record.id, hasText ? 'partial' : 'pending');
  } else if (!hasText) {
    setSourceProcessingError(record.id, asset.processingError ?? '未提取到可用正文。');
    setSourceProcessingState(record.id, 'failed');
  }

  return fetchFreshRecord(record.id);
}
