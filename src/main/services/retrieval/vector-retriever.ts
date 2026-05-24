import type { SourceKind, SourceRecord, SourceScope, SourceUsage } from '@shared/types';
import { ensureNodeSourceLinksSchema, getDb } from '../db/sqlite';
import { embedText } from './embedding-service';
import type { RetrievalCandidate, RetrievalQuery, RetrievalResult } from './types';

interface VectorRow {
  chunk_id: string;
  source_id: string;
  content: string;
  locator: string | null;
  heading_path: string | null;
  page: number | null;
  embedding_json: string;
  kind: string;
  origin?: SourceRecord['origin'] | null;
  scope: SourceScope;
  usage: SourceUsage;
  trust_score: number;
  id: string;
  course_id: string;
  node_id: string | null;
  title: string;
  remark?: string | null;
  url: string | null;
  original_path?: string | null;
  file_path: string | null;
  media_type?: string | null;
  host: string | null;
  enabled: number;
  hit_count?: number | null;
  last_hit_at?: string | null;
  created_at: string;
  visible_scope?: SourceScope | null;
  linked_to_node?: number | null;
  link_enabled?: number | null;
  embedding_status?: string | null;
  chunk_count?: number | null;
  last_indexed_at?: string | null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toSource(row: VectorRow, displayScope?: SourceScope): SourceRecord {
  return {
    id: row.id,
    courseId: row.course_id,
    nodeId: row.node_id,
    scope: row.scope,
    displayScope: displayScope ?? row.visible_scope ?? undefined,
    usage: row.usage,
    kind: row.kind as SourceKind,
    origin: row.origin ?? (row.kind === 'generated' ? 'ai_generated' : row.kind === 'web' ? 'web_collected' : 'user_import'),
    title: row.title,
    remark: row.remark ?? undefined,
    url: row.url,
    originalPath: row.original_path ?? undefined,
    filePath: row.file_path,
    mediaType: row.media_type ?? undefined,
    host: row.host,
    trustScore: row.trust_score,
    enabled: row.linked_to_node === 1 && row.link_enabled !== undefined && row.link_enabled !== null
      ? row.link_enabled === 1
      : row.enabled === 1,
    linkedToNode: row.linked_to_node === 1,
    hitCount: row.hit_count ?? undefined,
    lastHitAt: row.last_hit_at ?? undefined,
    embeddingStatus: (row.embedding_status as SourceRecord['embeddingStatus']) ?? undefined,
    chunkCount: row.chunk_count ?? undefined,
    lastIndexedAt: row.last_indexed_at ?? undefined,
    createdAt: row.created_at,
  };
}

export async function vectorRetrieve(input: RetrievalQuery): Promise<RetrievalResult> {
  const limit = Math.min(input.limit ?? 8, 20);
  if (input.scope === 'node_private' || (input.nodeId && input.agentType !== 'main_tutor')) {
    ensureNodeSourceLinksSchema();
  }
  const embeddingCount = getDb()
    .prepare<[string], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM source_chunk_embeddings e
       JOIN source_chunks c ON c.id = e.chunk_id
       WHERE c.course_id = ?`,
    )
    .get(input.courseId)?.count ?? 0;
  if (embeddingCount === 0) return { candidates: [], sources: [], method: 'vector' };

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(input.query);
  } catch {
    return { candidates: [], sources: [], method: 'vector' };
  }
  if (queryEmbedding.length === 0) return { candidates: [], sources: [], method: 'vector' };

  const params: unknown[] = [input.courseId];
  let scopeClause = '';
  if (input.scope === 'node_private') {
    if (!input.nodeId) {
      scopeClause = ' AND 0 = 1';
    } else {
      scopeClause = ` AND (
        (sr.scope = 'node_private' AND sr.node_id = ? AND sr.enabled = 1)
        OR (
          sr.scope = 'main_private'
          AND EXISTS (
            SELECT 1 FROM node_source_links nsl
            WHERE nsl.source_id = sr.id
              AND nsl.course_id = sr.course_id
              AND nsl.node_id = ?
              AND nsl.enabled = 1
          )
        )
      )`;
      params.push(input.nodeId, input.nodeId);
    }
  } else if (input.scope) {
    scopeClause = ' AND sr.scope = ? AND sr.enabled = 1';
    params.push(input.scope);
  } else if (input.agentType === 'main_tutor' || !input.nodeId) {
    scopeClause = ` AND sr.scope = 'main_private' AND sr.enabled = 1`;
  } else {
    scopeClause = ` AND (
      (sr.scope = 'node_private' AND sr.node_id = ? AND sr.enabled = 1)
      OR (
        sr.scope = 'main_private'
        AND EXISTS (
          SELECT 1 FROM node_source_links nsl
          WHERE nsl.source_id = sr.id
            AND nsl.course_id = sr.course_id
            AND nsl.node_id = ?
            AND nsl.enabled = 1
        )
      )
    )`;
    params.push(input.nodeId, input.nodeId);
  }
  let kindClause = '';
  if (input.sourceKinds?.length) {
    kindClause = ` AND sr.kind IN (${input.sourceKinds.map(() => '?').join(',')})`;
    params.push(...input.sourceKinds);
  }
  const selectParams: unknown[] = [];
  const linkEnabledExpression = input.nodeId && input.agentType !== 'main_tutor'
    ? `(SELECT nsl.enabled FROM node_source_links nsl WHERE nsl.source_id = sr.id AND nsl.course_id = sr.course_id AND nsl.node_id = ? LIMIT 1)`
    : 'NULL';
  if (input.nodeId && input.agentType !== 'main_tutor') selectParams.push(input.nodeId);

  const rows = getDb()
    .prepare(
      `SELECT
         c.id AS chunk_id, c.source_id, c.content, c.locator, c.heading_path, c.page,
         e.embedding_json,
         sr.*,
         ${input.nodeId && input.agentType !== 'main_tutor' ? `CASE WHEN sr.scope = 'main_private' THEN 1 ELSE 0 END` : '0'} AS linked_to_node,
         ${linkEnabledExpression} AS link_enabled,
         m.embedding_status, m.chunk_count, m.last_indexed_at
       FROM source_chunk_embeddings e
       JOIN source_chunks c ON c.id = e.chunk_id
       JOIN source_records sr ON sr.id = c.source_id
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE c.course_id = ? ${scopeClause}
       ${kindClause}`,
    )
    .all(...selectParams, ...params) as VectorRow[];

  const scored = rows
    .map((row) => {
      let embedding: number[] = [];
      try { embedding = JSON.parse(row.embedding_json) as number[]; } catch { embedding = []; }
      return { row, score: cosine(queryEmbedding, embedding) };
    })
    .filter((item) => item.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const usedSources = new Map<string, SourceRecord>();
  const candidates = scored.map(({ row, score }) => {
    const source = toSource(row, input.scope === 'node_private' ? 'node_private' : undefined);
    usedSources.set(source.id, source);
    return {
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      text: row.content,
      locator: row.locator ?? undefined,
      score,
      vectorScore: score,
      finalScore: score,
      sourceKind: source.kind,
      headingPath: row.heading_path ? JSON.parse(row.heading_path) as string[] : undefined,
      page: row.page ?? undefined,
      retrievalMethod: 'vector',
    } satisfies RetrievalCandidate;
  });

  return { candidates, sources: [...usedSources.values()], method: 'vector' };
}
