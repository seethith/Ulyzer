import { randomUUID } from 'crypto';
import { basename, extname } from 'path';
import type { SourceImportUrlRequest, SourceProcessingState, SourceRecord } from '@shared/types';
import { attachmentMimeType } from '@shared/attachment-formats';
import { extractPage, type ExtractedPage } from '../web/page-extractor';
import { normalizeUrl } from '../web/source-authority';
import { ingestUploadSource } from '../documents/document-ingest';
import { getSourceById, importTextSource, replaceSourceContent, upsertWebSource } from './source-library';
import { setSourceProcessingError, setSourceProcessingState } from './source-indexer';
import { scheduleSourceSemanticProfile } from './source-semantic-profile';
import {
  buildVideoUrlContent,
  isYtDlpCandidateUrl,
  videoMimeType,
  videoSiteFromUrl,
} from './video-ingestion';

const URL_FETCH_TIMEOUT_MS = 25_000;
const URL_MAX_DOWNLOAD_BYTES = 260 * 1024 * 1024;

const REMOTE_DOCUMENT_EXTS = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx',
  '.rtf', '.epub', '.odt', '.ods', '.odp',
  '.opml', '.mm', '.xmind',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
]);

export interface UrlIngestionOutcome {
  record: SourceRecord;
  normalizedUrl: string;
  storedUrl: string;
  title: string;
  content: string;
  kind: 'video' | 'remote_file' | 'web';
  method?: string;
  qualityScore?: number;
  warnings: string[];
  processingState?: SourceProcessingState;
}

interface RemoteUrlInfo {
  url: string;
  contentType: string;
  contentLength?: number;
  fileName?: string;
}

function decodeHeaderFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8).trim(); } catch { return utf8.trim(); }
  }
  const quoted = header.match(/filename="([^"]+)"/i)?.[1] || header.match(/filename=([^;]+)/i)?.[1];
  return quoted?.trim() || null;
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const pathName = new URL(url).pathname;
    const name = decodeURIComponent(basename(pathName));
    return name && name.includes('.') ? name : fallback;
  } catch {
    return fallback;
  }
}

