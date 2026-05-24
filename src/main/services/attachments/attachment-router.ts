import { app } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';
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
  isKnownUnsupportedAttachmentExt,
  isNativeImageAttachmentExt,
} from '@shared/attachment-formats';
import type { FileAttachment, LLMProvider } from '@shared/types';
import type { ImageAttachment, PdfAttachment } from '../llm/adapter';
import { resolveAttachmentStrategies } from '../llm/model-capabilities';
import { importTextSource } from '../source/source-library';
import { buildAudioContent, buildImageContent, buildVideoContent } from '../source/media-ingestion';
import {
  documentAssetTextCharCount,
  documentAssetToText,
  parseDocumentFile,
} from '../documents/document-parser';
import { persistDocumentAssetForSource } from '../documents/document-processing';
import type { DocumentAsset } from '../documents/document-types';

const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 20_000;

export interface RoutedAttachments {
  userMessage: string;
  imageAttachments: ImageAttachment[];
  pdfAttachments: PdfAttachment[];
}

export interface RouteAttachmentInput {
  attachments: FileAttachment[];
  baseMessage: string;
  provider: LLMProvider;
  model: string;
  nodeId?: string;
  courseId?: string;
}

function extName(name: string): string {
  return attachmentExt(name);
}

function mediaTypeForImage(name: string, fallback?: string): string {
  return attachmentMimeType(name, fallback);
}

function decodeAttachmentBuffer(att: FileAttachment): Buffer | null {
  if (att.base64) return Buffer.from(att.base64, 'base64');
  if (att.path) {
    try { return fs.readFileSync(att.path); } catch { return null; }
  }
  return null;
}

function readAttachmentText(att: FileAttachment): string | null {
  if (att.content) return att.content;
  if (att.path) {
    try { return fs.readFileSync(att.path, 'utf8'); } catch { return null; }
  }
  return null;
}

