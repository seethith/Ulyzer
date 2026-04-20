import { getDb } from '../db/sqlite';
import { RagChunk } from '../../../../shared/types';
import { createLogger } from '../../utils/logger';

const log = createLogger('RAG/retriever');

const TOP_K = 5;

/**
 * Retrieve top-k relevant chunks from FTS5 index for a given node.
 * Falls back to recency-ordered chunks if query is empty.
 */
export function retrieveChunks(nodeId: string, query: string, k = TOP_K): RagChunk[] {
  const db = getDb();

  if (!query.trim()) {
    // No query – return most recent chunks for the node
    return db
      .prepare<[string, number], { id: string; file_id: string; node_id: string; chunk_index: number; source_name: string; content: string }>(
        `SELECT id, file_id, node_id, chunk_index, source_name, content
         FROM file_chunks WHERE node_id = ?
         ORDER BY rowid DESC LIMIT ?`
      )
      .all(nodeId, k)
      .map((r) => ({
        id: r.id,
        fileId: r.file_id,
        nodeId: r.node_id,
        chunkIndex: r.chunk_index,
        sourceName: r.source_name ?? '',
        content: r.content,
      }));
  }

  // FTS5 match query – restrict to chunks belonging to the node
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))   // sanitize special chars
    .filter((t) => t.length > 0)
    .join(' ');

  try {
    const rows = db
      .prepare<[string, string, number], { chunk_id: string; node_id: string; content: string }>(
        `SELECT f.chunk_id, f.node_id, f.content
         FROM file_chunks_fts f
         WHERE file_chunks_fts MATCH ? AND f.node_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, nodeId, k);

    // Fetch chunk metadata from file_chunks to get file_id, chunk_index, and source_name
    return rows.map((row) => {
      const meta = db
        .prepare<[string], { file_id: string; chunk_index: number; source_name: string }>(
          'SELECT file_id, chunk_index, source_name FROM file_chunks WHERE id = ?'
        )
        .get(row.chunk_id);

      if (!meta) {
        log.warn('FTS chunk missing metadata', { chunkId: row.chunk_id, nodeId: row.node_id });
      }
      return {
        id: row.chunk_id,
        fileId: meta?.file_id ?? '',
        nodeId: row.node_id,
        chunkIndex: meta?.chunk_index ?? 0,
        sourceName: meta?.source_name ?? '',
        content: row.content,
      };
    });
  } catch {
    // FTS query syntax error – fall back to empty result
    return [];
  }
}