function extFromUrl(url: string): string {
  try {
    return extname(new URL(url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

function isDocumentLike(input: { url: string; contentType?: string | null; fileName?: string | null }): boolean {
  const mime = (input.contentType ?? '').toLowerCase();
  const ext = extname(input.fileName || '').toLowerCase() || extFromUrl(input.url);
  if (REMOTE_DOCUMENT_EXTS.has(ext)) return true;
  return mime.includes('pdf')
    || mime.includes('wordprocessingml')
    || mime.includes('presentationml')
    || mime.includes('spreadsheetml')
    || mime.includes('rtf')
    || mime.includes('epub')
    || mime.includes('opendocument')
    || mime.startsWith('text/')
    || mime.includes('json')
    || mime.includes('xml')
    || mime.includes('yaml');
}

function isImageLike(input: { url: string; contentType?: string | null; fileName?: string | null }): boolean {
  const mime = (input.contentType ?? '').toLowerCase();
  const ext = extname(input.fileName || '').toLowerCase() || extFromUrl(input.url);
  return mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
}

async function inspectUrl(url: string): Promise<RemoteUrlInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Ulyzer/0.1 URL ingester',
        Accept: '*/*',
      },
    });
    if (!res.ok && res.status !== 405) throw new Error(`URL HEAD failed: ${res.status} ${res.statusText}`);
    const contentLength = Number(res.headers.get('content-length') || '');
    return {
      url: res.url || url,
      contentType: res.headers.get('content-type') || '',
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      fileName: decodeHeaderFilename(res.headers.get('content-disposition')) ?? undefined,
    };
  } catch {
    return { url, contentType: '', fileName: undefined };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadUrl(url: string, info: RemoteUrlInfo): Promise<{ buffer: Buffer; mimeType: string; fileName: string; finalUrl: string }> {
  if (info.contentLength && info.contentLength > URL_MAX_DOWNLOAD_BYTES) {
    throw new Error(`远程文件过大（${Math.round(info.contentLength / 1024 / 1024)}MB），请下载后作为本地文件导入。`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS * 4);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Ulyzer/0.1 URL ingester',
        Accept: '*/*',
      },
    });
    if (!res.ok) throw new Error(`远程文件下载失败：${res.status} ${res.statusText}`);
    const contentLength = Number(res.headers.get('content-length') || info.contentLength || '');
    if (Number.isFinite(contentLength) && contentLength > URL_MAX_DOWNLOAD_BYTES) {
      throw new Error(`远程文件过大（${Math.round(contentLength / 1024 / 1024)}MB），请下载后作为本地文件导入。`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > URL_MAX_DOWNLOAD_BYTES) {
      throw new Error(`远程文件过大（${Math.round(buffer.byteLength / 1024 / 1024)}MB），请下载后作为本地文件导入。`);
    }
    const mimeType = res.headers.get('content-type') || info.contentType || attachmentMimeType(url);
    const headerName = decodeHeaderFilename(res.headers.get('content-disposition'));
    const fileName = headerName || info.fileName || fileNameFromUrl(res.url || url, '远程参考资料');
    return { buffer, mimeType, fileName, finalUrl: res.url || info.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

function videoPlaceholderContent(input: { title: string; url: string; siteLabel: string }): string {
  return [
    `视频参考资料：${input.title}`,
    `平台：${input.siteLabel}`,
    `原始链接：${input.url}`,
    '',
    '说明：参考资料已入库，正在使用 yt-dlp 获取视频标题、元数据和字幕内容，完成后即可供 AI 检索使用。',
  ].join('\n');
}

function startVideoImportProcessing(input: {
  sourceId: string;
  url: string;
  title?: string;
}): void {
  void (async () => {
    const site = videoSiteFromUrl(input.url);
    try {
      const processed = await buildVideoUrlContent({
        title: input.title,
        url: input.url,
      });
      const nextState = processed.processingState ?? (processed.processingError ? 'limited' : 'ready');
      replaceSourceContent({
        sourceId: input.sourceId,
        title: processed.resolvedTitle,
        content: processed.content,
        mimeType: videoMimeType(processed.site, processed.extractor),
      });
      setSourceProcessingError(input.sourceId, processed.processingError ?? null);
      setSourceProcessingState(input.sourceId, nextState);
      scheduleProfileIfNeeded(getSourceById(input.sourceId), { force: true, delayMs: 250 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      replaceSourceContent({
        sourceId: input.sourceId,
        content: [
          `视频参考资料：${input.title?.trim() || `${site?.label ?? '视频'} 视频`}`,
          `平台：${site?.label ?? '视频'}`,
          `原始链接：${input.url}`,
          '',
          `说明：视频解析失败（${message}）。`,
          '当前仅保存视频链接，AI 暂时不能看到视频正文。可稍后点击参考库右上角的重建索引/修复重试。',
        ].join('\n'),
        mimeType: videoMimeType(site),
      });
      setSourceProcessingError(input.sourceId, `视频解析失败：${message}`);
      setSourceProcessingState(input.sourceId, 'limited');
      scheduleProfileIfNeeded(getSourceById(input.sourceId), { force: true, delayMs: 250 });
    }
  })();
}

function scheduleProfileIfNeeded(source: SourceRecord | null, options?: { force?: boolean; delayMs?: number }): void {
  if (!source) return;
  if (source.origin !== 'user_import' && source.origin !== 'web_collected') return;
  scheduleSourceSemanticProfile(source.id, options);
}

function contentHeader(input: {
  title: string;
  url: string;
  page: ExtractedPage;
  searchExcerpt?: string;
  lowQuality: boolean;
}): string[] {
  return [
    `网页资料：${input.title}`,
    `来源：${input.url}`,
    input.page.canonicalUrl ? `规范链接：${input.page.canonicalUrl}` : null,
    input.page.siteName ? `站点：${input.page.siteName}` : null,
    input.page.byline ? `作者：${input.page.byline}` : null,
    input.page.method ? `解析方式：${input.page.method}` : null,
    typeof input.page.qualityScore === 'number' ? `解析质量：${input.page.qualityScore.toFixed(2)}${input.lowQuality ? '（偏低，已保留搜索摘要兜底）' : ''}` : null,
    input.page.excerpt ? `页面摘要：${input.page.excerpt}` : null,
  ].filter(Boolean) as string[];
}

function composeWebContent(input: {
  title: string;
  url: string;
  page: ExtractedPage;
  searchExcerpt?: string;
}): { content: string; lowQuality: boolean; warning?: string } {
  const searchExcerpt = input.searchExcerpt?.trim();
  const quality = input.page.qualityScore ?? 0;
  const lowQuality = quality < 0.45 || input.page.text.trim().length < 500;
  const header = contentHeader({ ...input, searchExcerpt, lowQuality });
  const body = input.page.text.trim();
  if (lowQuality && searchExcerpt) {
    return {
      lowQuality,
      warning: '网页正文解析质量偏低，已优先保存搜索摘要并附带少量抓取正文。',
      content: [
        ...header,
        '',
        '## 搜索摘要',
        searchExcerpt,
        body ? '\n## 低质量网页正文摘录\n' + body.slice(0, 4000) : null,
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    lowQuality,
    warning: lowQuality ? '网页正文解析质量偏低，可能只包含页面壳或少量正文。' : undefined,
    content: [
      ...header,
      searchExcerpt ? `\n## 搜索摘要\n${searchExcerpt}` : null,
      body ? `\n## 网页正文\n${body}` : null,
    ].filter(Boolean).join('\n'),
  };
}

export function shouldRefreshUrlSource(source: SourceRecord): boolean {
  if (source.kind !== 'web') return false;
  if (source.processingState === 'failed' || source.processingState === 'limited') return true;
  if ((source.chunkCount ?? 0) <= 1) return true;
  if (/低质量|页面壳|正文解析质量偏低|no indexed content/i.test(source.processingError ?? '')) return true;
  return false;
}

async function ingestVideoUrl(input: SourceImportUrlRequest, normalizedUrl: string): Promise<UrlIngestionOutcome> {
  const site = videoSiteFromUrl(normalizedUrl);
  const title = input.title?.trim() || `${site?.label ?? '视频'} 视频`;
  const content = videoPlaceholderContent({
    title,
    url: normalizedUrl,
    siteLabel: site?.label ?? '视频',
  });
  const record = importTextSource({
    courseId: input.courseId,
    nodeId: input.nodeId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    scope: input.scope,
    usage: input.usage,
    origin: input.origin,
    title,
    remark: input.remark,
    content,
    url: normalizedUrl,
    mimeType: videoMimeType(site),
  });
  setSourceProcessingError(record.id, null);
  setSourceProcessingState(record.id, 'pending');
  startVideoImportProcessing({ sourceId: record.id, url: normalizedUrl, title: input.title });
  return {
    record,
    normalizedUrl,
    storedUrl: normalizedUrl,
    title,
    content,
    kind: 'video',
    method: 'yt-dlp',
    warnings: [],
    processingState: 'pending',
  };
}

export async function ingestUrlSource(input: SourceImportUrlRequest & {
  searchExcerpt?: string;
  trustScore?: number;
  renderFallback?: boolean;
  query?: string;
}): Promise<UrlIngestionOutcome> {
  const normalizedUrl = normalizeUrl(input.url);
  if (isYtDlpCandidateUrl(normalizedUrl)) {
    return ingestVideoUrl(input, normalizedUrl);
  }

  const info = await inspectUrl(normalizedUrl);
  const inspectedUrl = normalizeUrl(info.url || normalizedUrl);
  const fileName = info.fileName || fileNameFromUrl(inspectedUrl, input.title?.trim() || '远程参考资料');
  if (isDocumentLike({ url: inspectedUrl, contentType: info.contentType, fileName }) || isImageLike({ url: inspectedUrl, contentType: info.contentType, fileName })) {
    const downloaded = await downloadUrl(inspectedUrl, info);
    const title = input.title?.trim() || downloaded.fileName || fileName;
    const record = await ingestUploadSource({
      id: randomUUID(),
      courseId: input.courseId,
      nodeId: input.nodeId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      scope: input.scope,
      usage: input.usage,
      origin: input.origin,
      title,
      remark: input.remark,
      url: normalizeUrl(downloaded.finalUrl),
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
    scheduleProfileIfNeeded(record, { delayMs: 500 });
    return {
      record,
      normalizedUrl,
      storedUrl: normalizeUrl(downloaded.finalUrl),
      title: record.title,
      content: '',
      kind: 'remote_file',
      method: record.mediaType ?? downloaded.mimeType,
      warnings: [],
      processingState: record.processingState,
    };
  }

  const page = await extractPage(inspectedUrl, input.title, {
    timeoutMs: 10_000,
    maxChars: 80_000,
    query: input.query,
    searchExcerpt: input.searchExcerpt,
    renderFallback: input.renderFallback,
  });
  const storedUrl = normalizeUrl(page.canonicalUrl || inspectedUrl);
  const title = input.title?.trim() || page.title || storedUrl;
  const { content, lowQuality, warning } = composeWebContent({
    title,
    url: storedUrl,
    page,
    searchExcerpt: input.searchExcerpt,
  });
  const record = upsertWebSource({
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    scope: input.scope,
    usage: input.usage,
    origin: input.origin ?? 'user_import',
    title,
    remark: input.remark,
    url: storedUrl,
    content,
    trustScore: input.trustScore ?? (lowQuality ? 0.55 : 0.72),
  });
  setSourceProcessingError(record.id, warning ?? null);
  setSourceProcessingState(record.id, lowQuality ? 'limited' : 'ready');
  scheduleProfileIfNeeded(record, { delayMs: 250 });
  return {
    record,
    normalizedUrl,
    storedUrl,
    title,
    content,
    kind: 'web',
    method: page.method,
    qualityScore: page.qualityScore,
    warnings: warning ? [warning] : [],
    processingState: lowQuality ? 'limited' : 'ready',
  };
}
