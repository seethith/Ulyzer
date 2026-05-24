import {
  attachmentExt,
  isAttachmentDocxExt,
  isAttachmentEpubExt,
  isAttachmentMmExt,
  isAttachmentOdpExt,
  isAttachmentOdsExt,
  isAttachmentOdtExt,
  isAttachmentOpmlExt,
  isAttachmentPdfExt,
  isAttachmentPptxExt,
  isAttachmentRtfExt,
  isAttachmentTextExt,
  isAttachmentXmindExt,
  isAttachmentXlsxExt,
} from '@shared/attachment-formats';
import type { SourceRecord, SourceKind } from '@shared/types';
import { getSourceById } from '../source/source-library';
import { setSourceProcessingError, setSourceProcessingState } from '../source/source-indexer';
import { indexDocumentAsset, indexDocumentAssetUnits } from './document-indexer';
import { documentAssetTextCharCount, parseDocumentFile } from './document-parser';
import { replaceDocumentAsset, replaceDocumentUnits } from './document-store';
import { upsertDocumentSummaryTree } from './document-summary-tree';
import { createDocumentJob, listDocumentJobs, updateDocumentJob } from './document-jobs';
import type { DocumentAsset, DocumentBlock, DocumentUnit } from './document-types';
import { extractPdfPagesWithLocalOcr, normalizePdfOcrWorkerCount, type PdfOcrPageResult } from './pdf-ocr';
import { maybeStartPdfPageAssetBackfill } from './pdf-page-assets';
import { getDb } from '../db/sqlite';

const PDF_OCR_PENDING_MESSAGE = 'PDF 文本层不足，正在后台 OCR；完成后会自动更新可检索正文。';
const MAX_OCR_PAGES = 1000;
const OCR_BATCH_SIZE = 12;

function documentSourceKind(source: SourceRecord): SourceKind {
  return source.kind === 'web' || source.kind === 'generated' ? source.kind : 'upload';
}

function isTextLikeSource(source: SourceRecord): boolean {
  const ext = attachmentExt(source.title || source.filePath || '');
  const mime = String(source.mediaType ?? '').toLowerCase();
  return mime.startsWith('text/')
    || mime.includes('json')
    || mime.includes('xml')
    || mime.includes('yaml')
    || isAttachmentTextExt(ext);
}

function isProcessableDocumentSource(source: SourceRecord): boolean {
  if (!source.filePath) return false;
  const ext = attachmentExt(source.title || source.filePath);
  const mime = String(source.mediaType ?? '').toLowerCase();
  return isAttachmentPdfExt(ext)
    || isAttachmentDocxExt(ext)
    || isAttachmentPptxExt(ext)
    || isAttachmentXlsxExt(ext)
    || isAttachmentRtfExt(ext)
    || isAttachmentEpubExt(ext)
    || isAttachmentOdtExt(ext)
    || isAttachmentOdsExt(ext)
    || isAttachmentOdpExt(ext)
    || isAttachmentOpmlExt(ext)
    || isAttachmentMmExt(ext)
    || isAttachmentXmindExt(ext)
    || mime.includes('pdf')
    || mime.includes('wordprocessingml')
    || mime.includes('presentationml')
    || mime.includes('spreadsheetml')
    || mime.includes('rtf')
    || mime.includes('epub')
    || mime.includes('opendocument')
    || mime.includes('opml')
    || mime.includes('freemind')
    || mime.includes('xmind')
    || isTextLikeSource(source);
}

function pendingPdfPageNumbers(asset: DocumentAsset): number[] {
  if (asset.kind !== 'pdf') return [];
  return asset.units
    .filter((unit) => unit.kind === 'page' && unit.ocrState === 'pending' && unit.pageNumber)
    .map((unit) => unit.pageNumber as number)
    .slice(0, MAX_OCR_PAGES);
}

function hasActiveOcrJob(sourceId: string): boolean {
  return [...listDocumentJobs({ sourceId, state: 'pending', limit: 20 }), ...listDocumentJobs({ sourceId, state: 'running', limit: 20 })]
    .some((job) => job.jobType === 'ocr');
}

function createOcrBlocks(input: {
  sourceId: string;
  courseId: string;
  nodeId?: string | null;
  locator: string;
  pageNumber?: number | null;
  text: string;
}): DocumentBlock[] {
  const paragraphs = input.text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0 && input.text.trim()) paragraphs.push(input.text.trim());

  let cursor = 0;
  return paragraphs.map((paragraph, index) => {
    const start = input.text.indexOf(paragraph, cursor);
    const charStart = start >= 0 ? start : cursor;
    cursor = charStart + paragraph.length;
    return {
      sourceId: input.sourceId,
      courseId: input.courseId,
      nodeId: input.nodeId ?? null,
      blockIndex: index,
      type: 'ocr_text',
      locator: `${input.locator} OCR block ${index + 1}`,
      pageNumber: input.pageNumber ?? null,
      text: paragraph,
      charStart,
      charEnd: charStart + paragraph.length,
      metadata: { source: 'macos_vision_ocr' },
    };
  });
}

