import type { LearningSourceEvaluation, LearningSourcePlan, LearningSourceSlot, SourceLearningMetadata, SourceRecord } from '@shared/types';
import { getDb } from '../db/sqlite';

interface MetadataRow {
  source_id: string;
  course_id: string;
  slot_id: string;
  slot_name: string | null;
  source_type: SourceLearningMetadata['sourceType'];
  quality_score: number | null;
  why_useful: string | null;
  limitations: string | null;
  main_evidence: number | null;
  ingest_policy: string | null;
  plan_id: string | null;
  query: string | null;
  updated_at: string | null;
}

function rowToMetadata(row: MetadataRow): SourceLearningMetadata {
  return {
    sourceId: row.source_id,
    courseId: row.course_id,
    slotId: row.slot_id,
    slotName: row.slot_name,
    sourceType: row.source_type,
    qualityScore: row.quality_score ?? 0,
    whyUseful: row.why_useful,
    limitations: row.limitations,
    mainEvidence: Boolean(row.main_evidence),
    ingestPolicy: row.ingest_policy,
    planId: row.plan_id,
    query: row.query,
    updatedAt: row.updated_at,
  };
}

export function learningMetadataForSource(sourceId: string): SourceLearningMetadata[] {
  try {
    const rows = getDb()
      .prepare<[string], MetadataRow>(
        `SELECT *
         FROM source_learning_metadata
         WHERE source_id = ?
         ORDER BY main_evidence DESC, quality_score DESC, updated_at DESC`,
      )
      .all(sourceId);
    return rows.map(rowToMetadata);
  } catch {
    return [];
  }
}

export function persistSourceLearningMetadata(input: {
  source: SourceRecord;
  slot?: LearningSourceSlot;
  evaluation: LearningSourceEvaluation;
  plan: LearningSourcePlan;
  query: string;
  ingestPolicy: string;
}): void {
  try {
    getDb().prepare(
      `INSERT INTO source_learning_metadata (
         source_id, course_id, slot_id, slot_name, source_type, quality_score,
         why_useful, limitations, main_evidence, ingest_policy, plan_id, query,
         updated_at
       ) VALUES (
         @source_id, @course_id, @slot_id, @slot_name, @source_type, @quality_score,
         @why_useful, @limitations, @main_evidence, @ingest_policy, @plan_id, @query,
         datetime('now')
       )
       ON CONFLICT(source_id, slot_id) DO UPDATE SET
         course_id = excluded.course_id,
         slot_name = excluded.slot_name,
         source_type = excluded.source_type,
         quality_score = excluded.quality_score,
         why_useful = excluded.why_useful,
         limitations = excluded.limitations,
         main_evidence = excluded.main_evidence,
         ingest_policy = excluded.ingest_policy,
         plan_id = excluded.plan_id,
         query = excluded.query,
         updated_at = datetime('now')`,
    ).run({
      source_id: input.source.id,
      course_id: input.source.courseId,
      slot_id: input.evaluation.slotId,
      slot_name: input.slot?.name ?? null,
      source_type: input.evaluation.sourceType,
      quality_score: input.evaluation.qualityScore,
      why_useful: input.evaluation.whyUseful,
      limitations: input.evaluation.limitations,
      main_evidence: input.evaluation.mainEvidence ? 1 : 0,
      ingest_policy: input.ingestPolicy,
      plan_id: input.plan.id,
      query: input.query,
    });

    if (input.source.origin === 'web_collected' && input.source.kind === 'web') {
      getDb()
        .prepare('UPDATE source_records SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(input.evaluation.enabledByDefault ? 1 : 0, input.source.id);
    }
  } catch {
    // Learning metadata is useful for routing but must not break source ingestion.
  }
}

export function formatSourceLearningMetadataForAgent(sourceId: string): string | null {
  const items = learningMetadataForSource(sourceId).slice(0, 3);
  if (items.length === 0) return null;
  const lines = ['学习资料用途（联网搜集时的内部判断）：'];
  for (const item of items) {
    lines.push([
      `- 槽位：${item.slotName || item.slotId}`,
      `类型：${item.sourceType}`,
      `质量：${item.qualityScore.toFixed(2)}`,
      item.mainEvidence ? '主依据' : '补充',
      item.whyUseful ? `用途：${item.whyUseful}` : null,
      item.limitations ? `限制：${item.limitations}` : null,
    ].filter(Boolean).join('；'));
  }
  return lines.join('\n');
}
