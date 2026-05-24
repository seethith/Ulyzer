import { randomUUID } from 'crypto';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type {
  AgentType,
  EvidenceChunk,
  SourceListRequest,
  SourceLibraryStats,
  SourceEmbeddingStatus,
  SourceProcessingState,
  SourceImportTextRequest,
  SourceOrigin,
  SourceLinkAddRequest,
  SourceLinkCandidatesRequest,
  SourceLinkRemoveRequest,
  SourceLinkUpdateRequest,
  SourceKind,
  SourceRecord,
  SourceSemanticProfileStatus,
  SourceScope,
  SourceStatsRequest,
  SourceUsage,
} from '@shared/types';
import { ensureNodeSourceLinksSchema, getDb } from '../db/sqlite';
import { learningMetadataForSource } from '../learning-search/learning-source-metadata';
import { indexSourceContent, initializeSourceIndexMeta } from './source-indexer';
import {
  deleteCourseLibraryAssets,
  deleteCourseLibraryAssetsBySourceId,
  deleteSourceAsset,
  getCourseLibraryDir,
  getLibraryRoot,
} from './source-assets';
import { recordCleanupFailure } from '../storage/storage-cleanup';

interface SourceRow {
  id: string;
  course_id: string;
  node_id: string | null;
  thread_id?: string | null;
  session_id?: string | null;
  scope: SourceScope;
  usage: SourceUsage;
  kind: string;
  origin?: SourceOrigin | null;
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
  embedding_status?: SourceEmbeddingStatus | null;
  processing_state?: SourceProcessingState | null;
  processing_error?: string | null;
  chunk_count?: number | null;
  document_unit_count?: number | null;
  document_block_count?: number | null;
  document_text_unit_count?: number | null;
  document_ocr_pending_count?: number | null;
  document_ocr_failed_count?: number | null;
  document_page_asset_count?: number | null;
  exercise_count?: number | null;
  usable_exercise_count?: number | null;
  exercise_answer_count?: number | null;
  exercise_solution_count?: number | null;
  semantic_profile_status?: SourceSemanticProfileStatus | null;
  semantic_profile_summary?: string | null;
  semantic_profile_concepts_json?: string | null;
  semantic_profile_suitable_for_json?: string | null;
  semantic_profile_difficulty?: string | null;
  semantic_profile_content_types_json?: string | null;
  semantic_profile_quality_notes?: string | null;
  semantic_profile_node_hints_json?: string | null;
  semantic_profile_model?: string | null;
  semantic_profile_updated_at?: string | null;
  semantic_profile_error?: string | null;
  last_indexed_at?: string | null;
}

