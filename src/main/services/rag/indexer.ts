import { randomUUID } from 'crypto';
import { getDb } from '../db/sqlite';

const MAX_CHUNK_CHARS = 600;

/** Strip markdown syntax from plain text sections (not code blocks) */
function stripMarkdownText(text: string): string {
  return text
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))   // inline code → content
    .replace(/#{1,6}\s+/g, '')                      // headers
    .replace(/\*\*([^*]+)\*\*/g, '$1')              // bold
    .replace(/\*([^*]+)\*/g, '$1')                  // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // links
    .replace(/^[-*+]\s/gm, '')                      // list bullets
    .replace(/^\d+\.\s/gm, '')                      // numbered lists
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split markdown into semantic chunks:
 * - Fenced code blocks are preserved as complete chunks (never stripped/split)
 * - Text sections are split on paragraph boundaries, accumulated up to MAX_CHUNK_CHARS
 */
function semanticChunks(md: string): string[] {
  const chunks: string[] = [];

  // Split on fenced code blocks; the delimiter is captured so we can identify them
  const parts = md.split(/(```[\s\S]*?```)/g);

  let textAccum = '';

  const flushText = (): void => {
    if (!textAccum.trim()) { textAccum = ''; return; }
    const plain = stripMarkdownText(textAccum);
    textAccum = '';

    const paragraphs = plain.split(/\n{2,}/);
    let buf = '';
    for (const para of paragraphs) {
      const p = para.trim();
      if (!p) continue;
      if (buf && buf.length + 2 + p.length > MAX_CHUNK_CHARS) {
        if (buf.length > 20) chunks.push(buf);
        buf = p;
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf.length > 20) chunks.push(buf);
  };

  for (const part of parts) {
    if (part.startsWith('```')) {
      flushText();
      const trimmed = part.trim();
      if (trimmed.length > 10) chunks.push(trimmed);
    } else {
      textAccum += part;
    }
  }
  flushText();

  return chunks;
}

/**
 * Index file content into FTS chunks.
 * Deletes existing chunks for this file before inserting.
 * @param sourceName  Human-readable file name shown in RAG citations (optional)
 */
export function indexFile(
  fileId: string,
  nodeId: string,
  courseId: string,
  content: string,
  sourceName = ''
): void {
  const db = getDb();
  const chunks = semanticChunks(content);

  // Delete existing chunks for this file
  const existingIds = db
    .prepare<[string], { id: string }>('SELECT id FROM file_chunks WHERE file_id = ?')
    .all(fileId)
    .map((r) => r.id);

  if (existingIds.length > 0) {
    const placeholders = existingIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM file_chunks_fts WHERE chunk_id IN (${placeholders})`).run(...existingIds);
    db.prepare('DELETE FROM file_chunks WHERE file_id = ?').run(fileId);
  }

  // Insert new chunks
  const insertChunk = db.prepare(
    `INSERT INTO file_chunks (id, file_id, node_id, course_id, chunk_index, source_name, content)
     VALUES (@id, @file_id, @node_id, @course_id, @chunk_index, @source_name, @content)`
  );
  const insertFts = db.prepare(
    `INSERT INTO file_chunks_fts (content, chunk_id, node_id) VALUES (@content, @chunk_id, @node_id)`
  );

  db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const id = randomUUID();
      insertChunk.run({
        id, file_id: fileId, node_id: nodeId, course_id: courseId,
        chunk_index: i, source_name: sourceName, content: chunks[i],
      });
      insertFts.run({ content: chunks[i], chunk_id: id, node_id: nodeId });
    }
  })();
}