function mergeOcrResult(asset: DocumentAsset, sourceId: string, pages: PdfOcrPageResult[]): DocumentAsset {
  const byPage = new Map(pages.map((page) => [page.page, page]));
  const units = asset.units.map((unit): DocumentUnit => {
    if (unit.kind !== 'page' || !unit.pageNumber || !byPage.has(unit.pageNumber)) return unit;
    const result = byPage.get(unit.pageNumber)!;
    const text = result.text.trim();
    if (!text) {
      return {
        ...unit,
        sourceId,
        ocrState: result.error ? 'failed' : 'ready',
        metadata: {
          ...unit.metadata,
          ocrSource: 'macos_vision',
          ocrError: result.error ?? undefined,
        },
      };
    }
    return {
      ...unit,
      sourceId,
      text,
      charCount: text.length,
      ocrState: 'ready',
      metadata: {
        ...unit.metadata,
        source: unit.metadata?.source ?? 'pdf_text_layer',
        ocrSource: 'macos_vision',
      },
      blocks: createOcrBlocks({
        sourceId,
        courseId: asset.courseId,
        nodeId: asset.nodeId ?? null,
        locator: unit.locator,
        pageNumber: unit.pageNumber,
        text,
      }),
    };
  });

  const textUnitCount = units.filter((unit) => unit.text.trim().length > 0).length;
  const totalChars = units.reduce((sum, unit) => sum + unit.charCount, 0);
  const ocrPendingCount = units.filter((unit) => unit.ocrState === 'pending').length;
  const ocrFailedCount = units.filter((unit) => unit.ocrState === 'failed').length;
  return {
    ...asset,
    sourceId,
    processingState: 'ready',
    processingError: null,
    metadata: {
      ...asset.metadata,
      textUnitCount,
      totalChars,
      suspectedScanned: asset.kind === 'pdf' && units.length > 0 && textUnitCount / units.length < 0.25,
      ocrProvider: 'macos_vision',
      ocrPendingCount,
      ocrFailedCount,
    },
    units,
  };
}

function ocrProgressMessage(done: number, total: number): string {
  return `PDF OCR 中：已完成 ${done}/${total} 页。`;
}

function getConfiguredOcrWorkerCount(): number {
  try {
    const row = getDb()
      .prepare<[], { ocr_worker_count?: number | null }>('SELECT ocr_worker_count FROM settings WHERE id = 1')
      .get();
    return normalizePdfOcrWorkerCount(row?.ocr_worker_count);
  } catch {
    return normalizePdfOcrWorkerCount(undefined);
  }
}

function setProgressiveOcrSourceState(input: {
  sourceId: string;
  asset: DocumentAsset;
  done: number;
  total: number;
}): void {
  const totalChars = documentAssetTextCharCount(input.asset);
  const ocrPendingCount = Number(input.asset.metadata?.ocrPendingCount ?? 0);
  if (ocrPendingCount > 0) {
    setSourceProcessingState(input.sourceId, totalChars > 0 ? 'partial' : 'pending');
    setSourceProcessingError(input.sourceId, ocrProgressMessage(input.done, input.total));
    return;
  }
  setSourceProcessingState(input.sourceId, 'ready');
}