function tempPathForAttachment(name: string, buffer: Buffer): string {
  const dir = nodePath.join(app.getPath('temp'), 'ulyzer-attachments');
  fs.mkdirSync(dir, { recursive: true });
  const ext = extName(name) || '.bin';
  const filePath = nodePath.join(dir, `${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function appendAttachmentText(base: string, name: string, content: string, label = '附件'): string {
  const snippet = content.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
  return `${base}\n\n[${label}: ${name}]\n\`\`\`\n${snippet}\n\`\`\``;
}

function appendPreparedAttachmentSources(base: string, attachments: FileAttachment[]): string {
  if (attachments.length === 0) return base;
  const lines = [
    '[本轮已解析附件]',
    '这些文件已经在发送前解析为参考资料。需要阅读文件正文时，直接调用 read_source，并使用对应 source_id；不要要求用户重新上传或粘贴文件内容。',
    ...attachments.map((att, index) => [
      `${index + 1}. ${att.name}`,
      `source_id：${att.sourceId}`,
      `状态：${att.status ?? 'ready'}${att.message ? `（${att.message}）` : ''}`,
    ].join('\n')),
  ];
  return `${base}\n\n${lines.join('\n')}`;
}

function documentFallbackContent(input: { title: string; kindLabel: string; reason?: string | null }): string {
  return [
    input.title.replace(/\.[^.]+$/, '').trim() || input.title,
    '',
    `该 ${input.kindLabel} 未提取到可用正文${input.reason ? `：${input.reason}` : '，可能是扫描版、加密文件或暂不支持的版式'}。`,
  ].join('\n');
}

function maybeIndexAttachmentText(input: {
  att: FileAttachment;
  text: string;
  asset?: DocumentAsset;
  nodeId?: string;
  courseId?: string;
}): void {
  if (!input.nodeId || !input.courseId) return;
  try {
    const record = importTextSource({
      courseId: input.courseId,
      nodeId: input.nodeId,
      title: input.att.name,
      content: input.text,
      mimeType: input.att.mimeType,
      origin: 'chat_attachment',
      processingState: input.asset?.processingState,
      processingError: input.asset?.processingError ?? null,
    });
    if (input.asset) {
      persistDocumentAssetForSource({
        sourceId: record.id,
        asset: {
          ...input.asset,
          sourceId: record.id,
          courseId: input.courseId,
          nodeId: input.nodeId,
        },
        filePath: input.asset.filePath,
        force: true,
      });
    }
  } catch { /* non-fatal */ }
}

async function parseDocumentAttachment(input: {
  att: FileAttachment;
  buffer?: Buffer;
  text?: string;
  kindLabel: string;
  courseId?: string;
  nodeId?: string;
}): Promise<{ asset: DocumentAsset; text: string; hasText: boolean; suspectedScanned: boolean }> {
  const asset = await parseDocumentFile({
    courseId: input.courseId ?? 'chat-attachment',
    nodeId: input.nodeId ?? null,
    title: input.att.name,
    fileName: input.att.name,
    filePath: input.att.path ?? null,
    mimeType: input.att.mimeType || attachmentMimeType(input.att.name),
    buffer: input.buffer,
    text: input.text,
    sourceKind: 'upload',
  });
  const hasText = documentAssetTextCharCount(asset) > 0;
  const suspectedScanned = asset.metadata?.suspectedScanned === true;
  const text = hasText
    ? documentAssetToText(asset).trim()
    : documentFallbackContent({ title: input.att.name, kindLabel: input.kindLabel, reason: asset.processingError });
  return { asset, text, hasText, suspectedScanned };
}

export async function routeChatAttachments(input: RouteAttachmentInput): Promise<RoutedAttachments> {
  const preparedAttachments = input.attachments.filter((att) => att.sourceId);
  let userMessage = appendPreparedAttachmentSources(input.baseMessage, preparedAttachments);
  const imageAttachments: ImageAttachment[] = [];
  const pdfAttachments: PdfAttachment[] = [];
  const strategies = resolveAttachmentStrategies(input.provider, input.model);
  const notices: string[] = [];

  for (const att of input.attachments) {
    if (att.sourceId) continue;
    const ext = extName(att.name);

    if (isAttachmentImageExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`图片 ${att.name} 读取失败，已跳过。`);
        continue;
      }
      const b64 = att.base64 ?? buffer.toString('base64');
      if (strategies.image === 'native' && isNativeImageAttachmentExt(ext)) {
        if (b64.length > MAX_IMAGE_BASE64_BYTES) {
          notices.push(`图片 ${att.name} 体积过大，已跳过；请压缩后重新上传。`);
          continue;
        }
        imageAttachments.push({ mediaType: mediaTypeForImage(att.name, att.mimeType), base64: b64, name: att.name });
        continue;
      }
      if (strategies.image === 'native' || strategies.image === 'ocr_fallback') {
        const filePath = att.path || tempPathForAttachment(att.name, buffer);
        const processed = await buildImageContent({
          title: att.name,
          filePath,
          mimeType: att.mimeType || mediaTypeForImage(att.name),
        });
        const parsed = await parseDocumentAttachment({
          att: { ...att, path: filePath },
          buffer,
          text: processed.content,
          kindLabel: '图片 OCR 附件',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, processed.content, '图片 OCR 附件');
        if (processed.processingError) notices.push(processed.processingError);
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        continue;
      }
      notices.push(`当前模型无法处理图片 ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentPdfExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`PDF ${att.name} 读取失败，已跳过。`);
        continue;
      }
      const b64 = att.base64 ?? buffer.toString('base64');
      if (strategies.pdf === 'native' && input.provider === 'anthropic') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'PDF',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) {
          notices.push(`PDF ${att.name} 本地解析失败，但已作为原生 PDF 发送给模型：${parsed.asset.processingError}`);
        }
        pdfAttachments.push({ name: att.name, base64: b64 });
        continue;
      }
      if (strategies.pdf === 'native' || strategies.pdf === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'PDF',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'PDF 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`PDF ${att.name} 解析失败：${parsed.asset.processingError}`);
        if (!parsed.hasText && parsed.suspectedScanned) notices.push(`PDF ${att.name} 文本层不足，后续 OCR 阶段可增强读取。`);
        continue;
      }
      notices.push(`当前模型无法处理 PDF ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentDocxExt(ext) || ext === '.doc') {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`Word 文档 ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.docx === 'extract_text' && ext === '.docx') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'DOCX',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'DOCX 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`DOCX ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前版本暂不支持解析 ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentPptxExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`PPTX ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.pptx === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'PPTX',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'PPTX 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`PPTX ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 PPTX ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentXlsxExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`XLSX ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.xlsx === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'XLSX',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'XLSX 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`XLSX ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 XLSX ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentRtfExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      const text = buffer ? undefined : readAttachmentText(att) ?? undefined;
      if (!buffer && !text) {
        notices.push(`RTF ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.rtf === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer: buffer ?? undefined,
          text,
          kindLabel: 'RTF',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'RTF 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`RTF ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 RTF ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentEpubExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`EPUB ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.epub === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'EPUB',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'EPUB 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`EPUB ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 EPUB ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentOdtExt(ext) || isAttachmentOdsExt(ext) || isAttachmentOdpExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`OpenDocument ${att.name} 读取失败，已跳过。`);
        continue;
      }
      const label = isAttachmentOdtExt(ext) ? 'ODT' : isAttachmentOdsExt(ext) ? 'ODS' : 'ODP';
      const strategy = isAttachmentOdtExt(ext) ? strategies.odt : isAttachmentOdsExt(ext) ? strategies.ods : strategies.odp;
      if (strategy === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: label,
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, `${label} 附件`);
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`${label} ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 ${label} ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentOpmlExt(ext) || isAttachmentMmExt(ext)) {
      const text = readAttachmentText(att);
      const buffer = text ? undefined : decodeAttachmentBuffer(att);
      if (!text && !buffer) {
        notices.push(`思维导图 ${att.name} 读取失败，已跳过。`);
        continue;
      }
      const label = isAttachmentOpmlExt(ext) ? 'OPML' : 'FreeMind';
      const strategy = isAttachmentOpmlExt(ext) ? strategies.opml : strategies.mm;
      if (strategy === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer: buffer ?? undefined,
          text: text ?? undefined,
          kindLabel: label,
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, `${label} 附件`);
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`${label} ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 ${label} ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentXmindExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`XMind ${att.name} 读取失败，已跳过。`);
        continue;
      }
      if (strategies.xmind === 'extract_text') {
        const parsed = await parseDocumentAttachment({
          att,
          buffer,
          kindLabel: 'XMind',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text, 'XMind 附件');
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`XMind ${att.name} 解析失败：${parsed.asset.processingError}`);
        continue;
      }
      notices.push(`当前模型无法处理 XMind ${att.name}，已跳过。`);
      continue;
    }

    if (isAttachmentAudioExt(ext) || isAttachmentVideoExt(ext)) {
      const buffer = decodeAttachmentBuffer(att);
      if (!buffer) {
        notices.push(`媒体文件 ${att.name} 读取失败，已跳过。`);
        continue;
      }
      const filePath = att.path || tempPathForAttachment(att.name, buffer);
      const processed = isAttachmentAudioExt(ext)
        ? await buildAudioContent({ title: att.name, filePath, mimeType: att.mimeType || attachmentMimeType(att.name) })
        : await buildVideoContent({ title: att.name, filePath, mimeType: att.mimeType || attachmentMimeType(att.name) });
      userMessage = appendAttachmentText(userMessage, att.name, processed.content, isAttachmentAudioExt(ext) ? '音频转写附件' : '视频转写附件');
      if (processed.processingError) notices.push(processed.processingError);
      maybeIndexAttachmentText({ att, text: processed.content, nodeId: input.nodeId, courseId: input.courseId });
      continue;
    }

    if (isAttachmentTextExt(ext) || (!isKnownUnsupportedAttachmentExt(ext) && att.content)) {
      const text = readAttachmentText(att);
      if (text) {
        const parsed = await parseDocumentAttachment({
          att,
          text,
          kindLabel: '文本附件',
          courseId: input.courseId,
          nodeId: input.nodeId,
        });
        userMessage = appendAttachmentText(userMessage, att.name, parsed.text);
        maybeIndexAttachmentText({
          att,
          text: parsed.text,
          asset: parsed.asset,
          nodeId: input.nodeId,
          courseId: input.courseId,
        });
        if (parsed.asset.processingError) notices.push(`附件 ${att.name} 解析失败：${parsed.asset.processingError}`);
      }
      continue;
    }
    // Explicitly unsupported binary types stay out of the prompt.
  }

  if (notices.length > 0) {
    userMessage += `\n\n[附件处理提示]\n${notices.map((notice) => `- ${notice}`).join('\n')}`;
  }

  return { userMessage, imageAttachments, pdfAttachments };
}
