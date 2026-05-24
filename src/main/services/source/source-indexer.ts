import { randomUUID } from 'crypto';
import type { SourceEmbeddingStatus, SourceKind, SourceProcessingState } from '@shared/types';
import { getDb } from '../db/sqlite';
import { chunkPlainText, chunkSourceContent, contentHash, detectLanguage, type StructuredChunk } from '../retrieval/chunker';
import type { DocumentAsset, DocumentUnit } from '../documents/document-types';
import { embedBatch, EmbeddingUnavailableError, getEmbeddingModelInfo } from '../retrieval/embedding-service';
import { rebuildMediaContent } from './media-ingestion';
import { resolveSourceMaxChunks } from './source-index-limits';
import { extractExercisesForSource } from './source-exercises';

const PARSER_VERSION = 'v2';
const EMBEDDING_BATCH_SIZE = 16;

export interface IndexSourceContentInput {
  sourceId: string;
  courseId: string;
  nodeId: string | null;
  content: string;
  sourceKind: SourceKind;
  fileName?: string;
  mimeType?: string;
  pages?: Array<{ page: number; text: string }>;
  maxChunks?: number;
  force?: boolean;
}

interface ReindexRow {
  course_id: string;
  node_id: string | null;
  kind: SourceKind;
  origin?: string | null;
  title: string;
  remark?: string | null;
  url: string | null;
  file_path: string | null;
  media_type: string | null;
}

type WritableChunk = StructuredChunk & {
  documentUnitId?: string | null;
  documentUnitIndex?: number | null;
};

interface SourceContextRow {
  title: string;
  remark: string | null;
  kind: string;
  origin: string | null;
  url: string | null;
  file_path: string | null;
}