function parseStringArrayJson(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    courseId: row.course_id,
    nodeId: row.node_id,
    threadId: row.thread_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    scope: row.scope,
    displayScope: row.visible_scope ?? undefined,
    usage: row.usage,
    kind: row.kind as SourceKind,
    origin: row.origin ?? inferLegacySourceOrigin(row),
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
    embeddingStatus: row.embedding_status ?? undefined,
    processingState: row.processing_state ?? undefined,
    processingError: row.processing_error ?? undefined,
    chunkCount: row.chunk_count ?? undefined,
    documentUnitCount: row.document_unit_count ?? undefined,
    documentBlockCount: row.document_block_count ?? undefined,
    documentTextUnitCount: row.document_text_unit_count ?? undefined,
    documentOcrPendingCount: row.document_ocr_pending_count ?? undefined,
    documentOcrFailedCount: row.document_ocr_failed_count ?? undefined,
    documentPageAssetCount: row.document_page_asset_count ?? undefined,
    exerciseCount: row.exercise_count ?? undefined,
    usableExerciseCount: row.usable_exercise_count ?? undefined,
    exerciseWithAnswerCount: row.exercise_answer_count ?? undefined,
    exerciseWithSolutionCount: row.exercise_solution_count ?? undefined,
    semanticProfile: row.semantic_profile_status ? {
      sourceId: row.id,
      status: row.semantic_profile_status,
      summary: row.semantic_profile_summary ?? undefined,
      concepts: parseStringArrayJson(row.semantic_profile_concepts_json),
      suitableFor: parseStringArrayJson(row.semantic_profile_suitable_for_json),
      difficulty: row.semantic_profile_difficulty ?? undefined,
      contentTypes: parseStringArrayJson(row.semantic_profile_content_types_json),
      qualityNotes: row.semantic_profile_quality_notes ?? undefined,
      nodeHints: parseStringArrayJson(row.semantic_profile_node_hints_json),
      model: row.semantic_profile_model ?? undefined,
      updatedAt: row.semantic_profile_updated_at ?? undefined,
      error: row.semantic_profile_error ?? undefined,
    } : undefined,
    learningMetadata: learningMetadataForSource(row.id),
    lastIndexedAt: row.last_indexed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function resolveSourceScope(nodeId?: string | null, explicit?: SourceScope): SourceScope {
  if (explicit) return explicit;
  return nodeId ? 'node_private' : 'main_private';
}

function resolveSourceUsage(input: {
  scope: SourceScope;
  kind?: SourceKind;
  explicit?: SourceUsage;
}): SourceUsage {
  if (input.explicit) return input.explicit;
  if (input.scope === 'main_private') return 'planning_only';
  return input.kind === 'generated' ? 'node_local' : 'node_local';
}

function inferLegacySourceOrigin(row: Pick<SourceRow, 'kind' | 'remark' | 'thread_id' | 'session_id'>): SourceOrigin {
  if (row.kind === 'generated') return 'ai_generated';
  if (row.kind === 'web') return 'web_collected';
  if (row.remark === '对话附件' || row.thread_id || row.session_id) return 'chat_attachment';
  return 'user_import';
}

function listScopeClause(input: SourceListRequest): { where: string; params: Array<string | null> } {
  if (input.agentType === 'main_tutor') {
    if (input.scope === 'node_private') return { where: '0 = 1', params: [] };
    return { where: `sr.scope = 'main_private'`, params: [] };
  }

  if (!input.nodeId) {
    return { where: '0 = 1', params: [] };
  }

  if (input.scope === 'main_private') {
    return { where: '0 = 1', params: [] };
  }

  return {
    where: `(
      (sr.scope = 'node_private' AND sr.node_id = ?)
      OR (
        sr.scope = 'main_private'
        AND EXISTS (
          SELECT 1 FROM node_source_links nsl
          WHERE nsl.source_id = sr.id
            AND nsl.course_id = sr.course_id
            AND nsl.node_id = ?
        )
      )
    )`,
    params: [input.nodeId, input.nodeId],
  };
}

function statsWarnings(input: Omit<SourceLibraryStats, 'warnings'>): string[] {
  const warnings: string[] = [];
  if (input.failedIndex > 0) warnings.push(`有 ${input.failedIndex} 条参考资料索引失败，建议重建索引。`);
  if (input.pendingIndex > 0) warnings.push(`有 ${input.pendingIndex} 条参考资料仍待索引。`);
  if (input.duplicateHostSources >= 3) warnings.push(`重复站点来源偏多（${input.duplicateHostSources} 条）。`);
  if (input.duplicateTitleCount >= 2) warnings.push(`相似标题参考资料较多（${input.duplicateTitleCount} 组），建议整理。`);
  if (input.lowQualitySources >= 3) warnings.push(`低可信网页偏多（${input.lowQualitySources} 条）。`);
  if (input.totalSources >= 24 || input.chunkCount >= 1800) warnings.push('参考资料较多，建议整理，以保持检索质量。');
  if (input.archiveCandidateCount > 0) warnings.push(`有 ${input.archiveCandidateCount} 条低可信旧网页可作为归档候选。`);
  return warnings;
}

function retrievalScopeClause(input: { nodeId?: string; agentType?: AgentType }): { where: string; params: Array<string | null> } {
  if (input.agentType === 'main_tutor' || !input.nodeId) {
    return { where: `sr.scope = 'main_private'`, params: [] };
  }
  return {
    where: `(
      (sr.scope = 'node_private' AND sr.node_id = ?)
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
    )`,
    params: [input.nodeId, input.nodeId],
  };
}

function safeHost(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function decorateIndexedContent(content: string, remark?: string | null): string {
  const trimmedRemark = remark?.trim();
  if (!trimmedRemark) return content;
  return [`参考备注：${trimmedRemark}`, content].filter(Boolean).join('\n\n');
}

function sourceSelect(viewScope?: SourceScope, linkedExpression = '0', linkEnabledExpression = 'NULL'): string {
  const visibleScope = viewScope === 'node_private'
    ? `CASE WHEN sr.scope = 'main_private' AND (${linkedExpression}) = 1 THEN 'node_private' ELSE sr.scope END`
    : 'sr.scope';
  return `sr.*,
    ${visibleScope} AS visible_scope,
    ${linkedExpression} AS linked_to_node,
    ${linkEnabledExpression} AS link_enabled,
    m.embedding_status AS embedding_status,
    m.processing_state AS processing_state,
    m.processing_error AS processing_error,
    m.chunk_count AS chunk_count,
    (SELECT COUNT(*) FROM source_document_units du WHERE du.source_id = sr.id) AS document_unit_count,
    (SELECT COUNT(*) FROM source_document_blocks db WHERE db.source_id = sr.id) AS document_block_count,
    (SELECT COUNT(*) FROM source_document_units du WHERE du.source_id = sr.id AND du.char_count > 0) AS document_text_unit_count,
    (SELECT COUNT(*) FROM source_document_units du WHERE du.source_id = sr.id AND du.ocr_state = 'pending' AND du.unit_type IN ('page', 'image')) AS document_ocr_pending_count,
    (SELECT COUNT(*) FROM source_document_units du WHERE du.source_id = sr.id AND du.ocr_state = 'failed' AND du.unit_type IN ('page', 'image')) AS document_ocr_failed_count,
    (SELECT COUNT(*) FROM source_document_page_assets pa WHERE pa.source_id = sr.id) AS document_page_asset_count,
    (SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id) AS exercise_count,
    (SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.status = 'usable') AS usable_exercise_count,
    (SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.answer_md IS NOT NULL AND length(se.answer_md) > 0) AS exercise_answer_count,
    (SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.solution_md IS NOT NULL AND length(se.solution_md) > 0) AS exercise_solution_count,
    (SELECT sp.status FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_status,
    (SELECT sp.summary FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_summary,
    (SELECT sp.concepts_json FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_concepts_json,
    (SELECT sp.suitable_for_json FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_suitable_for_json,
    (SELECT sp.difficulty FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_difficulty,
    (SELECT sp.content_types_json FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_content_types_json,
    (SELECT sp.quality_notes FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_quality_notes,
    (SELECT sp.node_hints_json FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_node_hints_json,
    (SELECT sp.model FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_model,
    (SELECT sp.updated_at FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_updated_at,
    (SELECT sp.error FROM source_semantic_profiles sp WHERE sp.source_id = sr.id) AS semantic_profile_error,
    m.last_indexed_at AS last_indexed_at`;
}

function deleteSourceIndexRows(sourceId: string): void {
  const rows = getDb()
    .prepare<[string], { id: string }>('SELECT id FROM source_chunks WHERE source_id = ?')
    .all(sourceId);
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM source_chunks_fts WHERE chunk_id IN (${placeholders})`).run(...ids);
  getDb().prepare(`DELETE FROM source_chunks WHERE id IN (${placeholders})`).run(...ids);
}

export function listSources(input: SourceListRequest): SourceRecord[] {
  ensureNodeSourceLinksSchema();
  const visibility = listScopeClause(input);
  const linkedExpression = input.agentType === 'sub_tutor' && input.nodeId
    ? `CASE WHEN sr.scope = 'main_private' THEN 1 ELSE 0 END`
    : '0';
  const selectParams: unknown[] = [];
  const linkEnabledExpression = input.agentType === 'sub_tutor' && input.nodeId
    ? `(SELECT nsl.enabled FROM node_source_links nsl WHERE nsl.source_id = sr.id AND nsl.course_id = sr.course_id AND nsl.node_id = ? LIMIT 1)`
    : 'NULL';
  if (input.agentType === 'sub_tutor' && input.nodeId) selectParams.push(input.nodeId);
  const displayScope = input.scope ?? (input.agentType === 'sub_tutor' && input.nodeId ? 'node_private' : undefined);
  const rows = getDb()
    .prepare(
      `SELECT ${sourceSelect(displayScope, linkedExpression, linkEnabledExpression)}
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE sr.course_id = ? AND ${visibility.where}
       ORDER BY
         CASE
           WHEN sr.scope = 'node_private' THEN 0
           WHEN sr.scope = 'main_private' THEN 1
           ELSE 2
         END,
         sr.created_at DESC`,
    )
    .all(...selectParams, input.courseId, ...visibility.params) as SourceRow[];
  return rows.map(toRecord);
}

export function listLinkableMainSources(input: SourceLinkCandidatesRequest): SourceRecord[] {
  ensureNodeSourceLinksSchema();
  const query = input.query?.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 80, 200));
  const params: unknown[] = [input.courseId, input.nodeId];
  let filter = '';
  if (query) {
    filter = `AND (
      LOWER(sr.title) LIKE ?
      OR LOWER(COALESCE(sr.remark, '')) LIKE ?
      OR LOWER(COALESCE(sr.url, '')) LIKE ?
      OR LOWER(COALESCE(sr.host, '')) LIKE ?
    )`;
    const like = `%${query.toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT ${sourceSelect('main_private')}
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE sr.course_id = ?
         AND sr.scope = 'main_private'
         AND sr.enabled = 1
         AND NOT EXISTS (
           SELECT 1 FROM node_source_links nsl
           WHERE nsl.source_id = sr.id
             AND nsl.course_id = sr.course_id
             AND nsl.node_id = ?
         )
         ${filter}
       ORDER BY sr.created_at DESC
       LIMIT ?`,
    )
    .all(...params) as SourceRow[];
  return rows.map(toRecord);
}

export function linkMainSourcesToNode(input: SourceLinkAddRequest): SourceRecord[] {
  ensureNodeSourceLinksSchema();
  const sourceIds = [...new Set(input.sourceIds.filter(Boolean))];
  if (sourceIds.length === 0) return listSources({
    courseId: input.courseId,
    nodeId: input.nodeId,
    agentType: 'sub_tutor',
    scope: 'node_private',
  });

  const db = getDb();
  const node = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM dag_nodes WHERE id = ? AND course_id = ?',
  ).get(input.nodeId, input.courseId);
  if (!node) throw new Error('节点不存在，无法导入主导师资料。');
  const placeholders = sourceIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id
       FROM source_records
       WHERE course_id = ?
         AND scope = 'main_private'
         AND enabled = 1
         AND id IN (${placeholders})`,
    )
    .all(input.courseId, ...sourceIds) as Array<{ id: string }>;
  const allowedIds = rows.map((row) => row.id);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO node_source_links (id, course_id, node_id, source_id, enabled, reason)
     VALUES (@id, @course_id, @node_id, @source_id, 1, @reason)`,
  );
  const tx = db.transaction((ids: string[]) => {
    for (const sourceId of ids) {
      insert.run({
        id: randomUUID(),
        course_id: input.courseId,
        node_id: input.nodeId,
        source_id: sourceId,
        reason: input.reason?.trim() || null,
      });
    }
  });
  tx(allowedIds);
  return listSources({
    courseId: input.courseId,
    nodeId: input.nodeId,
    agentType: 'sub_tutor',
    scope: 'node_private',
  });
}

export function updateMainSourceLinkForNode(input: SourceLinkUpdateRequest): SourceRecord | null {
  ensureNodeSourceLinksSchema();
  const db = getDb();
  db.prepare(
    `UPDATE node_source_links
     SET enabled = ?
     WHERE course_id = ?
       AND node_id = ?
       AND source_id = ?`,
  ).run(input.enabled ? 1 : 0, input.courseId, input.nodeId, input.sourceId);

  const row = db
    .prepare(
      `SELECT ${sourceSelect('node_private', '1', 'nsl.enabled')}
       FROM source_records sr
       JOIN node_source_links nsl
         ON nsl.source_id = sr.id
        AND nsl.course_id = sr.course_id
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE nsl.course_id = ?
         AND nsl.node_id = ?
         AND nsl.source_id = ?
         AND sr.scope = 'main_private'
       LIMIT 1`,
    )
    .get(input.courseId, input.nodeId, input.sourceId) as SourceRow | undefined;
  return row ? toRecord(row) : null;
}

export function unlinkMainSourceFromNode(input: SourceLinkRemoveRequest): void {
  ensureNodeSourceLinksSchema();
  getDb()
    .prepare(
      `DELETE FROM node_source_links
       WHERE course_id = ?
         AND node_id = ?
         AND source_id = ?`,
    )
    .run(input.courseId, input.nodeId, input.sourceId);
}

export function deleteSourceLinksForNode(nodeId: string): number {
  ensureNodeSourceLinksSchema();
  return getDb().prepare('DELETE FROM node_source_links WHERE node_id = ?').run(nodeId).changes;
}

export function getSourceLibraryStats(input: SourceStatsRequest): SourceLibraryStats {
  ensureNodeSourceLinksSchema();
  const visibility = listScopeClause(input);
  const baseParams = [input.courseId, ...visibility.params];
  const baseWhere = `sr.course_id = ? AND ${visibility.where}`;

  const summary = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total_sources,
         SUM(CASE WHEN sr.enabled = 1 THEN 1 ELSE 0 END) AS enabled_sources,
         COALESCE(SUM(m.chunk_count), 0) AS chunk_count,
         COALESCE(SUM((SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id)), 0) AS exercise_count,
         COALESCE(SUM((SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.status = 'usable')), 0) AS usable_exercise_count,
         COALESCE(SUM((SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.answer_md IS NOT NULL AND length(se.answer_md) > 0)), 0) AS exercise_answer_count,
         COALESCE(SUM((SELECT COUNT(*) FROM source_exercises se WHERE se.source_id = sr.id AND se.solution_md IS NOT NULL AND length(se.solution_md) > 0)), 0) AS exercise_solution_count,
         SUM(CASE WHEN m.embedding_status = 'ready' THEN 1 ELSE 0 END) AS semantic_ready,
         SUM(CASE WHEN m.embedding_status IN ('lexical_only', 'skipped') THEN 1 ELSE 0 END) AS lexical_only,
         SUM(CASE WHEN m.embedding_status = 'pending' THEN 1 ELSE 0 END) AS pending_index,
         SUM(CASE WHEN m.embedding_status = 'failed' THEN 1 ELSE 0 END) AS failed_index,
         SUM(CASE WHEN sr.kind = 'web' AND sr.trust_score < 0.6 THEN 1 ELSE 0 END) AS low_quality_sources,
         SUM(CASE
           WHEN sr.enabled = 1
            AND COALESCE(sr.hit_count, 0) = 0
            AND COALESCE(sr.origin, CASE WHEN sr.kind = 'generated' THEN 'ai_generated' ELSE '' END) != 'ai_generated'
            AND COALESCE(sr.kind, '') != 'generated'
            AND COALESCE(m.processing_state, 'ready') NOT IN ('pending', 'partial', 'failed')
           THEN 1 ELSE 0
         END) AS never_hit_sources
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE ${baseWhere}`,
    )
    .get(...baseParams) as {
      total_sources: number | null;
      enabled_sources: number | null;
      chunk_count: number | null;
      exercise_count: number | null;
      usable_exercise_count: number | null;
      exercise_answer_count: number | null;
      exercise_solution_count: number | null;
      semantic_ready: number | null;
      lexical_only: number | null;
      pending_index: number | null;
      failed_index: number | null;
      low_quality_sources: number | null;
      never_hit_sources: number | null;
    } | undefined;

  const duplicateRows = getDb()
    .prepare(
      `SELECT sr.host, COUNT(*) AS source_count
       FROM source_records sr
       WHERE ${baseWhere} AND sr.host IS NOT NULL
       GROUP BY sr.host
       HAVING COUNT(*) > 1`,
    )
    .all(...baseParams) as Array<{ host: string; source_count: number }>;

  const duplicateTitleRows = getDb()
    .prepare(
      `SELECT LOWER(TRIM(sr.title)) AS normalized_title, COUNT(*) AS source_count
       FROM source_records sr
       WHERE ${baseWhere} AND LENGTH(TRIM(sr.title)) >= 6
       GROUP BY LOWER(TRIM(sr.title))
       HAVING COUNT(*) > 1`,
    )
    .all(...baseParams) as Array<{ normalized_title: string; source_count: number }>;

  const archiveCandidateRows = getDb()
    .prepare(
      `SELECT sr.title
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE ${baseWhere}
         AND sr.enabled = 1
         AND COALESCE(sr.hit_count, 0) = 0
         AND COALESCE(sr.kind, '') = 'web'
         AND COALESCE(sr.trust_score, 0) < 0.72
         AND COALESCE(m.embedding_status, 'ready') != 'pending'
       ORDER BY sr.created_at DESC
       LIMIT 6`,
    )
    .all(...baseParams) as Array<{ title: string }>;

  const stats: Omit<SourceLibraryStats, 'warnings'> = {
    totalSources: summary?.total_sources ?? 0,
    enabledSources: summary?.enabled_sources ?? 0,
    chunkCount: summary?.chunk_count ?? 0,
    exerciseCount: summary?.exercise_count ?? 0,
    usableExerciseCount: summary?.usable_exercise_count ?? 0,
    exerciseWithAnswerCount: summary?.exercise_answer_count ?? 0,
    exerciseWithSolutionCount: summary?.exercise_solution_count ?? 0,
    semanticReady: summary?.semantic_ready ?? 0,
    lexicalOnly: summary?.lexical_only ?? 0,
    pendingIndex: summary?.pending_index ?? 0,
    failedIndex: summary?.failed_index ?? 0,
    duplicateHostSources: duplicateRows.reduce((sum, row) => sum + row.source_count, 0),
    duplicateHostCount: duplicateRows.length,
    duplicateTitleCount: duplicateTitleRows.length,
    lowQualitySources: summary?.low_quality_sources ?? 0,
    neverHitSources: summary?.never_hit_sources ?? 0,
    archiveCandidateCount: archiveCandidateRows.length,
    archiveCandidateTitles: archiveCandidateRows.map((row) => row.title),
  };

  return {
    ...stats,
    warnings: statsWarnings(stats),
  };
}

export function upsertWebSource(input: {
  courseId: string;
  nodeId?: string | null;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
  title: string;
  remark?: string;
  url: string;
  content: string;
  trustScore?: number;
}): SourceRecord {
  const db = getDb();
  const host = safeHost(input.url);
  const scope = resolveSourceScope(input.nodeId, input.scope);
  const usage = resolveSourceUsage({ scope, explicit: input.usage });
  const origin = input.origin ?? 'web_collected';
  const existing = db
    .prepare<[string, string, SourceScope], SourceRow>('SELECT * FROM source_records WHERE course_id = ? AND url = ? AND scope = ? LIMIT 1')
    .get(input.courseId, input.url, scope);
  const id = existing?.id ?? randomUUID();
  const resolvedOrigin = existing?.origin === 'user_import'
    ? 'user_import'
    : origin;
  if (existing) {
    db.prepare(
      `UPDATE source_records SET title = @title, node_id = COALESCE(node_id, @node_id),
       remark = @remark, host = @host, trust_score = MAX(trust_score, @trust_score), enabled = 1,
       usage = @usage, origin = @origin, media_type = 'text/html' WHERE id = @id`,
    ).run({
      id,
      title: input.title,
      remark: input.remark ?? null,
      node_id: input.nodeId ?? null,
      host,
      trust_score: input.trustScore ?? 0.65,
      usage,
      origin: resolvedOrigin,
    });
  } else {
    db.prepare(
      `INSERT INTO source_records (id, course_id, node_id, scope, usage, kind, origin, title, remark, url, media_type, host, trust_score, enabled)
       VALUES (@id, @course_id, @node_id, @scope, @usage, 'web', @origin, @title, @remark, @url, 'text/html', @host, @trust_score, 1)`,
    ).run({
      id,
      course_id: input.courseId,
      node_id: input.nodeId ?? null,
      scope,
      usage,
      origin: resolvedOrigin,
      title: input.title,
      remark: input.remark ?? null,
      url: input.url,
      host,
      trust_score: input.trustScore ?? 0.65,
    });
  }
  indexSourceContent({
    sourceId: id,
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    sourceKind: 'web',
    fileName: input.title,
    mimeType: 'text/html',
    content: decorateIndexedContent(input.content, input.remark),
  });
  return toRecord(db.prepare<[string], SourceRow>(`SELECT ${sourceSelect()} FROM source_records sr LEFT JOIN source_document_meta m ON m.source_id = sr.id WHERE sr.id = ?`).get(id)!);
}

export function findWebSourceByUrl(
  courseId: string,
  url: string,
  options?: { nodeId?: string; agentType?: AgentType; scope?: SourceScope },
): SourceRecord | null {
  ensureNodeSourceLinksSchema();
  if (options?.scope === 'node_private' && !options.nodeId) return null;
  if (options?.scope && !(options.scope === 'node_private' && options.nodeId)) {
    const visibility = `sr.scope = ?`;
    const row = getDb()
      .prepare(
        `SELECT ${sourceSelect(options.scope)}
         FROM source_records sr
         LEFT JOIN source_document_meta m ON m.source_id = sr.id
         WHERE sr.course_id = ? AND sr.url = ? AND ${visibility} LIMIT 1`,
      )
      .get(courseId, url, options.scope) as SourceRow | undefined;
    return row ? toRecord(row) : null;
  }

  const visibility = retrievalScopeClause(options ?? {});
  const linkedExpression = options?.nodeId && options?.agentType !== 'main_tutor'
    ? `CASE WHEN sr.scope = 'main_private' THEN 1 ELSE 0 END`
    : '0';
  const selectParams: unknown[] = [];
  const linkEnabledExpression = options?.nodeId && options?.agentType !== 'main_tutor'
    ? `(SELECT nsl.enabled FROM node_source_links nsl WHERE nsl.source_id = sr.id AND nsl.course_id = sr.course_id AND nsl.node_id = ? LIMIT 1)`
    : 'NULL';
  if (options?.nodeId && options?.agentType !== 'main_tutor') selectParams.push(options.nodeId);
  const displayScope = options?.scope ?? (options?.nodeId && options?.agentType !== 'main_tutor' ? 'node_private' : undefined);
  const row = getDb()
    .prepare(
      `SELECT ${sourceSelect(displayScope, linkedExpression, linkEnabledExpression)}
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE sr.course_id = ? AND sr.url = ? AND ${visibility.where}
       ORDER BY
         CASE sr.scope
           WHEN 'node_private' THEN 0
           WHEN 'main_private' THEN 1
           ELSE 2
         END
       LIMIT 1`,
    )
    .get(...selectParams, courseId, url, ...visibility.params) as SourceRow | undefined;
  return row ? toRecord(row) : null;
}

export function findSourceById(
  courseId: string,
  sourceId: string,
  options?: { nodeId?: string; agentType?: AgentType; scope?: SourceScope },
): SourceRecord | null {
  ensureNodeSourceLinksSchema();
  if (options?.scope === 'node_private' && !options.nodeId) return null;
  if (options?.scope && !(options.scope === 'node_private' && options.nodeId)) {
    const visibility = `sr.scope = ?`;
    const row = getDb()
      .prepare(
        `SELECT ${sourceSelect(options.scope)}
         FROM source_records sr
         LEFT JOIN source_document_meta m ON m.source_id = sr.id
         WHERE sr.course_id = ? AND sr.id = ? AND ${visibility} LIMIT 1`,
      )
      .get(courseId, sourceId, options.scope) as SourceRow | undefined;
    return row ? toRecord(row) : null;
  }

  const visibility = retrievalScopeClause(options ?? {});
  const linkedExpression = options?.nodeId && options?.agentType !== 'main_tutor'
    ? `CASE WHEN sr.scope = 'main_private' THEN 1 ELSE 0 END`
    : '0';
  const selectParams: unknown[] = [];
  const linkEnabledExpression = options?.nodeId && options?.agentType !== 'main_tutor'
    ? `(SELECT nsl.enabled FROM node_source_links nsl WHERE nsl.source_id = sr.id AND nsl.course_id = sr.course_id AND nsl.node_id = ? LIMIT 1)`
    : 'NULL';
  if (options?.nodeId && options?.agentType !== 'main_tutor') selectParams.push(options.nodeId);
  const displayScope = options?.scope ?? (options?.nodeId && options?.agentType !== 'main_tutor' ? 'node_private' : undefined);
  const row = getDb()
    .prepare(
      `SELECT ${sourceSelect(displayScope, linkedExpression, linkEnabledExpression)}
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE sr.course_id = ? AND sr.id = ? AND ${visibility.where}
       LIMIT 1`,
    )
    .get(...selectParams, courseId, sourceId, ...visibility.params) as SourceRow | undefined;
  return row ? toRecord(row) : null;
}

export function getSourceById(sourceId: string): SourceRecord | null {
  const row = getDb()
    .prepare<[string], SourceRow>(
      `SELECT ${sourceSelect()}
       FROM source_records sr
       LEFT JOIN source_document_meta m ON m.source_id = sr.id
       WHERE sr.id = ?
       LIMIT 1`,
    )
    .get(sourceId);
  return row ? toRecord(row) : null;
}

export function getSourceChunkCount(sourceId: string): number {
  return getDb()
    .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM source_chunks WHERE source_id = ?')
    .get(sourceId)?.count ?? 0;
}

export function getSourceChunks(sourceId: string, limit = 3): EvidenceChunk[] {
  const source = getDb()
    .prepare<[string], SourceRow>('SELECT * FROM source_records WHERE id = ?')
    .get(sourceId);
  if (!source) return [];
  const rows = getDb()
    .prepare<[string, number], { id: string; content: string; locator: string | null; heading_path: string | null; page: number | null }>(
      `SELECT id, content, locator, heading_path, page FROM source_chunks
       WHERE source_id = ?
       ORDER BY chunk_index ASC LIMIT ?`,
    )
    .all(sourceId, limit);
  return rows.map((row, index) => ({
    chunkId: row.id,
    sourceId,
    text: row.content,
    locator: row.locator ?? `chunk ${index + 1}`,
    score: Math.max(0.2, 1 - index * 0.08),
    sourceKind: source.kind as SourceKind,
    headingPath: row.heading_path ? JSON.parse(row.heading_path) as string[] : undefined,
    page: row.page ?? undefined,
    retrievalMethod: 'lexical',
  }));
}

export function importTextSource(input: SourceImportTextRequest & {
  id?: string;
  kind?: SourceKind;
  origin?: SourceOrigin;
  mimeType?: string;
  pages?: Array<{ page: number; text: string }>;
  skipIndex?: boolean;
}): SourceRecord {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const scope = resolveSourceScope(input.nodeId, input.scope);
  const usage = resolveSourceUsage({ scope, kind: input.kind, explicit: input.usage });
  const origin = input.origin ?? (input.kind === 'generated' ? 'ai_generated' : 'user_import');
  db.prepare(
    `INSERT INTO source_records (
       id, course_id, node_id, thread_id, session_id, scope, usage, kind, origin,
       title, remark, url, original_path, file_path, media_type, host, trust_score, enabled
     )
     VALUES (
       @id, @course_id, @node_id, @thread_id, @session_id, @scope, @usage, @kind, @origin,
       @title, @remark, @url, @original_path, @file_path, @media_type, @host, @trust_score, 1
     )`,
  ).run({
    id,
    course_id: input.courseId,
    node_id: input.nodeId ?? null,
    thread_id: input.threadId ?? null,
    session_id: input.sessionId ?? null,
    scope,
    usage,
    kind: input.kind ?? 'upload',
    origin,
    title: input.title,
    remark: input.remark ?? null,
    url: input.url ?? null,
    original_path: input.originalPath ?? null,
    file_path: input.filePath ?? null,
    media_type: input.mimeType ?? null,
    host: safeHost(input.url ?? null),
    trust_score: input.kind === 'generated' ? 0.55 : 0.9,
  });
  if (input.skipIndex) {
    initializeSourceIndexMeta({
      sourceId: id,
      processingState: input.processingState ?? 'pending',
      processingError: input.processingError ?? null,
    });
  } else {
    indexSourceContent({
      sourceId: id,
      courseId: input.courseId,
      nodeId: input.nodeId ?? null,
      sourceKind: input.kind ?? 'upload',
      fileName: input.title,
      mimeType: input.mimeType,
      pages: input.pages,
      content: decorateIndexedContent(input.content, input.remark),
    });
  }
  return toRecord(db.prepare<[string], SourceRow>(`SELECT ${sourceSelect()} FROM source_records sr LEFT JOIN source_document_meta m ON m.source_id = sr.id WHERE sr.id = ?`).get(id)!);
}

export function replaceSourceContent(input: {
  sourceId: string;
  title?: string;
  content: string;
  mimeType?: string | null;
  pages?: Array<{ page: number; text: string }>;
}): SourceRecord {
  const db = getDb();
  const current = db
    .prepare<[string], SourceRow>('SELECT * FROM source_records WHERE id = ?')
    .get(input.sourceId);
  if (!current) throw new Error(`Source not found: ${input.sourceId}`);

  db.prepare(
    `UPDATE source_records
     SET title = @title, media_type = COALESCE(@media_type, media_type)
     WHERE id = @id`,
  ).run({
    id: input.sourceId,
    title: input.title ?? current.title,
    media_type: input.mimeType ?? current.media_type ?? null,
  });

  indexSourceContent({
    sourceId: input.sourceId,
    courseId: current.course_id,
    nodeId: current.node_id,
    sourceKind: current.kind as SourceKind,
    fileName: input.title ?? current.title,
    mimeType: input.mimeType ?? current.media_type ?? undefined,
    pages: input.pages,
    content: decorateIndexedContent(input.content, current.remark ?? null),
    force: true,
  });

  return toRecord(db.prepare<[string], SourceRow>(`SELECT ${sourceSelect()} FROM source_records sr LEFT JOIN source_document_meta m ON m.source_id = sr.id WHERE sr.id = ?`).get(input.sourceId)!);
}

export function updateSource(id: string, data: {
  enabled?: boolean;
  title?: string;
  remark?: string | null;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
}): SourceRecord {
  const current = getDb().prepare<[string], SourceRow>('SELECT * FROM source_records WHERE id = ?').get(id);
  if (!current) throw new Error(`Source not found: ${id}`);
  const nextScope = data.scope ? resolveSourceScope(current.node_id, data.scope) : current.scope;
  getDb().prepare(
    `UPDATE source_records
     SET title = @title, remark = @remark, enabled = @enabled, scope = @scope, usage = @usage, origin = @origin
     WHERE id = @id`,
  ).run({
    id,
    title: data.title ?? current.title,
    remark: data.remark === undefined ? (current.remark ?? null) : data.remark,
    enabled: data.enabled === undefined ? current.enabled : data.enabled ? 1 : 0,
    scope: nextScope,
    usage: data.usage ?? current.usage,
    origin: data.origin ?? current.origin ?? inferLegacySourceOrigin(current),
  });
  return toRecord(getDb().prepare<[string], SourceRow>(`SELECT ${sourceSelect()} FROM source_records sr LEFT JOIN source_document_meta m ON m.source_id = sr.id WHERE sr.id = ?`).get(id)!);
}

export function deleteSource(id: string): void {
  ensureNodeSourceLinksSchema();
  const current = getDb().prepare<[string], Pick<SourceRow, 'file_path' | 'course_id'>>('SELECT file_path, course_id FROM source_records WHERE id = ?').get(id);
  try {
    deleteSourceAsset(current?.file_path ?? null);
  } catch (error) {
    recordCleanupFailure({
      path: current?.file_path,
      kind: 'source-file',
      ownerType: 'source',
      ownerId: id,
      reason: '参考资料原始文件删除失败',
      error,
    });
  }
  if (current?.course_id) {
    try {
      deleteCourseLibraryAssetsBySourceId(current.course_id, id);
    } catch (error) {
      recordCleanupFailure({
        path: getCourseLibraryDir(current.course_id),
        kind: 'source-assets',
        ownerType: 'source',
        ownerId: id,
        reason: '参考资料页图/派生资产删除失败',
        error,
      });
    }
  }
  deleteSourceIndexRows(id);
  getDb().prepare('DELETE FROM node_source_links WHERE source_id = ?').run(id);
  getDb().prepare('DELETE FROM source_records WHERE id = ?').run(id);
}

export function deleteSourcesByIds(ids: string[]): number {
  const unique = [...new Set(ids.filter(Boolean))];
  for (const id of unique) {
    deleteSource(id);
  }
  return unique.length;
}

export function listPrivateSourceIdsForNode(nodeId: string): string[] {
  return getDb()
    .prepare<[string], { id: string }>(
      `SELECT id FROM source_records
       WHERE node_id = ?
         AND scope = 'node_private'`,
    )
    .all(nodeId)
    .map((row) => row.id);
}

export function deletePrivateSourcesForThread(threadId: string): number {
  const rows = getDb()
    .prepare<[string], { id: string }>(
      `SELECT id FROM source_records
       WHERE thread_id = ?`,
    )
    .all(threadId);
  return deleteSourcesByIds(rows.map((row) => row.id));
}

export function deletePrivateSourcesForNode(nodeId: string): number {
  const removed = deleteSourcesByIds(listPrivateSourceIdsForNode(nodeId));
  deleteSourceLinksForNode(nodeId);
  return removed;
}

export function deleteSourcesForCourse(courseId: string): number {
  const rows = getDb()
    .prepare<[string], { id: string }>('SELECT id FROM source_records WHERE course_id = ?')
    .all(courseId);
  const count = deleteSourcesByIds(rows.map((row) => row.id));
  try {
    deleteCourseLibraryAssets(courseId);
  } catch (error) {
    recordCleanupFailure({
      path: getCourseLibraryDir(courseId),
      kind: 'course-library',
      ownerType: 'course',
      ownerId: courseId,
      reason: '课程参考库目录删除失败',
      error,
    });
  }
  return count;
}

function sourceAssetLooksOwned(entryName: string, sourceIds: string[]): boolean {
  return sourceIds.some((id) => entryName.startsWith(`${id}-`));
}

export function cleanupOrphanSourceAssets(courseId?: string): { removed: number } {
  const root = getLibraryRoot();
  if (!existsSync(root)) return { removed: 0 };
  const courseIds = courseId
    ? [courseId]
    : readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  let removed = 0;
  for (const cid of courseIds) {
    const dir = getCourseLibraryDir(cid);
    if (!existsSync(dir)) continue;
    const sourceIds = getDb()
      .prepare<[string], { id: string }>('SELECT id FROM source_records WHERE course_id = ?')
      .all(cid)
      .map((row) => row.id);
    for (const entry of readdirSync(dir)) {
      if (sourceAssetLooksOwned(entry, sourceIds)) continue;
      rmSync(join(dir, entry), { force: true, recursive: true });
      removed += 1;
    }
  }
  return { removed };
}

export function markSourcesUsed(sourceIds: string[]): void {
  const unique = [...new Set(sourceIds.filter(Boolean))];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE source_records SET hit_count = COALESCE(hit_count, 0) + 1, last_hit_at = datetime('now') WHERE id IN (${placeholders})`)
    .run(...unique);
}
