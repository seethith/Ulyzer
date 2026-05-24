import {
  attachmentExt,
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
  isAttachmentXmindExt,
  isAttachmentXlsxExt,
} from '@shared/attachment-formats';
import { parse as parseDelimitedRecords } from 'csv-parse/sync';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type {
  DocumentAsset,
  DocumentBlock,
  DocumentBlockType,
  DocumentKind,
  DocumentUnit,
  DocumentUnitKind,
  ParseDocumentInput,
} from './document-types';
import { extractPdfTextLayer } from './pdf-text-layer';

export const DOCUMENT_PARSER_VERSION = 'document-v4';

const execFileAsync = promisify(execFile);

interface BlockEntry {
  type: DocumentBlockType;
  text: string;
  locator?: string;
  headingPath?: string[];
  metadata?: Record<string, unknown>;
}

function detectKind(input: Pick<ParseDocumentInput, 'fileName' | 'mimeType' | 'title'>): DocumentKind {
  const name = input.fileName || input.title;
  const ext = attachmentExt(name);
  const mime = (input.mimeType ?? '').toLowerCase();
  if (isAttachmentPdfExt(ext) || mime.includes('pdf')) return 'pdf';
  if (ext === '.docx' || mime.includes('wordprocessingml')) return 'docx';
  if (isAttachmentPptxExt(ext) || mime.includes('presentationml')) return 'pptx';
  if (isAttachmentXlsxExt(ext) || mime.includes('spreadsheetml')) return 'xlsx';
  if (isAttachmentRtfExt(ext) || mime.includes('rtf')) return 'rtf';
  if (isAttachmentEpubExt(ext) || mime.includes('epub')) return 'epub';
  if (isAttachmentOdtExt(ext) || mime.includes('opendocument.text')) return 'odt';
  if (isAttachmentOdsExt(ext) || mime.includes('opendocument.spreadsheet')) return 'ods';
  if (isAttachmentOdpExt(ext) || mime.includes('opendocument.presentation')) return 'odp';
  if (isAttachmentOpmlExt(ext) || mime.includes('opml')) return 'opml';
  if (isAttachmentMmExt(ext) || mime.includes('freemind')) return 'mm';
  if (isAttachmentXmindExt(ext) || mime.includes('xmind')) return 'xmind';
  if (isAttachmentImageExt(ext) || mime.startsWith('image/')) return 'image';
  if (ext === '.csv' || mime.includes('text/csv') || mime.includes('csv')) return 'csv';
  if (ext === '.tsv' || mime.includes('tab-separated-values') || mime.includes('text/tsv')) return 'tsv';
  if (ext === '.html' || ext === '.htm' || mime.includes('html')) return 'html';
  if (ext === '.md' || ext === '.markdown' || mime.includes('markdown')) return 'markdown';
  if (isAttachmentTextExt(ext) || mime.startsWith('text/')) return 'text';
  return 'unknown';
}