function deleteChunksByIds(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM source_chunk_embeddings WHERE chunk_id IN (${placeholders})`).run(...ids);
  getDb().prepare(`DELETE FROM source_chunks_fts WHERE chunk_id IN (${placeholders})`).run(...ids);
  getDb().prepare(`DELETE FROM source_chunks WHERE id IN (${placeholders})`).run(...ids);
}

function deleteExistingChunks(sourceId: string): void {
  const existingIds = getDb()
    .prepare<[string], { id: string }>('SELECT id FROM source_chunks WHERE source_id = ?')
    .all(sourceId)
    .map((r) => r.id);
  deleteChunksByIds(existingIds);
}

function deleteChunksForDocumentUnits(sourceId: string, units: DocumentUnit[]): void {
  const pages = units
    .map((unit) => unit.pageNumber)
    .filter((page): page is number => typeof page === 'number' && Number.isFinite(page));
  const unitIndexes = units
    .map((unit) => unit.unitIndex)
    .filter((index): index is number => typeof index === 'number' && Number.isFinite(index));
  const clauses: string[] = [];
  const params: Array<string | number> = [sourceId];
  if (pages.length > 0) {
    clauses.push(`page IN (${pages.map(() => '?').join(',')})`);
    params.push(...pages);
  }
  if (unitIndexes.length > 0) {
    clauses.push(`document_unit_index IN (${unitIndexes.map(() => '?').join(',')})`);
    params.push(...unitIndexes);
  }
  if (clauses.length === 0) return;
  const ids = getDb()
    .prepare(`SELECT id FROM source_chunks WHERE source_id = ? AND (${clauses.join(' OR ')})`)
    .all(...params)
    .map((row) => (row as { id: string }).id);
  deleteChunksByIds(ids);
}

function nextChunkIndex(sourceId: string): number {
  return (getDb()
    .prepare<[string], { max_index: number | null }>('SELECT MAX(chunk_index) AS max_index FROM source_chunks WHERE source_id = ?')
    .get(sourceId)?.max_index ?? -1) + 1;
}

function currentChunkCount(sourceId: string): number {
  return getDb()
    .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM source_chunks WHERE source_id = ?')
    .get(sourceId)?.count ?? 0;
}

function sourceOriginLabel(origin?: string | null): string {
  switch (origin) {
    case 'chat_attachment': return '对话附件';
    case 'web_collected': return '自动网页资料';
    case 'ai_generated': return 'AI生成资料';
    case 'user_import':
    default: return '用户导入资料';
  }
}

function getSourceContext(sourceId: string): SourceContextRow | null {
  return getDb()
    .prepare<[string], SourceContextRow>(
      `SELECT title, remark, kind, origin, url, file_path
       FROM source_records
       WHERE id = ?`,
    )
    .get(sourceId) ?? null;
}

function contextualChunkContent(source: SourceContextRow | null, chunk: WritableChunk): string {
  if (!source) return chunk.content;
  const lines = [
    `资料：${source.title}`,
    `来源层级：${sourceOriginLabel(source.origin)}`,
    source.remark?.trim() ? `备注：${source.remark.trim()}` : '',
    chunk.headingPath?.length ? `章节/标题：${chunk.headingPath.join(' > ')}` : '',
    chunk.page ? `页码：p.${chunk.page}` : '',
    chunk.locator ? `定位：${chunk.locator}` : '',
    source.url ? `URL：${source.url}` : source.file_path ? `文件：${source.file_path}` : '',
    '',
    '正文：',
    chunk.content,
  ].filter((line) => line !== '');
  return lines.join('\n').slice(0, 9000);
}

function writeChunks(input: IndexSourceContentInput, chunks: WritableChunk[], startIndex = 0): string[] {
  const sourceContext = getSourceContext(input.sourceId);
  const insertChunk = getDb().prepare(
    `INSERT INTO source_chunks (
       id, source_id, course_id, node_id, chunk_index, locator, heading_path, page,
       document_unit_id, document_unit_index, char_start, char_end, token_count, content, indexed_content
     ) VALUES (
       @id, @source_id, @course_id, @node_id, @chunk_index, @locator, @heading_path, @page,
       @document_unit_id, @document_unit_index, @char_start, @char_end, @token_count, @content, @indexed_content
     )`,
  );
  const insertFts = getDb().prepare(
    `INSERT INTO source_chunks_fts (content, chunk_id, source_id, course_id, node_id)
     VALUES (@content, @chunk_id, @source_id, @course_id, @node_id)`,
  );

  const ids: string[] = [];
  chunks.forEach((chunk, index) => {
    const id = randomUUID();
    const indexedContent = contextualChunkContent(sourceContext, chunk);
    ids.push(id);
    insertChunk.run({
      id,
      source_id: input.sourceId,
      course_id: input.courseId,
      node_id: input.nodeId,
      chunk_index: startIndex + index,
      locator: chunk.locator,
      heading_path: chunk.headingPath?.length ? JSON.stringify(chunk.headingPath) : null,
      page: chunk.page ?? null,
      document_unit_id: chunk.documentUnitId ?? null,
      document_unit_index: chunk.documentUnitIndex ?? null,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      token_count: chunk.tokenCount,
      content: chunk.content,
      indexed_content: indexedContent,
    });
    insertFts.run({
      content: indexedContent,
      chunk_id: id,
      source_id: input.sourceId,
      course_id: input.courseId,
      node_id: input.nodeId,
    });
  });
  return ids;
}

function updateMeta(input: {
  sourceId: string;
  language: string;
  hash: string;
  chunkCount: number;
  status: SourceEmbeddingStatus;
  error?: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO source_document_meta (
       source_id, language, parser_version, content_hash, chunk_count, embedding_status, last_indexed_at, error
     ) VALUES (
       @source_id, @language, @parser_version, @content_hash, @chunk_count, @embedding_status, datetime('now'), @error
     )
     ON CONFLICT(source_id) DO UPDATE SET
       language = excluded.language,
       parser_version = excluded.parser_version,
       content_hash = excluded.content_hash,
       chunk_count = excluded.chunk_count,
       embedding_status = excluded.embedding_status,
       last_indexed_at = datetime('now'),
       error = excluded.error`,
  ).run({
    source_id: input.sourceId,
    language: input.language,
    parser_version: PARSER_VERSION,
    content_hash: input.hash,
    chunk_count: input.chunkCount,
    embedding_status: input.status,
    error: input.error ?? null,
  });
}

