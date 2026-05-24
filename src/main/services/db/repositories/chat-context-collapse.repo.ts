import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';

export type ChatContextCollapseKind = 'micro' | 'auto' | 'manual' | 'emergency';

export interface ChatContextCollapseRecord {
  id: string;
  thread_id: string;
  course_id: string;
  node_id: string | null;
  agent: string;
  kind: ChatContextCollapseKind;
  from_message_id: string | null;
  to_message_id: string | null;
  replacement_text: string;
  source_entry_ids_json: string;
  instruction: string | null;
  token_before: number;
  token_after: number;
  validation_json: string;
  created_at: string;
}

export interface CreateCollapseInput {
  threadId: string;
  courseId: string;
  nodeId?: string | null;
  agent: string;
  kind: ChatContextCollapseKind;
  fromMessageId?: string | null;
  toMessageId?: string | null;
  replacementText: string;
  sourceEntryIds?: string[];
  instruction?: string | null;
  tokenBefore?: number;
  tokenAfter?: number;
  validationJson?: string;
}

export interface ContextSnapshotInput {
  id?: string;
  threadId?: string | null;
  courseId?: string | null;
  nodeId?: string | null;
  agent?: string | null;
  provider: string;
  model: string;
  taskKind: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputBudget: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  rawTranscriptTokens: number;
  projectedTokens: number;
  tokenBeforeProjection: number;
  tokenAfterProjection: number;
  collapseSavings: number;
  riskLevel: string;
  liveMessageCount: number;
  checkpointCount: number;
  summaryTokens: number;
  microCompactedCount: number;
}

export class ChatContextCollapseRepository {
  listByThread(threadId: string): ChatContextCollapseRecord[] {
    return getDb()
      .prepare<[string], ChatContextCollapseRecord>(
        `SELECT *
           FROM chat_context_collapses
          WHERE thread_id = ?
          ORDER BY created_at ASC`,
      )
      .all(threadId);
  }

  latestCheckpoint(threadId: string): ChatContextCollapseRecord | null {
    const row = getDb()
      .prepare<[string], ChatContextCollapseRecord>(
        `SELECT *
           FROM chat_context_collapses
          WHERE thread_id = ?
            AND kind IN ('auto', 'manual', 'emergency')
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(threadId);
    return row ?? null;
  }

  create(input: CreateCollapseInput): ChatContextCollapseRecord {
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO chat_context_collapses (
           id, thread_id, course_id, node_id, agent, kind,
           from_message_id, to_message_id, replacement_text,
           source_entry_ids_json, instruction, token_before, token_after, validation_json
         ) VALUES (
           @id, @thread_id, @course_id, @node_id, @agent, @kind,
           @from_message_id, @to_message_id, @replacement_text,
           @source_entry_ids_json, @instruction, @token_before, @token_after, @validation_json
         )`,
      )
      .run({
        id,
        thread_id: input.threadId,
        course_id: input.courseId,
        node_id: input.nodeId ?? null,
        agent: input.agent,
        kind: input.kind,
        from_message_id: input.fromMessageId ?? null,
        to_message_id: input.toMessageId ?? null,
        replacement_text: input.replacementText,
        source_entry_ids_json: JSON.stringify(input.sourceEntryIds ?? []),
        instruction: input.instruction ?? null,
        token_before: input.tokenBefore ?? 0,
        token_after: input.tokenAfter ?? 0,
        validation_json: input.validationJson ?? '{}',
      });
    return this.findById(id)!;
  }

  findById(id: string): ChatContextCollapseRecord | null {
    const row = getDb()
      .prepare<[string], ChatContextCollapseRecord>(
        `SELECT *
           FROM chat_context_collapses
          WHERE id = ?`,
      )
      .get(id);
    return row ?? null;
  }

  recordSnapshot(input: ContextSnapshotInput): string | null {
    try {
      const id = input.id ?? randomUUID();
      getDb()
        .prepare(
          `INSERT INTO chat_context_snapshots (
             id, thread_id, course_id, node_id, agent, provider, model, task_kind,
             context_window, max_output_tokens, input_budget,
             estimated_input_tokens, estimated_total_tokens,
             raw_transcript_tokens, projected_tokens,
             token_before_projection, token_after_projection, collapse_savings,
             risk_level, live_message_count, checkpoint_count,
             summary_tokens, micro_compacted_count
           ) VALUES (
             @id, @thread_id, @course_id, @node_id, @agent, @provider, @model, @task_kind,
             @context_window, @max_output_tokens, @input_budget,
             @estimated_input_tokens, @estimated_total_tokens,
             @raw_transcript_tokens, @projected_tokens,
             @token_before_projection, @token_after_projection, @collapse_savings,
             @risk_level, @live_message_count, @checkpoint_count,
             @summary_tokens, @micro_compacted_count
           )`,
        )
        .run({
          id,
          thread_id: input.threadId ?? null,
          course_id: input.courseId ?? null,
          node_id: input.nodeId ?? null,
          agent: input.agent ?? null,
          provider: input.provider,
          model: input.model,
          task_kind: input.taskKind,
          context_window: input.contextWindow,
          max_output_tokens: input.maxOutputTokens,
          input_budget: input.inputBudget,
          estimated_input_tokens: input.estimatedInputTokens,
          estimated_total_tokens: input.estimatedTotalTokens,
          raw_transcript_tokens: input.rawTranscriptTokens,
          projected_tokens: input.projectedTokens,
          token_before_projection: input.tokenBeforeProjection,
          token_after_projection: input.tokenAfterProjection,
          collapse_savings: input.collapseSavings,
          risk_level: input.riskLevel,
          live_message_count: input.liveMessageCount,
          checkpoint_count: input.checkpointCount,
          summary_tokens: input.summaryTokens,
          micro_compacted_count: input.microCompactedCount,
        });
      return id;
    } catch {
      return null;
    }
  }
}