function unitKindForDocument(kind: DocumentKind): DocumentUnitKind {
  if (kind === 'pdf') return 'page';
  if (kind === 'pptx') return 'slide';
  if (kind === 'odp') return 'slide';
  if (kind === 'xlsx') return 'sheet';
  if (kind === 'ods') return 'sheet';
  if (kind === 'csv') return 'sheet';
  if (kind === 'tsv') return 'sheet';
  if (kind === 'image') return 'image';
  if (kind === 'html') return 'webpage';
  if (kind === 'epub') return 'section';
  if (kind === 'odt') return 'section';
  if (kind === 'rtf') return 'section';
  if (kind === 'opml') return 'section';
  if (kind === 'mm') return 'section';
  if (kind === 'xmind') return 'section';
  return 'text';
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeBlockText(text: string): string {
  return normalizeLineEndings(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeEntryText(entry: Pick<BlockEntry, 'text' | 'type'>): string {
  if (entry.type === 'code') {
    return normalizeLineEndings(entry.text)
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }
  return normalizeBlockText(entry.text);
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[key] ?? match;
  });
}

interface OfficeZipEntry {
  name: string;
  dir: boolean;
  async(type: 'string'): Promise<string>;
}

interface OfficeZip {
  files: Record<string, OfficeZipEntry>;
  file(path: string): OfficeZipEntry | null;
}

async function loadOfficeZip(buffer: Buffer): Promise<OfficeZip> {
  const JSZip = (await import('jszip')).default;
  return await JSZip.loadAsync(buffer) as OfficeZip;
}

async function zipText(zip: OfficeZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async('string') : null;
}

function decodeXmlText(text: string): string {
  return decodeHtmlEntities(text);
}

function parseXmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(tag)) !== null) {
    attrs[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function extractXmlTagSegments(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const segments: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) segments.push(match[1]);
  return segments;
}

interface XmlElement {
  openTag: string;
  content: string;
  attrs: Record<string, string>;
}

function extractXmlElements(xml: string, tagName: string): XmlElement[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<${escaped}\\b[^>]*>)([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const elements: XmlElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    elements.push({
      openTag: match[1],
      content: match[2],
      attrs: parseXmlAttributes(match[1]),
    });
  }
  return elements;
}

function extractXmlTags(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escaped}\\b[^>]*(?:\\/?>)`, 'gi');
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) tags.push(match[0]);
  return tags;
}

function extractXmlTextNodes(xml: string, localName = 't'): string[] {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, 'gi');
  const texts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const text = decodeXmlText(match[1].replace(/<[^>]+>/g, ''));
    if (text) texts.push(text);
  }
  return texts;
}

function xmlInnerText(xml: string): string {
  const expanded = xml
    .replace(/<(?:[\w.-]+:)?line-break\b[^>]*\/>/gi, '\n')
    .replace(/<(?:[\w.-]+:)?tab\b[^>]*\/>/gi, '\t')
    .replace(/<(?:[\w.-]+:)?s\b[^>]*(?:[\w.-]+:)?c="(\d+)"[^>]*\/>/gi, (_match, count: string) => ' '.repeat(Math.min(32, Number.parseInt(count, 10) || 1)))
    .replace(/<(?:[\w.-]+:)?s\b[^>]*\/>/gi, ' ');
  return normalizeBlockText(decodeXmlText(expanded.replace(/<[^>]+>/g, ' ')));
}

function firstHeadingText(entries: BlockEntry[], fallback: string): string {
  return entries.find((entry) => entry.type === 'title' || entry.type === 'heading')?.text ?? fallback;
}

function ocrStateForUnitText(kind: DocumentUnitKind, text: string): DocumentUnit['ocrState'] {
  if (text.trim()) return 'not_required';
  return kind === 'page' || kind === 'image' ? 'pending' : 'not_required';
}

interface SimpleXmlNode {
  name: string;
  localName: string;
  attrs: Record<string, string>;
  children: SimpleXmlNode[];
  text: string;
}

function localXmlName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

function parseSimpleXml(xml: string): SimpleXmlNode {
  const root: SimpleXmlNode = { name: '#document', localName: '#document', attrs: {}, children: [], text: '' };
  const stack: SimpleXmlNode[] = [root];
  const tagPattern = /<[^>]+>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(xml)) !== null) {
    const text = xml.slice(cursor, match.index);
    if (text) stack[stack.length - 1].text += decodeXmlText(text);
    cursor = tagPattern.lastIndex;

    const tag = match[0];
    if (/^<\?/.test(tag) || /^<!--/.test(tag) || /^<!/.test(tag)) continue;
    if (/^<\//.test(tag)) {
      const closingName = localXmlName(tag.replace(/^<\//, '').replace(/>$/, '').trim());
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const node = stack.pop();
        if (node?.localName === closingName) break;
      }
      continue;
    }

    const selfClosing = /\/>$/.test(tag);
    const inner = tag.slice(1, selfClosing ? -2 : -1).trim();
    const spaceIndex = inner.search(/\s/);
    const name = spaceIndex >= 0 ? inner.slice(0, spaceIndex) : inner;
    const node: SimpleXmlNode = {
      name,
      localName: localXmlName(name),
      attrs: parseXmlAttributes(tag),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  const tail = xml.slice(cursor);
  if (tail) stack[stack.length - 1].text += decodeXmlText(tail);
  return root;
}

function xmlChildren(node: SimpleXmlNode | undefined, localName: string): SimpleXmlNode[] {
  return node?.children.filter((child) => child.localName === localName) ?? [];
}

function xmlFirst(node: SimpleXmlNode | undefined, localName: string): SimpleXmlNode | undefined {
  return xmlChildren(node, localName)[0];
}

function xmlDescendants(node: SimpleXmlNode | undefined, localName: string): SimpleXmlNode[] {
  if (!node) return [];
  const found: SimpleXmlNode[] = [];
  const visit = (current: SimpleXmlNode) => {
    for (const child of current.children) {
      if (child.localName === localName) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function simpleXmlText(node: SimpleXmlNode | undefined): string {
  if (!node) return '';
  return normalizeBlockText([
    node.text,
    ...node.children.map((child) => simpleXmlText(child)),
  ].join(' '));
}

interface MindMapNode {
  id?: string;
  title: string;
  notes?: string;
  link?: string;
  labels?: string[];
  markers?: string[];
  children: MindMapNode[];
}

interface MindMapSection {
  title: string;
  roots: MindMapNode[];
}

function mindMapLines(nodes: MindMapNode[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const node of nodes) {
    const suffix = [
      node.labels?.length ? `标签：${node.labels.join('、')}` : '',
      node.markers?.length ? `标记：${node.markers.join('、')}` : '',
      node.link ? `链接：${node.link}` : '',
    ].filter(Boolean);
    lines.push(`${indent}- ${node.title}${suffix.length ? `（${suffix.join('；')}）` : ''}`);
    if (node.notes) lines.push(`${indent}  备注：${node.notes}`);
    lines.push(...mindMapLines(node.children, depth + 1));
  }
  return lines;
}

function mindMapSectionToUnit(input: ParseDocumentInput, section: MindMapSection, unitIndex: number, source: string): DocumentUnit {
  const lines = mindMapLines(section.roots);
  return createUnitFromEntries({
    unitIndex,
    kind: 'section',
    locator: `section ${unitIndex + 1}`,
    title: section.title || input.title,
    entries: [
      {
        type: 'heading',
        text: section.title || input.title,
        locator: `section ${unitIndex + 1} title`,
        metadata: { source },
      },
      ...(lines.length ? [{
        type: 'list' as const,
        text: lines.join('\n'),
        locator: `section ${unitIndex + 1} outline`,
        metadata: { source },
      }] : []),
    ],
    metadata: {
      source,
      nodeCount: countMindMapNodes(section.roots),
    },
  });
}

function countMindMapNodes(nodes: MindMapNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countMindMapNodes(node.children), 0);
}

function normalizeOfficePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolveOfficeTarget(baseFile: string, target: string): string {
  if (target.startsWith('/')) return normalizeOfficePath(target.slice(1));
  const baseDir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  return normalizeOfficePath(`${baseDir}${target}`);
}

function pathNumber(path: string): number {
  const match = path.match(/(\d+)(?=\.[^.]+$)/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function sortOfficePaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const byNumber = pathNumber(a) - pathNumber(b);
    return byNumber !== 0 ? byNumber : a.localeCompare(b);
  });
}

function stripHtmlTags(html: string): string {
  return normalizeBlockText(decodeHtmlEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')));
}

function blockTypeForHtmlTag(tag: string): DocumentBlockType {
  const normalized = tag.toLowerCase();
  if (/^h[1-6]$/.test(normalized)) return 'heading';
  if (normalized === 'li') return 'list';
  if (normalized === 'td' || normalized === 'th' || normalized === 'caption') return 'table';
  if (normalized === 'pre' || normalized === 'code') return 'code';
  return 'paragraph';
}

function splitParagraphBlocks(text: string, locatorPrefix: string, pageNumber?: number | null): DocumentBlock[] {
  const paragraphs = normalizeLineEndings(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0 && text.trim()) paragraphs.push(text.trim());

  let cursor = 0;
  return paragraphs.map((paragraph, index) => {
    const start = text.indexOf(paragraph, cursor);
    const charStart = start >= 0 ? start : cursor;
    cursor = charStart + paragraph.length;
    return {
      blockIndex: index,
      type: 'paragraph',
      locator: `${locatorPrefix} block ${index + 1}`,
      text: paragraph,
      pageNumber,
      charStart,
      charEnd: charStart + paragraph.length,
    };
  });
}

function createUnitFromEntries(input: {
  unitIndex: number;
  kind: DocumentUnitKind;
  locator: string;
  title?: string | null;
  pageNumber?: number | null;
  entries: BlockEntry[];
  metadata?: Record<string, unknown>;
}): DocumentUnit {
  const entries = input.entries
    .map((entry) => ({ ...entry, text: normalizeEntryText(entry) }))
    .filter((entry) => entry.text.length > 0);
  const text = entries.map((entry) => entry.text).join('\n\n');
  let cursor = 0;
  const blocks = entries.map((entry, index): DocumentBlock => {
    const start = text.indexOf(entry.text, cursor);
    const charStart = start >= 0 ? start : cursor;
    cursor = charStart + entry.text.length;
    return {
      blockIndex: index,
      type: entry.type,
      locator: entry.locator ?? `${input.locator} block ${index + 1}`,
      text: entry.text,
      headingPath: entry.headingPath?.length ? [...entry.headingPath] : undefined,
      pageNumber: input.pageNumber,
      charStart,
      charEnd: charStart + entry.text.length,
      metadata: entry.metadata,
    };
  });

  return {
    unitIndex: input.unitIndex,
    kind: input.kind,
    locator: input.locator,
    title: input.title ?? null,
    pageNumber: input.pageNumber ?? null,
    text,
    charCount: text.trim().length,
    ocrState: ocrStateForUnitText(input.kind, text),
    metadata: input.metadata,
    blocks,
  };
}

function createUnit(input: {
  unitIndex: number;
  kind: DocumentUnitKind;
  locator: string;
  title?: string | null;
  pageNumber?: number | null;
  text: string;
  metadata?: Record<string, unknown>;
}): DocumentUnit {
  return {
    unitIndex: input.unitIndex,
    kind: input.kind,
    locator: input.locator,
    title: input.title ?? null,
    pageNumber: input.pageNumber ?? null,
    text: input.text,
    charCount: input.text.trim().length,
    ocrState: ocrStateForUnitText(input.kind, input.text),
    metadata: input.metadata,
    blocks: splitParagraphBlocks(input.text, input.locator, input.pageNumber),
  };
}

function parseHtmlEntries(html: string, locatorPrefix: string): BlockEntry[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const body = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? cleaned;
  const entries: BlockEntry[] = [];
  const headingPath: string[] = [];
  const tagPattern = /<(h[1-6]|p|li|blockquote|pre|code|td|th|caption|title)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(body)) !== null) {
    const tag = match[1].toLowerCase();
    const text = stripHtmlTags(match[2]);
    if (!text) continue;
    const type = blockTypeForHtmlTag(tag);
    if (type === 'heading') {
      const level = Number.parseInt(tag.slice(1), 10);
      headingPath.splice(level - 1);
      headingPath[level - 1] = text;
      entries.push({
        type,
        text,
        locator: `${locatorPrefix} heading ${entries.length + 1}`,
        headingPath: headingPath.filter(Boolean),
        metadata: { htmlTag: tag },
      });
      continue;
    }
    entries.push({
      type,
      text,
      locator: `${locatorPrefix} ${type} ${entries.length + 1}`,
      headingPath: headingPath.filter(Boolean),
      metadata: { htmlTag: tag },
    });
  }

  if (entries.length === 0) {
    const text = stripHtmlTags(body);
    if (text) entries.push({ type: 'paragraph', text, locator: `${locatorPrefix} text 1` });
  }
  return entries;
}

function parseHtmlUnits(input: ParseDocumentInput, html: string, options?: {
  unitKind?: DocumentUnitKind;
  locator?: string;
  metadata?: Record<string, unknown>;
}): DocumentUnit[] {
  const locator = options?.locator ?? 'webpage 1';
  return [createUnitFromEntries({
    unitIndex: 0,
    kind: options?.unitKind ?? 'webpage',
    locator,
    title: input.title,
    entries: parseHtmlEntries(html, locator),
    metadata: options?.metadata ?? { source: 'html_blocks' },
  })];
}

function parseMarkdownEntries(markdown: string, locatorPrefix: string): BlockEntry[] {
  const lines = normalizeLineEndings(markdown).split('\n');
  const entries: BlockEntry[] = [];
  const headingPath: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let table: string[] = [];
  let code: string[] | null = null;

  const currentHeadingPath = () => headingPath.filter(Boolean);
  const pushEntry = (type: DocumentBlockType, text: string, metadata?: Record<string, unknown>) => {
    const normalized = normalizeEntryText({ type, text });
    if (!normalized) return;
    entries.push({
      type,
      text: normalized,
      locator: `${locatorPrefix} ${type} ${entries.length + 1}`,
      headingPath: currentHeadingPath(),
      metadata,
    });
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      pushEntry('paragraph', paragraph.join('\n'));
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      pushEntry('list', list.join('\n'));
      list = [];
    }
  };
  const flushTable = () => {
    if (table.length > 0) {
      pushEntry('table', table.join('\n'));
      table = [];
    }
  };
  const flushAllText = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        pushEntry('code', code.join('\n'), { markdown: 'fenced_code' });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushAllText();
      code = [];
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAllText();
      const level = heading[1].length;
      const text = heading[2].trim();
      headingPath.splice(level - 1);
      headingPath[level - 1] = text;
      pushEntry('heading', text, { markdown: 'heading', level });
      continue;
    }

    if (!line.trim()) {
      flushAllText();
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      flushTable();
      list.push(line.trim());
      continue;
    }

    if (line.includes('|') && /^\s*\|?.+\|.+/.test(line)) {
      flushParagraph();
      flushList();
      table.push(line.trim());
      continue;
    }

    flushList();
    flushTable();
    paragraph.push(line);
  }

  if (code) pushEntry('code', code.join('\n'), { markdown: 'fenced_code_unclosed' });
  flushAllText();
  if (entries.length === 0 && markdown.trim()) pushEntry('paragraph', markdown);
  return entries;
}

function parseMarkdownUnits(input: ParseDocumentInput, text: string): DocumentUnit[] {
  return [createUnitFromEntries({
    unitIndex: 0,
    kind: 'section',
    locator: 'section 1',
    title: input.title,
    entries: parseMarkdownEntries(text, 'section 1'),
    metadata: { source: 'markdown_blocks' },
  })];
}

async function parsePdf(input: ParseDocumentInput, buffer?: Buffer): Promise<DocumentUnit[]> {
  if (input.filePath) {
    try {
      const extracted = await extractPdfTextLayer(input.filePath);
      if (extracted.pageCount > 0 || extracted.pages.length > 0) {
        return extracted.pages.map((page, index) => createUnit({
          unitIndex: index,
          kind: 'page',
          locator: `page ${page.page}`,
          pageNumber: page.page,
          title: `${input.title} p.${page.page}`,
          text: page.text ?? '',
          metadata: {
            source: 'pdfkit_text_layer',
            pageCount: extracted.pageCount,
            encrypted: extracted.encrypted,
          },
        }));
      }
    } catch {
      // Fall back to pdf-parse below; PDFKit is a fast path, not the only parser.
    }
  }

  const pdfBuffer = buffer ?? (input.filePath ? await readFile(input.filePath) : undefined);
  if (!pdfBuffer) throw new Error('PDF 文件内容为空，无法解析。');
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const parsed = await parser.getText();
    return parsed.pages.map((page, index) => createUnit({
      unitIndex: index,
      kind: 'page',
      locator: `page ${page.num}`,
      pageNumber: page.num,
      title: `${input.title} p.${page.num}`,
      text: page.text ?? '',
      metadata: { source: 'pdf_text_layer' },
    }));
  } finally {
    await parser.destroy();
  }
}

function pptxSlideEntries(xml: string, slideNumber: number): BlockEntry[] {
  const paragraphTexts = extractXmlTagSegments(xml, 'a:p')
    .map((segment) => normalizeBlockText(extractXmlTextNodes(segment).join('')))
    .filter(Boolean);
  const texts = paragraphTexts.length > 0
    ? paragraphTexts
    : [normalizeBlockText(extractXmlTextNodes(xml).join('\n'))].filter(Boolean);
  const entries = texts.map((text, index): BlockEntry => ({
    type: index === 0 && text.length <= 160 ? 'title' : 'paragraph',
    text,
    locator: `slide ${slideNumber} text ${index + 1}`,
  }));

  const imageEntries: BlockEntry[] = [];
  const imagePattern = /<p:cNvPr\b[^>]*(?:\/>|>[\s\S]*?<\/p:cNvPr>)/gi;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[0]);
    const descr = normalizeBlockText(attrs.descr ?? '');
    const name = normalizeBlockText(attrs.name ?? '');
    const imageText = descr || (/^(picture|image)\s*\d*$/i.test(name) ? '' : name);
    if (!imageText) continue;
    imageEntries.push({
      type: 'image',
      text: imageText,
      locator: `slide ${slideNumber} image ${imageEntries.length + 1}`,
      metadata: { name: name || undefined },
    });
  }

  return [...entries, ...imageEntries];
}

async function parsePptx(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const slidePaths = sortOfficePaths(Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path) && !zip.files[path].dir));
  if (slidePaths.length === 0) throw new Error('PPTX 文件中没有找到可解析的幻灯片。');

  const units: DocumentUnit[] = [];
  for (const slidePath of slidePaths) {
    const slideNumber = pathNumber(slidePath);
    const xml = await zipText(zip, slidePath);
    if (!xml) continue;
    const entries = pptxSlideEntries(xml, slideNumber);
    const notesXml = await zipText(zip, `ppt/notesSlides/notesSlide${slideNumber}.xml`);
    if (notesXml) {
      const notes = normalizeBlockText(extractXmlTextNodes(notesXml).join('\n'));
      if (notes) {
        entries.push({
          type: 'metadata',
          text: `演讲者备注\n${notes}`,
          locator: `slide ${slideNumber} notes`,
          metadata: { source: 'pptx_notes' },
        });
      }
    }
    const title = entries.find((entry) => entry.type === 'title')?.text ?? `${input.title} slide ${slideNumber}`;
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'slide',
      locator: `slide ${slideNumber}`,
      title,
      entries,
      metadata: { source: 'openxml_pptx', path: slidePath },
    }));
  }

  if (units.length === 0) throw new Error('PPTX 文件没有提取到可用幻灯片内容。');
  return units;
}

interface XlsxSheetInfo {
  name: string;
  path: string;
  sheetId?: string;
}

function columnIndexFromRef(ref: string): number {
  const letters = (ref.match(/[A-Z]+/i)?.[0] ?? '').toUpperCase();
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return Math.max(index - 1, 0);
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}

function rowNumberFromRef(ref: string): number {
  const match = ref.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : 1;
}

async function parseXlsxSharedStrings(zip: OfficeZip): Promise<string[]> {
  const xml = await zipText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return extractXmlTagSegments(xml, 'si')
    .map((segment) => normalizeBlockText(extractXmlTextNodes(segment).join('')))
    .map((text) => text.trim());
}

async function parseXlsxSheets(zip: OfficeZip): Promise<XlsxSheetInfo[]> {
  const workbookXml = await zipText(zip, 'xl/workbook.xml');
  if (!workbookXml) {
    return sortOfficePaths(Object.keys(zip.files)
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path) && !zip.files[path].dir))
      .map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
  }

  const relsXml = await zipText(zip, 'xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relsXml) {
    const relPattern = /<Relationship\b[^>]*(?:\/>|>[\s\S]*?<\/Relationship>)/gi;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relPattern.exec(relsXml)) !== null) {
      const attrs = parseXmlAttributes(relMatch[0]);
      if (attrs.Id && attrs.Target) rels.set(attrs.Id, resolveOfficeTarget('xl/workbook.xml', attrs.Target));
    }
  }

  const sheetPattern = /<sheet\b[^>]*(?:\/>|>[\s\S]*?<\/sheet>)/gi;
  const sheets: XlsxSheetInfo[] = [];
  let match: RegExpExecArray | null;
  while ((match = sheetPattern.exec(workbookXml)) !== null) {
    const attrs = parseXmlAttributes(match[0]);
    const relId = attrs['r:id'] ?? attrs.id;
    const path = relId && rels.has(relId)
      ? rels.get(relId)!
      : `xl/worksheets/sheet${attrs.sheetId ?? sheets.length + 1}.xml`;
    sheets.push({
      name: attrs.name || `Sheet ${sheets.length + 1}`,
      path,
      sheetId: attrs.sheetId,
    });
  }
  return sheets;
}

function extractXlsxCellValue(cellXml: string, attrs: Record<string, string>, sharedStrings: string[]): string {
  const rawValue = extractXmlTextNodes(cellXml, 'v')[0] ?? '';
  const inline = normalizeBlockText(extractXmlTextNodes(cellXml, 't').join(''));
  const formula = normalizeBlockText(extractXmlTextNodes(cellXml, 'f').join(''));
  const type = attrs.t;
  let value = '';

  if (type === 's') {
    const index = Number.parseInt(rawValue, 10);
    value = Number.isFinite(index) ? sharedStrings[index] ?? rawValue : rawValue;
  } else if (type === 'inlineStr') {
    value = inline;
  } else if (type === 'b') {
    value = rawValue === '1' ? 'TRUE' : rawValue === '0' ? 'FALSE' : rawValue;
  } else if (type === 'str') {
    value = inline || rawValue;
  } else {
    value = rawValue || inline;
  }

  value = normalizeBlockText(value);
  if (formula) return value ? `${value} (= ${formula})` : `= ${formula}`;
  return value;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

interface StructuredTableCell {
  rowIndex: number;
  columnIndex: number;
  rowNumber: number;
  columnName: string;
  header?: string;
  address?: string;
  text: string;
  valueType: 'empty' | 'number' | 'boolean' | 'date' | 'formula' | 'text';
}

interface StructuredTableMetadata {
  version: 1;
  sourceFormat: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'odf';
  delimiter?: 'comma' | 'tab';
  hasHeader?: boolean;
  headers: string[];
  rowCount: number;
  columnCount: number;
  startRow: number;
  endRow: number;
  cellCount: number;
  capturedCellCount: number;
  truncatedCells: boolean;
  cells: StructuredTableCell[];
}

const TABLE_METADATA_CELL_LIMIT = 5000;

function inferTableValueType(text: string): StructuredTableCell['valueType'] {
  const value = text.trim();
  if (!value) return 'empty';
  if (value.startsWith('=')) return 'formula';
  if (/\(=\s*[^)]+\)$/.test(value)) return 'formula';
  if (/^(true|false)$/i.test(value)) return 'boolean';
  if (/^-?\d+(?:\.\d+)?%?$/.test(value.replace(/,/g, ''))) return 'number';
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(value)) return 'date';
  return 'text';
}

function rowMapShape(rows: Map<number, Map<number, string>>): {
  rowNumbers: number[];
  columns: number[];
} {
  const rowNumbers = [...rows.keys()].sort((a, b) => a - b);
  const usedCols = new Set<number>();
  for (const row of rows.values()) {
    for (const col of row.keys()) usedCols.add(col);
  }
  return {
    rowNumbers,
    columns: [...usedCols].sort((a, b) => a - b),
  };
}

function structuredTableFromRowMap(input: {
  rows: Map<number, Map<number, string>>;
  sourceFormat: StructuredTableMetadata['sourceFormat'];
  headers?: string[];
  hasHeader?: boolean;
  delimiter?: StructuredTableMetadata['delimiter'];
}): StructuredTableMetadata {
  const { rowNumbers, columns } = rowMapShape(input.rows);
  const headers = columns.map((col, index) => input.headers?.[index]?.trim() || columnName(col));
  const cellCount = rowNumbers.reduce((sum, rowNumber) => sum + (input.rows.get(rowNumber)?.size ?? 0), 0);
  const cells: StructuredTableCell[] = [];

  for (const [rowIndex, rowNumber] of rowNumbers.entries()) {
    const row = input.rows.get(rowNumber)!;
    for (const [columnIndex, col] of columns.entries()) {
      const text = row.get(col) ?? '';
      if (!text.trim()) continue;
      if (cells.length < TABLE_METADATA_CELL_LIMIT) {
        cells.push({
          rowIndex,
          columnIndex,
          rowNumber,
          columnName: columnName(col),
          header: headers[columnIndex],
          address: `${columnName(col)}${rowNumber}`,
          text,
          valueType: inferTableValueType(text),
        });
      }
    }
  }

  return {
    version: 1,
    sourceFormat: input.sourceFormat,
    delimiter: input.delimiter,
    hasHeader: input.hasHeader,
    headers,
    rowCount: rowNumbers.length,
    columnCount: columns.length,
    startRow: rowNumbers[0] ?? 0,
    endRow: rowNumbers[rowNumbers.length - 1] ?? 0,
    cellCount,
    capturedCellCount: cells.length,
    truncatedCells: cells.length < cellCount,
    cells,
  };
}

function xlsxRowsToText(rows: Map<number, Map<number, string>>): string {
  const { rowNumbers, columns: cols } = rowMapShape(rows);
  if (rowNumbers.length === 0) return '';
  if (cols.length === 0) return '';

  if (cols.length <= 20) {
    const headers = ['行', ...cols.map(columnName)];
    const lines = [
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
    ];
    for (const rowNumber of rowNumbers) {
      const row = rows.get(rowNumber)!;
      lines.push(`| ${[String(rowNumber), ...cols.map((col) => escapeMarkdownCell(row.get(col) ?? ''))].join(' | ')} |`);
    }
    return lines.join('\n');
  }

  return rowNumbers
    .map((rowNumber) => {
      const row = rows.get(rowNumber)!;
      const cells = [...row.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([col, value]) => `${columnName(col)}${rowNumber}: ${value}`);
      return `Row ${rowNumber}: ${cells.join(' | ')}`;
    })
    .join('\n');
}

const DELIMITED_TEXT_ROWS_PER_UNIT = 300;

function delimitedText(input: ParseDocumentInput, buffer?: Buffer): string {
  return normalizeLineEndings(input.text ?? buffer?.toString('utf8') ?? '').replace(/^\uFEFF/, '');
}

function normalizeDelimitedCell(value: unknown): string {
  return normalizeBlockText(String(value ?? ''));
}

function inferDelimitedHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0].filter(Boolean);
  if (first.length === 0) return false;
  const hasNameLikeCell = first.some((cell) => /[A-Za-z_\u4e00-\u9fff]/.test(cell));
  if (!hasNameLikeCell) return false;
  const sameAsNext = rows[0].every((cell, index) => cell === (rows[1][index] ?? ''));
  return !sameAsNext;
}

function delimitedColumnHeaders(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `列${index + 1}`);
}

function normalizeDelimitedRows(records: unknown[][]): string[][] {
  return records
    .map((row) => row.map(normalizeDelimitedCell))
    .filter((row) => row.some((cell) => cell.trim()));
}

function delimitedRowsToText(input: {
  headers: string[];
  rows: string[][];
  startRowNumber: number;
}): string {
  const columnCount = Math.max(
    input.headers.length,
    ...input.rows.map((row) => row.length),
  );
  if (columnCount === 0 || input.rows.length === 0) return '';
  const headers = Array.from({ length: columnCount }, (_value, index) =>
    input.headers[index]?.trim() || `列${index + 1}`);

  if (columnCount <= 20) {
    const tableHeaders = ['行', ...headers];
    const lines = [
      `| ${tableHeaders.map(escapeMarkdownCell).join(' | ')} |`,
      `| ${tableHeaders.map(() => '---').join(' | ')} |`,
    ];
    input.rows.forEach((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_value, index) => escapeMarkdownCell(row[index] ?? ''));
      lines.push(`| ${[String(input.startRowNumber + rowIndex), ...cells].join(' | ')} |`);
    });
    return lines.join('\n');
  }

  return input.rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_value, index) => {
        const value = row[index]?.trim();
        return value ? `${headers[index]}: ${value}` : '';
      }).filter(Boolean);
      return `Row ${input.startRowNumber + rowIndex}: ${cells.join(' | ')}`;
    })
    .join('\n');
}

function rowMapFromDelimitedRows(rows: string[][], startRowNumber: number): Map<number, Map<number, string>> {
  const map = new Map<number, Map<number, string>>();
  rows.forEach((row, rowIndex) => {
    const rowNumber = startRowNumber + rowIndex;
    const rowMap = new Map<number, string>();
    row.forEach((value, columnIndex) => {
      if (value.trim()) rowMap.set(columnIndex, value);
    });
    if (rowMap.size > 0) map.set(rowNumber, rowMap);
  });
  return map;
}

function parseDelimitedText(input: ParseDocumentInput, kind: 'csv' | 'tsv', buffer?: Buffer): DocumentUnit[] {
  const text = delimitedText(input, buffer);
  const delimiter = kind === 'tsv' ? '\t' : ',';
  const records = parseDelimitedRecords(text, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  }) as unknown[][];
  const rows = normalizeDelimitedRows(records);
  if (rows.length === 0) throw new Error(`${kind.toUpperCase()} 文件没有提取到可用表格内容。`);

  const hasHeader = inferDelimitedHeader(rows);
  const maxColumns = Math.max(...rows.map((row) => row.length));
  const headers = hasHeader
    ? Array.from({ length: maxColumns }, (_value, index) => rows[0][index]?.trim() || `列${index + 1}`)
    : delimitedColumnHeaders(maxColumns);
  let dataRows = hasHeader ? rows.slice(1) : rows;
  let firstDataRowNumber = hasHeader ? 2 : 1;
  if (dataRows.length === 0) {
    dataRows = rows;
    firstDataRowNumber = 1;
  }

  const units: DocumentUnit[] = [];
  for (let offset = 0; offset < dataRows.length; offset += DELIMITED_TEXT_ROWS_PER_UNIT) {
    const chunk = dataRows.slice(offset, offset + DELIMITED_TEXT_ROWS_PER_UNIT);
    const startRow = firstDataRowNumber + offset;
    const endRow = startRow + chunk.length - 1;
    const locator = dataRows.length > DELIMITED_TEXT_ROWS_PER_UNIT
      ? `rows ${startRow}-${endRow}`
      : 'sheet 1';
    const text = delimitedRowsToText({ headers, rows: chunk, startRowNumber: startRow });
    const table = structuredTableFromRowMap({
      rows: rowMapFromDelimitedRows(chunk, startRow),
      sourceFormat: kind,
      delimiter: kind === 'tsv' ? 'tab' : 'comma',
      hasHeader,
      headers,
    });
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'sheet',
      locator,
      title: units.length === 0 ? input.title : `${input.title} rows ${startRow}-${endRow}`,
      entries: text ? [{
        type: 'table',
        text,
        locator: `${locator} table 1`,
        metadata: {
          source: 'delimited_text_table',
          table,
        },
      }] : [],
      metadata: {
        source: 'delimited_text_table',
        delimiter: kind === 'tsv' ? 'tab' : 'comma',
        hasHeader,
        headers,
        rowCount: rows.length,
        dataRowCount: dataRows.length,
        columnCount: maxColumns,
        startRow,
        endRow,
      },
    }));
  }

  return units;
}

async function parseXlsx(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const sharedStrings = await parseXlsxSharedStrings(zip);
  const sheets = await parseXlsxSheets(zip);
  if (sheets.length === 0) throw new Error('XLSX 文件中没有找到可解析的工作表。');

  const units: DocumentUnit[] = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    const rows = new Map<number, Map<number, string>>();
    const cellPattern = /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi;
    let match: RegExpExecArray | null;
    while ((match = cellPattern.exec(xml)) !== null) {
      const cellXml = match[0];
      const openTag = cellXml.match(/^<c\b[^>]*>/i)?.[0] ?? cellXml;
      const attrs = parseXmlAttributes(openTag);
      const ref = attrs.r ?? '';
      const rowNumber = rowNumberFromRef(ref);
      const colIndex = columnIndexFromRef(ref);
      const value = extractXlsxCellValue(cellXml, attrs, sharedStrings);
      if (!value) continue;
      if (!rows.has(rowNumber)) rows.set(rowNumber, new Map());
      rows.get(rowNumber)!.set(colIndex, value);
    }

    const text = xlsxRowsToText(rows);
    const table = structuredTableFromRowMap({
      rows,
      sourceFormat: 'xlsx',
      headers: rowMapShape(rows).columns.map(columnName),
    });
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'sheet',
      locator: `sheet ${units.length + 1}`,
      title: sheet.name,
      entries: text ? [{
        type: 'table',
        text,
        locator: `sheet ${units.length + 1} table 1`,
        metadata: {
          source: 'openxml_xlsx',
          table,
        },
      }] : [],
      metadata: {
        source: 'openxml_xlsx',
        path: sheet.path,
        documentTitle: input.title,
        sheetId: sheet.sheetId,
        rowCount: rows.size,
      },
    }));
  }

  if (units.length === 0) throw new Error('XLSX 文件没有提取到可用工作表内容。');
  return units;
}

function rtfFallbackText(rtf: string): string {
  const text = normalizeLineEndings(rtf)
    .replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex: string) => Buffer.from(hex, 'hex').toString('latin1'))
    .replace(/\\u(-?\d+)\??/g, (_match, value: string) => {
      let code = Number.parseInt(value, 10);
      if (code < 0) code += 65536;
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/\\(?:par|line)\b\s?/g, '\n')
    .replace(/\\tab\b\s?/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/\\[^a-zA-Z0-9]/g, '')
    .replace(/[{}]/g, ' ');
  return normalizeBlockText(text);
}

async function convertRtfToHtml(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('textutil', ['-convert', 'html', '-stdout', filePath], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const html = String(stdout ?? '').trim();
    return html || null;
  } catch {
    return null;
  }
}

async function parseRtf(input: ParseDocumentInput, buffer?: Buffer): Promise<DocumentUnit[]> {
  if (input.filePath) {
    const html = await convertRtfToHtml(input.filePath);
    if (html) {
      return parseHtmlUnits(input, html, {
        unitKind: 'section',
        locator: 'section 1',
        metadata: { source: 'macos_textutil_html' },
      });
    }
  }

  if (buffer) {
    const dir = await mkdtemp(join(tmpdir(), 'ulyzer-rtf-'));
    const filePath = join(dir, 'input.rtf');
    try {
      await writeFile(filePath, buffer);
      const html = await convertRtfToHtml(filePath);
      if (html) {
        return parseHtmlUnits(input, html, {
          unitKind: 'section',
          locator: 'section 1',
          metadata: { source: 'macos_textutil_html' },
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const text = rtfFallbackText(input.text ?? buffer?.toString('utf8') ?? '');
  return [createUnit({
    unitIndex: 0,
    kind: 'section',
    locator: 'section 1',
    title: input.title,
    text,
    metadata: { source: 'rtf_control_word_fallback' },
  })];
}

interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

async function parseEpub(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const containerXml = await zipText(zip, 'META-INF/container.xml');
  const rootfileTag = containerXml ? extractXmlTags(containerXml, 'rootfile')[0] : null;
  const rootPath = rootfileTag
    ? parseXmlAttributes(rootfileTag)['full-path']
    : Object.keys(zip.files).find((path) => /\.opf$/i.test(path));
  if (!rootPath) throw new Error('EPUB 文件中没有找到 OPF 目录文件。');

  const opfXml = await zipText(zip, rootPath);
  if (!opfXml) throw new Error('EPUB OPF 目录文件为空，无法解析。');
  const manifest = new Map<string, EpubManifestItem>();
  for (const tag of extractXmlTags(opfXml, 'item')) {
    const attrs = parseXmlAttributes(tag);
    if (!attrs.id || !attrs.href) continue;
    manifest.set(attrs.id, {
      id: attrs.id,
      href: attrs.href,
      mediaType: attrs['media-type'] ?? '',
    });
  }

  const spineIds = extractXmlTags(opfXml, 'itemref')
    .map((tag) => parseXmlAttributes(tag).idref)
    .filter(Boolean);
  const chapterPaths = spineIds
    .map((id) => manifest.get(id))
    .filter((item): item is EpubManifestItem => Boolean(item))
    .filter((item) => /xhtml|html/i.test(item.mediaType) || /\.(xhtml|html?)$/i.test(item.href))
    .map((item) => resolveOfficeTarget(rootPath, item.href));
  const fallbackPaths = sortOfficePaths(Object.keys(zip.files)
    .filter((path) => /\.(xhtml|html?)$/i.test(path) && !zip.files[path].dir));
  const paths = chapterPaths.length > 0 ? chapterPaths : fallbackPaths;
  if (paths.length === 0) throw new Error('EPUB 文件中没有找到可解析的 XHTML/HTML 章节。');

  const bookTitle = normalizeBlockText(extractXmlTextNodes(opfXml, 'title').join(' '));
  const units: DocumentUnit[] = [];
  for (const path of paths) {
    const html = await zipText(zip, path);
    if (!html) continue;
    const locator = `section ${units.length + 1}`;
    const entries = parseHtmlEntries(html, locator);
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'section',
      locator,
      title: firstHeadingText(entries, bookTitle || path.split('/').pop() || input.title),
      entries,
      metadata: { source: 'epub_xhtml', path },
    }));
  }

  if (units.length === 0) throw new Error('EPUB 文件没有提取到可用章节内容。');
  return units;
}

function odfTextEntries(xml: string, locatorPrefix: string): BlockEntry[] {
  const body = xml.match(/<office:(?:text|presentation|body)\b[^>]*>([\s\S]*?)<\/office:(?:text|presentation|body)>/i)?.[1] ?? xml;
  const entries: BlockEntry[] = [];
  const headingPath: string[] = [];
  const textPattern = /<(text:h|text:p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(body)) !== null) {
    const tag = match[1];
    const attrs = parseXmlAttributes(match[0]);
    const text = xmlInnerText(match[3]);
    if (!text) continue;
    if (tag === 'text:h') {
      const level = Number.parseInt(attrs['text:outline-level'] ?? '1', 10);
      headingPath.splice(Math.max(level - 1, 0));
      headingPath[Math.max(level - 1, 0)] = text;
      entries.push({
        type: 'heading',
        text,
        locator: `${locatorPrefix} heading ${entries.length + 1}`,
        headingPath: headingPath.filter(Boolean),
        metadata: { source: 'odf_heading', level },
      });
    } else {
      entries.push({
        type: 'paragraph',
        text,
        locator: `${locatorPrefix} paragraph ${entries.length + 1}`,
        headingPath: headingPath.filter(Boolean),
        metadata: { source: 'odf_paragraph' },
      });
    }
  }

  for (const table of extractXmlElements(body, 'table:table')) {
    const rows = odfTableRows(table.content);
    const tableText = xlsxRowsToText(rows);
    if (!tableText) continue;
    const structuredTable = structuredTableFromRowMap({
      rows,
      sourceFormat: 'odf',
      headers: rowMapShape(rows).columns.map(columnName),
    });
    entries.push({
      type: 'table',
      text: tableText,
      locator: `${locatorPrefix} table ${entries.length + 1}`,
      headingPath: headingPath.filter(Boolean),
      metadata: {
        source: 'odf_table',
        name: table.attrs['table:name'],
        table: structuredTable,
      },
    });
  }

  if (entries.length === 0) {
    const text = xmlInnerText(body);
    if (text) entries.push({ type: 'paragraph', text, locator: `${locatorPrefix} text 1` });
  }
  return entries;
}

function repeatedCount(attrs: Record<string, string>, key: string): number {
  const value = Number.parseInt(attrs[key] ?? '1', 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, 200);
}

function odfCellText(cell: XmlElement): string {
  const attrs = cell.attrs;
  return normalizeBlockText(
    xmlInnerText(cell.content) ||
    attrs['office:string-value'] ||
    attrs['office:value'] ||
    attrs['office:date-value'] ||
    attrs['office:time-value'] ||
    attrs['office:boolean-value'] ||
    '',
  );
}

function odfTableRows(tableXml: string): Map<number, Map<number, string>> {
  const rows = new Map<number, Map<number, string>>();
  let rowNumber = 1;
  for (const row of extractXmlElements(tableXml, 'table:table-row')) {
    const rowRepeat = repeatedCount(row.attrs, 'table:number-rows-repeated');
    const cells = extractXmlElements(row.content, 'table:table-cell');
    const values: string[] = [];
    for (const cell of cells) {
      const value = odfCellText(cell);
      const repeat = repeatedCount(cell.attrs, 'table:number-columns-repeated');
      for (let i = 0; i < repeat; i += 1) values.push(value);
    }
    const hasText = values.some((value) => value.trim());
    if (!hasText) {
      rowNumber += rowRepeat;
      continue;
    }
    for (let repeatIndex = 0; repeatIndex < rowRepeat; repeatIndex += 1) {
      const rowMap = new Map<number, string>();
      values.forEach((value, index) => {
        if (value.trim()) rowMap.set(index, value);
      });
      if (rowMap.size > 0) rows.set(rowNumber, rowMap);
      rowNumber += 1;
    }
  }
  return rows;
}

async function parseOdt(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const contentXml = await zipText(zip, 'content.xml');
  if (!contentXml) throw new Error('ODT 文件中没有找到 content.xml。');
  const entries = odfTextEntries(contentXml, 'section 1');
  return [createUnitFromEntries({
    unitIndex: 0,
    kind: 'section',
    locator: 'section 1',
    title: firstHeadingText(entries, input.title),
    entries,
    metadata: { source: 'odf_text', path: 'content.xml' },
  })];
}

async function parseOds(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const contentXml = await zipText(zip, 'content.xml');
  if (!contentXml) throw new Error('ODS 文件中没有找到 content.xml。');
  const tables = extractXmlElements(contentXml, 'table:table');
  if (tables.length === 0) throw new Error('ODS 文件中没有找到可解析的工作表。');

  const units: DocumentUnit[] = [];
  for (const table of tables) {
    const rows = odfTableRows(table.content);
    const text = xlsxRowsToText(rows);
    const structuredTable = structuredTableFromRowMap({
      rows,
      sourceFormat: 'ods',
      headers: rowMapShape(rows).columns.map(columnName),
    });
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'sheet',
      locator: `sheet ${units.length + 1}`,
      title: table.attrs['table:name'] || `Sheet ${units.length + 1}`,
      entries: text ? [{
        type: 'table',
        text,
        locator: `sheet ${units.length + 1} table 1`,
        metadata: {
          source: 'odf_spreadsheet',
          table: structuredTable,
        },
      }] : [],
      metadata: {
        source: 'odf_spreadsheet',
        documentTitle: input.title,
        rowCount: rows.size,
      },
    }));
  }

  if (units.length === 0) throw new Error('ODS 文件没有提取到可用工作表内容。');
  return units;
}

async function parseOdp(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const contentXml = await zipText(zip, 'content.xml');
  if (!contentXml) throw new Error('ODP 文件中没有找到 content.xml。');
  const pages = extractXmlElements(contentXml, 'draw:page');
  if (pages.length === 0) throw new Error('ODP 文件中没有找到可解析的幻灯片。');

  const units: DocumentUnit[] = [];
  for (const page of pages) {
    const slideNumber = units.length + 1;
    const entries = odfTextEntries(page.content, `slide ${slideNumber}`);
    const desc = normalizeBlockText(extractXmlTextNodes(page.content, 'desc').join('\n'));
    if (desc) {
      entries.push({
        type: 'image',
        text: desc,
        locator: `slide ${slideNumber} image description`,
        metadata: { source: 'odf_svg_desc' },
      });
    }
    units.push(createUnitFromEntries({
      unitIndex: units.length,
      kind: 'slide',
      locator: `slide ${slideNumber}`,
      title: firstHeadingText(entries, page.attrs['draw:name'] || `${input.title} slide ${slideNumber}`),
      entries,
      metadata: {
        source: 'odf_presentation',
        name: page.attrs['draw:name'],
      },
    }));
  }

  if (units.length === 0) throw new Error('ODP 文件没有提取到可用幻灯片内容。');
  return units;
}

function opmlNodeFromOutline(node: SimpleXmlNode): MindMapNode | null {
  const title = normalizeBlockText(node.attrs.text || node.attrs.title || simpleXmlText(node));
  if (!title) return null;
  const link = node.attrs.url || node.attrs.htmlUrl || node.attrs.xmlUrl || node.attrs.link;
  const notes = normalizeBlockText(node.attrs._note || node.attrs.note || node.attrs.description || '');
  const labels = [node.attrs.type, node.attrs.category].filter(Boolean);
  return {
    id: node.attrs.id,
    title,
    notes: notes || undefined,
    link: link || undefined,
    labels: labels.length ? labels : undefined,
    children: xmlChildren(node, 'outline').map(opmlNodeFromOutline).filter((child): child is MindMapNode => Boolean(child)),
  };
}

function parseOpml(input: ParseDocumentInput, text: string): DocumentUnit[] {
  const root = parseSimpleXml(text);
  const opml = xmlDescendants(root, 'opml')[0] ?? root;
  const head = xmlFirst(opml, 'head');
  const title = simpleXmlText(xmlFirst(head, 'title')) || input.title;
  const body = xmlFirst(opml, 'body') ?? opml;
  const roots = xmlChildren(body, 'outline')
    .map(opmlNodeFromOutline)
    .filter((node): node is MindMapNode => Boolean(node));
  if (roots.length === 0) throw new Error('OPML 文件中没有找到可解析的大纲节点。');
  return [mindMapSectionToUnit(input, { title, roots }, 0, 'opml_outline')];
}

function freemindNodeText(node: SimpleXmlNode): string {
  const attrText = normalizeBlockText(node.attrs.TEXT || node.attrs.text || node.attrs.LABEL || node.attrs.label || '');
  if (attrText) return attrText;
  const richNode = xmlChildren(node, 'richcontent')
    .find((child) => (child.attrs.TYPE || child.attrs.type || '').toUpperCase() === 'NODE');
  return simpleXmlText(richNode);
}

function freemindNodeNote(node: SimpleXmlNode): string | undefined {
  const note = xmlChildren(node, 'richcontent')
    .find((child) => (child.attrs.TYPE || child.attrs.type || '').toUpperCase() === 'NOTE');
  const text = simpleXmlText(note);
  return text || undefined;
}

function freemindNodeFromXml(node: SimpleXmlNode): MindMapNode | null {
  const title = freemindNodeText(node);
  if (!title) return null;
  const markers = xmlChildren(node, 'icon')
    .map((icon) => icon.attrs.BUILTIN || icon.attrs.builtin)
    .filter(Boolean);
  return {
    id: node.attrs.ID || node.attrs.id,
    title,
    notes: freemindNodeNote(node),
    link: node.attrs.LINK || node.attrs.link || undefined,
    labels: node.attrs.POSITION || node.attrs.position ? [node.attrs.POSITION || node.attrs.position] : undefined,
    markers: markers.length ? markers : undefined,
    children: xmlChildren(node, 'node').map(freemindNodeFromXml).filter((child): child is MindMapNode => Boolean(child)),
  };
}

function parseFreeMind(input: ParseDocumentInput, text: string): DocumentUnit[] {
  const root = parseSimpleXml(text);
  const map = xmlDescendants(root, 'map')[0] ?? root;
  const roots = xmlChildren(map, 'node')
    .map(freemindNodeFromXml)
    .filter((node): node is MindMapNode => Boolean(node));
  if (roots.length === 0) throw new Error('FreeMind MM 文件中没有找到可解析的节点。');
  const title = roots.length === 1 ? roots[0].title : input.title;
  return [mindMapSectionToUnit(input, { title, roots }, 0, 'freemind_mm')];
}

function jsonString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? normalizeBlockText(value) : undefined;
}

function xmindTopicChildren(topic: Record<string, unknown>): Array<Record<string, unknown>> {
  const directTopics = topic.topics;
  if (Array.isArray(directTopics)) {
    return directTopics.filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null);
  }
  const children = topic.children;
  if (Array.isArray(children)) return children.filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null);
  if (!children || typeof children !== 'object') return [];
  const result: Array<Record<string, unknown>> = [];
  for (const value of Object.values(children as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      result.push(...value.filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null));
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(nested)) {
          result.push(...nested.filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null));
        }
      }
    }
  }
  return result;
}

function xmindTopicNotes(topic: Record<string, unknown>): string | undefined {
  const notes = topic.notes ?? topic.note;
  if (typeof notes === 'string') return normalizeBlockText(notes) || undefined;
  if (!notes || typeof notes !== 'object') return undefined;
  const record = notes as Record<string, unknown>;
  const plain = record.plain;
  if (plain && typeof plain === 'object') {
    const content = jsonString((plain as Record<string, unknown>).content);
    if (content) return content;
  }
  const html = record.html;
  if (html && typeof html === 'object') {
    const content = jsonString((html as Record<string, unknown>).content);
    if (content) return stripHtmlTags(content);
  }
  return undefined;
}

function xmindStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        return jsonString(record.title) || jsonString(record.name) || jsonString(record.markerId);
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
  return values.length ? values : undefined;
}

function xmindUntitledNodeTitle(topic: Record<string, unknown>): string {
  const structure = `${jsonString(topic.structureClass) ?? ''} ${jsonString(topic.class) ?? ''}`;
  if (structure.includes('spreadsheet')) return '表格';
  if (structure.includes('fishbone')) return '鱼骨图';
  return '未命名主题';
}

function xmindNodeFromJson(topic: Record<string, unknown>, fallbackTitle?: string): MindMapNode | null {
  const children = xmindTopicChildren(topic).map((child) => xmindNodeFromJson(child)).filter((node): node is MindMapNode => Boolean(node));
  const title = jsonString(topic.title)
    || jsonString(topic.text)
    || jsonString(topic.name)
    || jsonString(topic.branch)
    || jsonString(fallbackTitle)
    || (children.length ? xmindUntitledNodeTitle(topic) : undefined);
  const notes = xmindTopicNotes(topic);
  if (!title && !notes && children.length === 0) return null;
  return {
    id: jsonString(topic.id),
    title: title ?? '未命名主题',
    notes,
    link: jsonString(topic.href) || jsonString(topic.hyperlink),
    labels: xmindStringArray(topic.labels),
    markers: xmindStringArray(topic.markers) ?? xmindStringArray(topic.markerRefs) ?? xmindStringArray(topic.markersRefs),
    children,
  };
}

function xmindSheetCandidates(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (!content || typeof content !== 'object') return [];
  const record = content as Record<string, unknown>;
  if (Array.isArray(record.sheets)) return record.sheets;
  if (Array.isArray(record.worksheets)) return record.worksheets;
  if (Array.isArray(record.pages)) return record.pages;
  if (Array.isArray(record.children)) return record.children;
  if (record.rootTopic || record.topic || record.root) return [record];
  return [];
}

function xmindRootTopicFromSheet(sheet: Record<string, unknown>): unknown {
  return sheet.rootTopic ?? sheet.topic ?? sheet.root ?? sheet.centralTopic;
}

function parseXmindJson(input: ParseDocumentInput, content: unknown): DocumentUnit[] {
  const sheets = xmindSheetCandidates(content);
  const sections: MindMapSection[] = [];
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== 'object') continue;
    const record = sheet as Record<string, unknown>;
    const rootTopic = xmindRootTopicFromSheet(record);
    if (!rootTopic || typeof rootTopic !== 'object') continue;
    const rootFallbackTitle = jsonString(record.title) || input.title;
    const root = xmindNodeFromJson(rootTopic as Record<string, unknown>, rootFallbackTitle);
    if (!root) continue;
    sections.push({
      title: jsonString(record.title) || root.title || input.title,
      roots: [root],
    });
  }
  if (sections.length === 0) throw new Error('XMind content.json 中没有找到可解析的画布。');
  return sections.map((section, index) => mindMapSectionToUnit(input, section, index, 'xmind_content_json'));
}

function xmindXmlTopicChildren(topic: SimpleXmlNode): SimpleXmlNode[] {
  const result: SimpleXmlNode[] = [];
  for (const children of xmlChildren(topic, 'children')) {
    for (const topics of xmlChildren(children, 'topics')) {
      result.push(...xmlChildren(topics, 'topic'));
    }
    result.push(...xmlChildren(children, 'topic'));
  }
  return result;
}

function xmindNodeFromXml(topic: SimpleXmlNode): MindMapNode | null {
  const title = simpleXmlText(xmlFirst(topic, 'title')) || topic.attrs.title || topic.attrs.text;
  if (!title) return null;
  const notes = simpleXmlText(xmlFirst(topic, 'notes')) || undefined;
  const labels = xmlDescendants(xmlFirst(topic, 'labels'), 'label').map(simpleXmlText).filter(Boolean);
  const markers = xmlDescendants(xmlFirst(topic, 'marker-refs'), 'marker-ref')
    .map((marker) => marker.attrs['marker-id'] || marker.attrs.markerId)
    .filter(Boolean);
  return {
    id: topic.attrs.id,
    title,
    notes,
    link: topic.attrs['xlink:href'] || topic.attrs.href || undefined,
    labels: labels.length ? labels : undefined,
    markers: markers.length ? markers : undefined,
    children: xmindXmlTopicChildren(topic).map(xmindNodeFromXml).filter((node): node is MindMapNode => Boolean(node)),
  };
}

function parseXmindXml(input: ParseDocumentInput, xml: string): DocumentUnit[] {
  const root = parseSimpleXml(xml);
  const sheets = xmlDescendants(root, 'sheet');
  const sections: MindMapSection[] = [];
  for (const sheet of sheets) {
    const topic = xmlFirst(sheet, 'topic');
    const rootTopic = topic ? xmindNodeFromXml(topic) : null;
    if (!rootTopic) continue;
    sections.push({
      title: simpleXmlText(xmlFirst(sheet, 'title')) || rootTopic.title || input.title,
      roots: [rootTopic],
    });
  }
  if (sections.length === 0) throw new Error('XMind content.xml 中没有找到可解析的画布。');
  return sections.map((section, index) => mindMapSectionToUnit(input, section, index, 'xmind_content_xml'));
}

async function parseXmind(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const zip = await loadOfficeZip(buffer);
  const json = await zipText(zip, 'content.json');
  if (json) return parseXmindJson(input, JSON.parse(json));
  const xml = await zipText(zip, 'content.xml');
  if (xml) return parseXmindXml(input, xml);
  throw new Error('XMind 文件中没有找到 content.json 或 content.xml。');
}

async function parseDocx(input: ParseDocumentInput, buffer: Buffer): Promise<DocumentUnit[]> {
  const mammoth = await import('mammoth');
  const converted = await mammoth.convertToHtml({ buffer });
  const htmlUnits = parseHtmlUnits(input, converted.value ?? '', {
    unitKind: 'section',
    locator: 'section 1',
    metadata: {
      source: 'mammoth_html',
      messages: converted.messages?.map((message) => message.message).filter(Boolean),
    },
  });
  if (htmlUnits.some((unit) => unit.charCount > 0)) return htmlUnits;

  const extracted = await mammoth.extractRawText({ buffer });
  return [createUnit({
    unitIndex: 0,
    kind: 'section',
    locator: 'section 1',
    title: input.title,
    text: extracted.value ?? '',
    metadata: { source: 'mammoth_raw_text' },
  })];
}

function parsePlainTextLike(input: ParseDocumentInput, kind: DocumentKind): DocumentUnit[] {
  const text = input.text ?? input.buffer?.toString('utf8') ?? '';
  return [createUnit({
    unitIndex: 0,
    kind: unitKindForDocument(kind),
    locator: kind === 'image' ? 'image 1' : 'text 1',
    title: input.title,
    text,
    metadata: { source: input.text ? 'provided_text' : 'buffer_utf8' },
  })];
}

export async function parseDocumentFile(input: ParseDocumentInput): Promise<DocumentAsset> {
  const kind = detectKind(input);
  let buffer = input.buffer;
  const getBuffer = async (): Promise<Buffer | undefined> => {
    if (!buffer && input.filePath) buffer = await readFile(input.filePath);
    return buffer;
  };
  let units: DocumentUnit[];
  let processingError: string | null = null;

  try {
    if (kind === 'pdf') {
      units = await parsePdf(input, buffer);
    } else if (kind === 'docx') {
      const docxBuffer = await getBuffer();
      if (!docxBuffer) throw new Error('DOCX 文件内容为空，无法解析。');
      units = await parseDocx(input, docxBuffer);
    } else if (kind === 'pptx') {
      const pptxBuffer = await getBuffer();
      if (!pptxBuffer) throw new Error('PPTX 文件内容为空，无法解析。');
      units = await parsePptx(input, pptxBuffer);
    } else if (kind === 'xlsx') {
      const xlsxBuffer = await getBuffer();
      if (!xlsxBuffer) throw new Error('XLSX 文件内容为空，无法解析。');
      units = await parseXlsx(input, xlsxBuffer);
    } else if (kind === 'rtf') {
      const rtfBuffer = await getBuffer();
      units = await parseRtf(input, rtfBuffer);
    } else if (kind === 'epub') {
      const epubBuffer = await getBuffer();
      if (!epubBuffer) throw new Error('EPUB 文件内容为空，无法解析。');
      units = await parseEpub(input, epubBuffer);
    } else if (kind === 'odt') {
      const odtBuffer = await getBuffer();
      if (!odtBuffer) throw new Error('ODT 文件内容为空，无法解析。');
      units = await parseOdt(input, odtBuffer);
    } else if (kind === 'ods') {
      const odsBuffer = await getBuffer();
      if (!odsBuffer) throw new Error('ODS 文件内容为空，无法解析。');
      units = await parseOds(input, odsBuffer);
    } else if (kind === 'odp') {
      const odpBuffer = await getBuffer();
      if (!odpBuffer) throw new Error('ODP 文件内容为空，无法解析。');
      units = await parseOdp(input, odpBuffer);
    } else if (kind === 'opml') {
      const text = input.text ?? (await getBuffer())?.toString('utf8') ?? '';
      units = parseOpml(input, text);
    } else if (kind === 'mm') {
      const text = input.text ?? (await getBuffer())?.toString('utf8') ?? '';
      units = parseFreeMind(input, text);
    } else if (kind === 'xmind') {
      const xmindBuffer = await getBuffer();
      if (!xmindBuffer) throw new Error('XMind 文件内容为空，无法解析。');
      units = await parseXmind(input, xmindBuffer);
    } else if (kind === 'csv' || kind === 'tsv') {
      const tableBuffer = await getBuffer();
      units = parseDelimitedText(input, kind, tableBuffer);
    } else if (kind === 'html') {
      const text = input.text ?? (await getBuffer())?.toString('utf8') ?? '';
      units = parseHtmlUnits(input, text);
    } else if (kind === 'markdown') {
      const text = input.text ?? (await getBuffer())?.toString('utf8') ?? '';
      units = parseMarkdownUnits(input, text);
    } else {
      if (!input.text && !buffer && input.filePath && kind !== 'image') buffer = await getBuffer();
      units = parsePlainTextLike({ ...input, buffer }, kind);
    }
  } catch (error) {
    processingError = error instanceof Error ? error.message : String(error);
    units = parsePlainTextLike({ ...input, text: input.text ?? '' }, kind);
  }

  const textUnitCount = units.filter((unit) => unit.text.trim().length > 0).length;
  const totalChars = units.reduce((sum, unit) => sum + unit.charCount, 0);
  return {
    sourceId: input.sourceId,
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    kind,
    sourceKind: input.sourceKind,
    title: input.title,
    mimeType: input.mimeType ?? null,
    fileName: input.fileName ?? input.title,
    filePath: input.filePath ?? null,
    originalPath: input.originalPath ?? null,
    url: input.url ?? null,
    parserVersion: DOCUMENT_PARSER_VERSION,
    processingState: processingError ? 'failed' : 'ready',
    processingError,
    metadata: {
      unitCount: units.length,
      textUnitCount,
      totalChars,
      suspectedScanned: kind === 'pdf' && units.length > 0 && textUnitCount / units.length < 0.25,
    },
    units,
  };
}

export function documentAssetTextCharCount(asset: DocumentAsset): number {
  const totalChars = asset.metadata?.totalChars;
  return typeof totalChars === 'number'
    ? totalChars
    : asset.units.reduce((sum, unit) => sum + unit.charCount, 0);
}

export function documentAssetToText(asset: DocumentAsset): string {
  return asset.units
    .map((unit) => [
      `[${unit.locator}]${unit.title ? ` ${unit.title}` : ''}`,
      unit.text,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

export function documentAssetPages(asset: DocumentAsset): Array<{ page: number; text: string }> | undefined {
  const pages = asset.units
    .filter((unit) => unit.kind === 'page' && unit.pageNumber !== null && unit.pageNumber !== undefined)
    .map((unit) => ({ page: unit.pageNumber as number, text: unit.text }));
  if (!pages.some((page) => page.text.trim().length > 0)) return undefined;
  return pages.length > 0 ? pages : undefined;
}