async function indexEmbeddings(sourceId: string, chunkIds?: string[]): Promise<void> {
  const idFilter = chunkIds?.length
    ? `AND id IN (${chunkIds.map(() => '?').join(',')})`
    : '';
  const rows = getDb()
    .prepare(
      `SELECT id, COALESCE(indexed_content, content) AS content FROM source_chunks
       WHERE source_id = ? ${idFilter}
       ORDER BY chunk_index ASC`,
    )
    .all(sourceId, ...(chunkIds ?? [])) as Array<{ id: string; content: string }>;
  if (rows.length === 0) {
    updateMetaStatus(sourceId, 'skipped', 'No chunks to embed.');
    return;
  }

  const info = getEmbeddingModelInfo();
  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO source_chunk_embeddings (chunk_id, model, dimensions, embedding_json)
     VALUES (@chunk_id, @model, @dimensions, @embedding_json)`,
  );
  try {
    for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = rows.slice(i, i + EMBEDDING_BATCH_SIZE);
      const embeddings = await embedBatch(batch.map((row) => row.content));
      getDb().transaction(() => {
        batch.forEach((row, index) => {
          const embedding = embeddings[index];
          if (!embedding?.length) return;
          insert.run({
            chunk_id: row.id,
            model: info.model,
            dimensions: embedding.length,
            embedding_json: JSON.stringify(embedding),
          });
        });
      })();
    }
    updateMetaStatus(sourceId, 'ready', null);
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      updateMetaStatus(sourceId, 'lexical_only', err.message);
      return;
    }
    updateMetaStatus(sourceId, 'failed', err instanceof Error ? err.message : String(err));
  }
}

function updateMetaStatus(sourceId: string, status: SourceEmbeddingStatus, error: string | null): void {
  getDb().prepare(
    `UPDATE source_document_meta
     SET embedding_status = @status, error = @error, last_indexed_at = datetime('now')
     WHERE source_id = @source_id`,
  ).run({ source_id: sourceId, status, error });
}

export function setSourceProcessingError(sourceId: string, error: string | null): void {
  getDb().prepare(
    `UPDATE source_document_meta
     SET processing_error = @error
     WHERE source_id = @source_id`,
  ).run({ source_id: sourceId, error });
}

export function setSourceProcessingState(sourceId: string, state: SourceProcessingState): void {
  getDb().prepare(
    `UPDATE source_document_meta
     SET processing_state = @state
     WHERE source_id = @source_id`,
  ).run({ source_id: sourceId, state });
}

export function initializeSourceIndexMeta(input: {
  sourceId: string;
  processingState?: SourceProcessingState;
  processingError?: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO source_document_meta (
       source_id, language, parser_version, content_hash, chunk_count, embedding_status,
       processing_state, processing_error, last_indexed_at, error
     ) VALUES (
       @source_id, 'unknown', @parser_version, '', 0, 'skipped',
       @processing_state, @processing_error, datetime('now'), NULL
     )
     ON CONFLICT(source_id) DO UPDATE SET
       processing_state = excluded.processing_state,
       processing_error = excluded.processing_error`,
  ).run({
    source_id: input.sourceId,
    parser_version: PARSER_VERSION,
    processing_state: input.processingState ?? 'pending',
    processing_error: input.processingError ?? null,
  });
}

export function indexSourceContent(input: IndexSourceContentInput): void {
  const hash = contentHash(input.content);
  const existing = getDb()
    .prepare<[string], { content_hash: string | null }>('SELECT content_hash FROM source_document_meta WHERE source_id = ?')
    .get(input.sourceId);
  if (!input.force && existing?.content_hash === hash) return;

  const chunks = chunkSourceContent(input.content, {
    mimeType: input.mimeType,
    fileName: input.fileName,
    maxChunks: resolveSourceMaxChunks({
      sourceKind: input.sourceKind,
      explicit: input.maxChunks,
      pageCount: input.pages?.length,
    }),
    pages: input.pages,
  });

  getDb().transaction(() => {
    deleteExistingChunks(input.sourceId);
    writeChunks(input, chunks);
    updateMeta({
      sourceId: input.sourceId,
      language: detectLanguage(input.content),
      hash,
      chunkCount: chunks.length,
      status: 'pending',
    });
  })();

  try {
    extractExercisesForSource({ sourceId: input.sourceId, force: true });
  } catch (err) {
    console.warn('[SourceIndexer] exercise extraction failed', input.sourceId, err);
  }

  void indexEmbeddings(input.sourceId);
}

