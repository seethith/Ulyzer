import type { SourceKind, SourceRecord, SourceScope, SourceUsage } from '@shared/types';
import { ensureNodeSourceLinksSchema, getDb } from '../db/sqlite';
import type { RetrievalCandidate, RetrievalQuery, RetrievalResult } from './types';

interface SourceRow {
  id: string;
  course_id: string;
  node_id: string | null;
  scope: SourceScope;
  usage: SourceUsage;
  kind: string;
  origin?: SourceRecord['origin'] | null;
  title: string;
  remark?: string | null;
  url: string | null;
  original_path?: string | null;
  file_path: string | null;
  media_type?: string | null;
  host: string | null;
  trust_score: number;
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

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  content: string;
  locator: string | null;
  heading_path: string | null;
  page: number | null;
  chunk_index?: number;
  rank_score?: number;
}

const ROADMAP_STRUCTURE_TERMS = [
  '目录',
  '目 录',
  'contents',
  'table of contents',
  'chapter',
  '第 1 章',
  '第一章',
  '第1章',
  '课程大纲',
  '教学大纲',
  '学习目标',
  'learning objectives',
  'syllabus',
  'curriculum',
  '前言',
  '概述',
  'preface',
  'overview',
  '习题',
  '练习',
  '实验',
  'project',
  'assignment',
  'exercise',
] as const;

function toSource(row: SourceRow, displayScope?: SourceScope): SourceRecord {
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

function sanitizeFts(query: string): string {
  return query.trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*]/g, ''))
    .filter(Boolean)
    .join(' ');
}

function queryTerms(query: string, taskType = 'chat'): string[] {
  const terms = new Set<string>();
  query
    .toLowerCase()
    .split(/[\s,，。；;:：、/\\|()[\]{}"'`]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 40)
    .forEach((token) => terms.add(token));

  for (const term of ROADMAP_STRUCTURE_TERMS) {
    const lower = term.toLowerCase();
    if (query.toLowerCase().includes(lower) || taskType === 'roadmap') terms.add(lower);
  }
  return [...terms].slice(0, 16);
}

function sourceWhere(input: RetrievalQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [input.courseId];
  let sql = 'sr.course_id = ?';

  if (input.scope === 'node_private') {
    if (!input.nodeId) {
      sql += ' AND 0 = 1';
    } else {
      sql += ` AND (
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
    sql += ' AND sr.scope = ? AND sr.enabled = 1';
    params.push(input.scope);
  } else if (input.agentType === 'main_tutor' || !input.nodeId) {
    sql += ` AND sr.scope = 'main_private' AND sr.enabled = 1`;
  } else {
    sql += ` AND (
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

  if (input.sourceKinds?.length) {
    sql += ` AND sr.kind IN (${input.sourceKinds.map(() => '?').join(',')})`;
    params.push(...input.sourceKinds);
  }
  return { sql, params };
}

export function lexicalRetrieve(input: RetrievalQuery): RetrievalResult {
  const limit = Math.min(input.limit ?? 8, 20);
  if (input.scope === 'node_private' || (input.nodeId && input.agentType !== 'main_tutor')) {
    ensureNodeSourceLinksSchema();
  }
  const where = sourceWhere(input);
  const linkedExpression = input.nodeId && input.agentType !== 'main_tutor'
    ? `CASE WHEN sr.scope = 'main_private' THEN 1 ELSE 0 END`
    : '0';
  const selectParams: unknown[] = [];
  const linkEnabledExpression = input.nodeId && input.agentType !== 'main_tutor'
    ? `(SELECT nsl.enabled FROM node_source_links nsl WHERE nsl.source_id = sr.id AND nsl.course_id = sr.course_id AND nsl.node_id = ? LIMIT 1)`
    : 'NULL';
  if (input.nodeId && input.agentType !== 'main_tutor') selectParams.push(input.nodeId);
  const sourceRows = getDb()
    .prepare(
      `SELECT sr.*,
              ${linkedExpression} AS linked_to_node,
              ${linkEnabledExpression} AS link_enabled,
              m.embedding_status, m.chunk_count, m.last_indexed_at
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE ${where.sql}`,
    )
    .all(...selectParams, ...where.params) as SourceRow[];
  if (sourceRows.length === 0) return { candidates: [], sources: [], method: 'lexical' };

  const sourceMap = new Map(sourceRows.map((row) => [
    row.id,
    toSource(row, input.scope === 'node_private' ? 'node_private' : undefined),
  ]));
  const sourceIds = [...sourceMap.keys()];
  const sanitized = sanitizeFts(input.query);
  let rows: ChunkRow[] = [];

  if (sanitized) {
    try {
      rows = getDb()
        .prepare(
          `SELECT f.chunk_id, f.source_id, c.content, c.locator, c.heading_path, c.page, rank AS rank_score
           FROM source_chunks_fts f
           JOIN source_chunks c ON c.id = f.chunk_id
           WHERE source_chunks_fts MATCH ? AND f.source_id IN (${sourceIds.map(() => '?').join(',')})
           ORDER BY rank LIMIT ?`,
        )
        .all(sanitized, ...sourceIds, limit) as ChunkRow[];
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    const terms = queryTerms(input.query, input.taskType);
    if (terms.length > 0) {
      const likeClauses = terms.map(() => 'LOWER(COALESCE(indexed_content, content)) LIKE ?');
      rows = getDb()
        .prepare(
          `SELECT id AS chunk_id, source_id, content, locator, heading_path, page, chunk_index
           FROM source_chunks
           WHERE source_id IN (${sourceIds.map(() => '?').join(',')})
             AND (${likeClauses.join(' OR ')})
           ORDER BY
             CASE WHEN page IS NULL THEN 999999 ELSE page END ASC,
             chunk_index ASC
           LIMIT ?`,
        )
        .all(...sourceIds, ...terms.map((term) => `%${term}%`), limit) as ChunkRow[];
    }
  }

  if (rows.length === 0) {
    rows = getDb()
      .prepare(
        `SELECT id AS chunk_id, source_id, content, locator, heading_path, page, chunk_index
         FROM source_chunks
         WHERE source_id IN (${sourceIds.map(() => '?').join(',')})
         ORDER BY
           CASE WHEN page IS NULL THEN 999999 ELSE page END ASC,
           chunk_index ASC
         LIMIT ?`,
      )
      .all(...sourceIds, limit) as ChunkRow[];
  }

  const usedSources = new Map<string, SourceRecord>();
  const candidates = rows.map((row, index) => {
    const source = sourceMap.get(row.source_id);
    if (source) usedSources.set(source.id, source);
    const lexicalScore = Math.max(0.1, 1 - index * 0.07);
    return {
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      text: row.content,
      locator: row.locator ?? `chunk ${index + 1}`,
      score: lexicalScore,
      lexicalScore,
      finalScore: lexicalScore,
      sourceKind: source?.kind ?? 'upload',
      headingPath: row.heading_path ? JSON.parse(row.heading_path) as string[] : undefined,
      page: row.page ?? undefined,
      retrievalMethod: 'lexical',
    } satisfies RetrievalCandidate;
  });

  return { candidates, sources: [...usedSources.values()], method: 'lexical' };
}
