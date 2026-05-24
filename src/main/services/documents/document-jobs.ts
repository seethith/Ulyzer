import { randomUUID } from 'crypto';
import type { DocumentJobState, DocumentJobType, DocumentProcessingJob } from './document-types';
import { getDb } from '../db/sqlite';

interface JobRow {
  id: string;
  source_id: string | null;
  course_id: string;
  node_id: string | null;
  job_type: DocumentJobType;
  state: DocumentJobState;
  progress_current: number;
  progress_total: number;
  error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function parseMetadata(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toJob(row: JobRow): DocumentProcessingJob {
  return {
    id: row.id,
    sourceId: row.source_id,
    courseId: row.course_id,
    nodeId: row.node_id,
    jobType: row.job_type,
    state: row.state,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    error: row.error,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createDocumentJob(input: {
  sourceId?: string | null;
  courseId: string;
  nodeId?: string | null;
  jobType: DocumentJobType;
  progressTotal?: number;
  metadata?: Record<string, unknown>;
}): DocumentProcessingJob {
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO source_processing_jobs (
       id, source_id, course_id, node_id, job_type, state, progress_total, metadata_json
     ) VALUES (
       @id, @source_id, @course_id, @node_id, @job_type, 'pending', @progress_total, @metadata_json
     )`,
  ).run({
    id,
    source_id: input.sourceId ?? null,
    course_id: input.courseId,
    node_id: input.nodeId ?? null,
    job_type: input.jobType,
    progress_total: input.progressTotal ?? 0,
    metadata_json: JSON.stringify(input.metadata ?? {}),
  });
  return getDocumentJob(id)!;
}

export function getDocumentJob(id: string): DocumentProcessingJob | null {
  const row = getDb()
    .prepare<[string], JobRow>('SELECT * FROM source_processing_jobs WHERE id = ?')
    .get(id);
  return row ? toJob(row) : null;
}

export function updateDocumentJob(id: string, patch: {
  state?: DocumentJobState;
  progressCurrent?: number;
  progressTotal?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): DocumentProcessingJob | null {
  const current = getDocumentJob(id);
  if (!current) return null;
  const nextState = patch.state ?? current.state;
  const startedAtSql = current.startedAt || nextState !== 'running'
    ? 'started_at'
    : "datetime('now')";
  const finishedAtSql = ['ready', 'failed', 'cancelled'].includes(nextState) && !current.finishedAt
    ? "datetime('now')"
    : 'finished_at';

  getDb().prepare(
    `UPDATE source_processing_jobs SET
       state = @state,
       progress_current = @progress_current,
       progress_total = @progress_total,
       error = @error,
       metadata_json = @metadata_json,
       started_at = ${startedAtSql},
       finished_at = ${finishedAtSql},
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    state: nextState,
    progress_current: patch.progressCurrent ?? current.progressCurrent,
    progress_total: patch.progressTotal ?? current.progressTotal,
    error: patch.error === undefined ? current.error : patch.error,
    metadata_json: JSON.stringify(patch.metadata ?? current.metadata),
  });
  return getDocumentJob(id);
}

export function listDocumentJobs(input: {
  sourceId?: string;
  courseId?: string;
  state?: DocumentJobState;
  limit?: number;
} = {}): DocumentProcessingJob[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.sourceId) {
    clauses.push('source_id = ?');
    params.push(input.sourceId);
  }
  if (input.courseId) {
    clauses.push('course_id = ?');
    params.push(input.courseId);
  }
  if (input.state) {
    clauses.push('state = ?');
    params.push(input.state);
  }
  const limit = Math.min(input.limit ?? 50, 200);
  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT * FROM source_processing_jobs
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params) as JobRow[];
  return rows.map(toJob);
}