function chunksForDocumentUnits(units: DocumentUnit[], maxChunks: number): WritableChunk[] {
  const chunks: WritableChunk[] = [];
  for (const unit of units) {
    if (!unit.text.trim()) continue;
    const unitChunks = chunkPlainText(unit.text, {
      page: unit.pageNumber ?? undefined,
      locatorPrefix: unit.locator,
      headingPath: unit.title ? [unit.title] : undefined,
      maxChunks: Math.max(1, maxChunks - chunks.length),
    }).map((chunk) => ({
      ...chunk,
      documentUnitId: unit.id ?? null,
      documentUnitIndex: unit.unitIndex,
    }));
    chunks.push(...unitChunks);
    if (chunks.length >= maxChunks) break;
  }
  return chunks;
}

export function indexDocumentUnits(input: {
  sourceId: string;
  asset: DocumentAsset;
  units: DocumentUnit[];
  sourceKind?: SourceKind;
  maxChunks?: number;
}): void {
  const text = input.units.map((unit) => unit.text).join('\n\n').trim();
  const maxChunks = resolveSourceMaxChunks({
    sourceKind: input.sourceKind ?? input.asset.sourceKind ?? 'upload',
    explicit: input.maxChunks,
    pageCount: input.units.length,
  });
  const chunks = chunksForDocumentUnits(input.units, maxChunks);
  const hash = contentHash([
    Date.now(),
    input.units.map((unit) => `${unit.unitIndex}:${unit.pageNumber ?? ''}:${unit.charCount}`).join(','),
    text,
  ].join('\n'));

  let insertedIds: string[] = [];
  getDb().transaction(() => {
    deleteChunksForDocumentUnits(input.sourceId, input.units);
    insertedIds = writeChunks({
      sourceId: input.sourceId,
      courseId: input.asset.courseId,
      nodeId: input.asset.nodeId ?? null,
      sourceKind: input.sourceKind ?? input.asset.sourceKind ?? 'upload',
      fileName: input.asset.fileName ?? input.asset.title,
      mimeType: input.asset.mimeType ?? undefined,
      content: text,
    }, chunks, nextChunkIndex(input.sourceId));
    updateMeta({
      sourceId: input.sourceId,
      language: detectLanguage(text),
      hash,
      chunkCount: currentChunkCount(input.sourceId),
      status: insertedIds.length > 0 ? 'pending' : 'skipped',
    });
  })();

  if (insertedIds.length > 0) {
    try {
      extractExercisesForSource({ sourceId: input.sourceId, force: true });
    } catch (err) {
      console.warn('[SourceIndexer] exercise extraction failed', input.sourceId, err);
    }
    void indexEmbeddings(input.sourceId, insertedIds);
  }
}

export async function reindexSource(sourceId: string, force = false): Promise<void> {
  const row = getDb()
    .prepare<[string], ReindexRow>(
      'SELECT course_id, node_id, kind, origin, title, remark, url, file_path, media_type FROM source_records WHERE id = ?',
    )
    .get(sourceId);
  if (!row) throw new Error(`Source not found: ${sourceId}`);

  const rebuiltMedia = await rebuildMediaContent({
    title: row.title,
    filePath: row.file_path,
    url: row.url,
    mimeType: row.media_type,
  });
  if (rebuiltMedia) {
    indexSourceContent({
      sourceId,
      courseId: row.course_id,
      nodeId: row.node_id,
      sourceKind: row.kind,
      fileName: row.title,
      mimeType: row.media_type ?? undefined,
      content: rebuiltMedia.content,
      force,
    });
    setSourceProcessingError(sourceId, rebuiltMedia.processingError ?? null);
    setSourceProcessingState(sourceId, rebuiltMedia.processingState ?? (rebuiltMedia.processingError ? 'failed' : 'ready'));
    await Promise.resolve();
    return;
  }

  const chunks = getDb()
    .prepare<[string], { content: string }>('SELECT content FROM source_chunks WHERE source_id = ? ORDER BY chunk_index ASC')
    .all(sourceId);
  const content = chunks.map((chunk) => chunk.content).join('\n\n');
  if (!content.trim()) throw new Error('Source has no indexed content to rebuild from.');
  indexSourceContent({
    sourceId,
    courseId: row.course_id,
    nodeId: row.node_id,
    sourceKind: row.kind,
    fileName: row.title,
    content,
    force,
  });
  setSourceProcessingState(sourceId, 'ready');
  await Promise.resolve();
}