export function maybeStartPdfOcrBackfill(input: {
  sourceId: string;
  asset: DocumentAsset;
  filePath?: string | null;
}): boolean {
  if (input.asset.kind !== 'pdf' || !input.filePath) return false;
  const pages = pendingPdfPageNumbers(input.asset);
  if (pages.length === 0) return false;
  if (hasActiveOcrJob(input.sourceId)) return true;

  const job = createDocumentJob({
    sourceId: input.sourceId,
    courseId: input.asset.courseId,
    nodeId: input.asset.nodeId ?? null,
    jobType: 'ocr',
    progressTotal: pages.length,
    metadata: { pages, filePath: input.filePath },
  });
  setSourceProcessingState(input.sourceId, 'pending');
  setSourceProcessingError(input.sourceId, PDF_OCR_PENDING_MESSAGE);

  void (async () => {
    let currentAsset: DocumentAsset = { ...input.asset, sourceId: input.sourceId };
    let recognizedPages = 0;
    let sawPageError = false;
    try {
      const workerCount = getConfiguredOcrWorkerCount();
      updateDocumentJob(job.id, { state: 'running', progressCurrent: 0, progressTotal: pages.length });
      let pendingResults: PdfOcrPageResult[] = [];
      let flushedPages = 0;
      let flushChain = Promise.resolve();
      const flushResults = async (batch: PdfOcrPageResult[]) => {
        if (batch.length === 0) return;
        currentAsset = mergeOcrResult(currentAsset, input.sourceId, batch);
        recognizedPages += batch.filter((page) => page.text.trim()).length;
        sawPageError = sawPageError || batch.some((page) => page.error);
        const changedPages = new Set(batch.map((page) => page.page));
        const changedUnits = currentAsset.units.filter((unit) => unit.pageNumber && changedPages.has(unit.pageNumber));
        replaceDocumentUnits(input.sourceId, currentAsset, changedUnits);
        if (changedUnits.some((unit) => unit.text.trim())) {
          indexDocumentAssetUnits({
            sourceId: input.sourceId,
            asset: currentAsset,
            units: changedUnits,
          });
        }
        flushedPages += batch.length;
        const done = Math.min(flushedPages, pages.length);
        setProgressiveOcrSourceState({
          sourceId: input.sourceId,
          asset: currentAsset,
          done,
          total: pages.length,
        });
        updateDocumentJob(job.id, {
          state: 'running',
          progressCurrent: done,
          progressTotal: pages.length,
          error: null,
          metadata: { pages, filePath: input.filePath, recognizedPages, workerCount },
        });
      };

      await extractPdfPagesWithLocalOcr({
        pdfPath: input.filePath!,
        pages,
        workerCount,
        onPage: (page) => {
          pendingResults.push(page);
          if (pendingResults.length < OCR_BATCH_SIZE) return;
          const batch = pendingResults;
          pendingResults = [];
          flushChain = flushChain.then(() => flushResults(batch));
        },
      });
      await flushChain;
      await flushResults(pendingResults);
      const warning = recognizedPages === 0
        ? 'OCR 未识别到可用文本；该 PDF 可能是低清扫描、图片质量较差或暂不适合本地 OCR。'
        : sawPageError
          ? '部分页面 OCR 失败；可稍后再次修复或换用更清晰文件。'
          : null;
      setSourceProcessingError(input.sourceId, warning);
      setSourceProcessingState(input.sourceId, 'ready');
      try {
        upsertDocumentSummaryTree(input.sourceId, { force: true });
      } catch {
        // 摘要树只用于增强检索，不阻断 OCR 完成状态。
      }
      updateDocumentJob(job.id, {
        state: 'ready',
        progressCurrent: pages.length,
        progressTotal: pages.length,
        error: warning,
        metadata: { pages, recognizedPages, workerCount },
      });
      maybeStartPdfPageAssetBackfill({
        sourceId: input.sourceId,
        asset: currentAsset,
        filePath: input.filePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSourceProcessingError(input.sourceId, `PDF OCR 失败：${message}`);
      setSourceProcessingState(input.sourceId, 'failed');
      updateDocumentJob(job.id, {
        state: 'failed',
        error: message,
        metadata: { pages, filePath: input.filePath },
      });
    }
  })();

  return true;
}

export function persistDocumentAssetForSource(input: {
  sourceId: string;
  asset: DocumentAsset;
  filePath?: string | null;
  force?: boolean;
}): { ocrStarted: boolean } {
  replaceDocumentAsset(input.sourceId, { ...input.asset, sourceId: input.sourceId });
  if (documentAssetTextCharCount(input.asset) > 0) {
    indexDocumentAsset({ sourceId: input.sourceId, asset: input.asset, force: input.force });
  }
  try {
    upsertDocumentSummaryTree(input.sourceId, { force: true });
  } catch {
    // 摘要树生成失败不影响原始文档入库和索引。
  }
  setSourceProcessingError(input.sourceId, input.asset.processingError ?? null);
  setSourceProcessingState(input.sourceId, input.asset.processingState);
  const ocrStarted = maybeStartPdfOcrBackfill({
    sourceId: input.sourceId,
    asset: { ...input.asset, sourceId: input.sourceId },
    filePath: input.filePath ?? input.asset.filePath,
  });
  if (!ocrStarted && input.asset.kind === 'pdf') {
    maybeStartPdfPageAssetBackfill({
      sourceId: input.sourceId,
      asset: { ...input.asset, sourceId: input.sourceId },
      filePath: input.filePath ?? input.asset.filePath,
    });
  }
  return { ocrStarted };
}

export async function reprocessDocumentSource(sourceId: string, force = false): Promise<boolean> {
  const source = getSourceById(sourceId);
  if (!source || !isProcessableDocumentSource(source)) return false;
  const asset = await parseDocumentFile({
    sourceId,
    courseId: source.courseId,
    nodeId: source.nodeId,
    title: source.title,
    fileName: source.title,
    originalPath: source.originalPath ?? null,
    filePath: source.filePath,
    mimeType: source.mediaType ?? null,
    sourceKind: documentSourceKind(source),
  });
  persistDocumentAssetForSource({ sourceId, asset, filePath: source.filePath, force });
  if (documentAssetTextCharCount(asset) === 0 && asset.kind !== 'pdf') {
    setSourceProcessingError(sourceId, '重新解析完成，但未提取到可用正文。');
  }
  return true;
}

export function pdfOcrPendingMessage(): string {
  return PDF_OCR_PENDING_MESSAGE;
}
