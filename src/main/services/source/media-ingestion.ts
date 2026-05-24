import { extractImageTextLocally } from './local-ocr';
import { transcribeMediaLocally, type LocalTranscriptionResult } from './local-transcription';
import type { SourceProcessingState } from '@shared/types';
import { buildVideoUrlContent } from './video-ingestion';

export interface MediaProcessingResult {
  content: string;
  processingError?: string | null;
  processingState?: SourceProcessingState;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function transcriptBlock(result: LocalTranscriptionResult): string {
  if (result.segments.length > 0) {
    return result.segments
      .map((segment) => `[${formatTime(segment.start)}-${formatTime(segment.end)}] ${segment.text}`)
      .join('\n');
  }
  return result.text.trim();
}

function mediaHeader(input: {
  label: string;
  title: string;
  url?: string;
  filePath?: string;
  mimeType: string;
}): string[] {
  return [
    `${input.label}：${input.title}`,
    input.url ? `原始链接：${input.url}` : null,
    input.filePath ? `本地资产：${input.filePath}` : null,
    `媒体类型：${input.mimeType}`,
  ].filter(Boolean) as string[];
}

export function isImageMediaType(mimeType?: string | null): boolean {
  return String(mimeType ?? '').toLowerCase().startsWith('image/');
}

export function isAudioMediaType(mimeType?: string | null): boolean {
  return String(mimeType ?? '').toLowerCase().startsWith('audio/');
}

export function isVideoMediaType(mimeType?: string | null): boolean {
  return String(mimeType ?? '').toLowerCase().startsWith('video/');
}

export function isVideoUrlMediaType(mimeType?: string | null): boolean {
  const normalized = String(mimeType ?? '').toLowerCase();
  return normalized.includes('video-link') || normalized.includes('youtube');
}

export async function buildImageContent(input: {
  title: string;
  filePath: string;
  mimeType: string;
  url?: string;
}): Promise<MediaProcessingResult> {
  const header = mediaHeader({ label: '图片资料', ...input });
  try {
    const { text } = await extractImageTextLocally(input.filePath);
    if (!text.trim()) {
      return {
        content: [
          ...header,
          'OCR 结果：未识别到明确文字内容。',
          '说明：当前版本会优先提取图片中的文字；纯图表或无字图片仍建议配合文字说明使用。',
        ].join('\n'),
      };
    }
    return {
      content: [
        ...header,
        'OCR 提取文本：',
        text.trim(),
      ].join('\n\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        ...header,
        `说明：本地 OCR 失败（${message}）。`,
        '图片资产已保留，可稍后点击参考库刷新/修复重试。',
      ].join('\n'),
      processingError: `图片 OCR 失败：${message}`,
    };
  }
}

async function buildTranscriptionContent(input: {
  label: '音频资料' | '视频资料';
  title: string;
  filePath: string;
  mimeType: string;
}): Promise<MediaProcessingResult> {
  const header = mediaHeader({
    label: input.label,
    title: input.title,
    filePath: input.filePath,
    mimeType: input.mimeType,
  });
  try {
    const result = await transcribeMediaLocally(input.filePath);
    if (!result.text.trim()) {
      return {
        content: [
          ...header,
          '转写结果：未识别到明确语音内容。',
          '说明：如果文件里主要是音乐、环境声或音质较差，转写结果可能为空。',
        ].join('\n'),
      };
    }
    return {
      content: [
        ...header,
        result.language ? `识别语言：${result.language}` : null,
        '本地转写：',
        transcriptBlock(result),
      ].filter(Boolean).join('\n\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        ...header,
        `说明：本地转写失败（${message}）。`,
        '媒体资产已保留，可稍后点击参考库刷新/修复重试。',
      ].join('\n'),
      processingError: `${input.label}转写失败：${message}`,
    };
  }
}

export async function buildAudioContent(input: {
  title: string;
  filePath: string;
  mimeType: string;
}): Promise<MediaProcessingResult> {
  return buildTranscriptionContent({ ...input, label: '音频资料' });
}

export async function buildVideoContent(input: {
  title: string;
  filePath: string;
  mimeType: string;
}): Promise<MediaProcessingResult> {
  return buildTranscriptionContent({ ...input, label: '视频资料' });
}

export async function rebuildMediaContent(input: {
  title: string;
  filePath?: string | null;
  url?: string | null;
  mimeType?: string | null;
}): Promise<MediaProcessingResult | null> {
  if (isVideoUrlMediaType(input.mimeType) && input.url) {
    const { content, processingError, processingState } = await buildVideoUrlContent({
      title: input.title,
      url: input.url,
    });
    return { content, processingError, processingState };
  }
  if (isImageMediaType(input.mimeType) && input.filePath) {
    return buildImageContent({
      title: input.title,
      filePath: input.filePath,
      mimeType: input.mimeType || 'image/*',
      url: input.url ?? undefined,
    });
  }
  if (isAudioMediaType(input.mimeType) && input.filePath) {
    return buildAudioContent({
      title: input.title,
      filePath: input.filePath,
      mimeType: input.mimeType || 'audio/*',
    });
  }
  if (isVideoMediaType(input.mimeType) && input.filePath) {
    return buildVideoContent({
      title: input.title,
      filePath: input.filePath,
      mimeType: input.mimeType || 'video/*',
    });
  }
  return null;
}
