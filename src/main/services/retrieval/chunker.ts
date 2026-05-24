import { createHash } from 'crypto';

export interface StructuredChunk {
  content: string;
  locator: string;
  headingPath?: string[];
  page?: number;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function detectLanguage(content: string): 'zh' | 'en' | 'mixed' | 'unknown' {
  const sample = content.slice(0, 4000);
  const cjk = (sample.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return 'unknown';
  if (cjk > 20 && latin > 50) return 'mixed';
  return cjk > latin * 0.2 ? 'zh' : 'en';
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  return Math.max(1, Math.ceil(cjk * 0.7 + words * 1.2));
}

function pushChunk(
  chunks: StructuredChunk[],
  content: string,
  locator: string,
  charStart: number,
  headingPath?: string[],
  page?: number,
): void {
  const trimmed = content.trim();
  if (trimmed.length < 20) return;
  chunks.push({
    content: trimmed,
    locator,
    headingPath: headingPath?.length ? [...headingPath] : undefined,
    page,
    charStart,
    charEnd: charStart + trimmed.length,
    tokenCount: estimateTokens(trimmed),
  });
}

export function chunkPlainText(content: string, options?: {
  maxChars?: number;
  overlapChars?: number;
  maxChunks?: number;
  locatorPrefix?: string;
  page?: number;
  headingPath?: string[];
}): StructuredChunk[] {
  const maxChars = options?.maxChars ?? 900;
  const overlapChars = options?.overlapChars ?? 100;
  const maxChunks = options?.maxChunks ?? 120;
  const paragraphs = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: StructuredChunk[] = [];
  let buf = '';
  let start = 0;
  let cursor = 0;
  for (const para of paragraphs) {
    const paraStart = content.indexOf(para, cursor);
    if (paraStart >= 0) cursor = paraStart + para.length;
    if (buf && buf.length + para.length + 2 > maxChars) {
      const index = chunks.length + 1;
      pushChunk(chunks, buf, `${options?.locatorPrefix ?? 'chunk'} ${index}`, start, options?.headingPath, options?.page);
      if (chunks.length >= maxChunks) break;
      const overlap = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = overlap ? `${overlap}\n\n${para}` : para;
      start = Math.max(0, (paraStart >= 0 ? paraStart : cursor) - overlap.length);
    } else {
      if (!buf) start = paraStart >= 0 ? paraStart : cursor;
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (chunks.length < maxChunks && buf) {
    pushChunk(chunks, buf, `${options?.locatorPrefix ?? 'chunk'} ${chunks.length + 1}`, start, options?.headingPath, options?.page);
  }
  return chunks.slice(0, maxChunks);
}

export function chunkMarkdown(content: string, options?: { maxChunks?: number }): StructuredChunk[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ headingPath: string[]; text: string; start: number }> = [];
  const headingPath: string[] = [];
  let buf: string[] = [];
  let sectionStart = 0;
  let cursor = 0;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ headingPath: [...headingPath], text, start: sectionStart });
    buf = [];
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flush();
      const level = match[1].length;
      headingPath.splice(level - 1);
      headingPath[level - 1] = match[2].trim();
      sectionStart = cursor;
    } else {
      if (buf.length === 0) sectionStart = cursor;
      buf.push(line);
    }
    cursor += line.length + 1;
  }
  flush();

  if (sections.length === 0) return chunkPlainText(content, { maxChunks: options?.maxChunks });

  const chunks: StructuredChunk[] = [];
  for (const section of sections) {
    const sectionChunks = chunkPlainText(section.text, {
      headingPath: section.headingPath,
      locatorPrefix: section.headingPath.join(' > ') || 'section',
      maxChunks: Math.max(1, (options?.maxChunks ?? 120) - chunks.length),
    }).map((chunk) => ({
      ...chunk,
      charStart: section.start + chunk.charStart,
      charEnd: section.start + chunk.charEnd,
    }));
    chunks.push(...sectionChunks);
    if (chunks.length >= (options?.maxChunks ?? 120)) break;
  }
  return chunks;
}

export function chunkPages(pages: Array<{ page: number; text: string }>, options?: { maxChunks?: number }): StructuredChunk[] {
  const chunks: StructuredChunk[] = [];
  for (const page of pages) {
    chunks.push(...chunkPlainText(page.text, {
      page: page.page,
      locatorPrefix: `page ${page.page}`,
      maxChunks: Math.max(1, (options?.maxChunks ?? 160) - chunks.length),
    }));
    if (chunks.length >= (options?.maxChunks ?? 160)) break;
  }
  return chunks;
}

export function chunkSourceContent(content: string, options?: {
  mimeType?: string;
  fileName?: string;
  maxChunks?: number;
  pages?: Array<{ page: number; text: string }>;
}): StructuredChunk[] {
  if (options?.pages?.length) return chunkPages(options.pages, { maxChunks: options.maxChunks });
  const name = options?.fileName?.toLowerCase() ?? '';
  const mime = options?.mimeType ?? '';
  if (name.endsWith('.md') || name.endsWith('.markdown') || mime.includes('markdown')) {
    return chunkMarkdown(content, { maxChunks: options?.maxChunks });
  }
  return chunkPlainText(content, { maxChunks: options?.maxChunks });
}
