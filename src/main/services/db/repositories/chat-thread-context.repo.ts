import { getDb } from '../sqlite';

export interface ThreadMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  progress: string | null;
  created_at: string;
  token_count: number;
}

export interface ChatThreadContextRecord {
  thread_id: string;
  course_id: string;
  node_id: string | null;
  agent: string;
  summary: string;
  covered_message_id: string | null;
  covered_message_created_at: string | null;
  important_facts_json: string;
  user_preferences_json: string;
  open_loops_json: string;
  artifact_history_json: string;
  summary_token_count: number;
  raw_message_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertThreadContextInput {
  threadId: string;
  courseId: string;
  nodeId?: string | null;
  agent: string;
  summary: string;
  coveredMessageId?: string | null;
  coveredMessageCreatedAt?: string | null;
  importantFactsJson?: string;
  userPreferencesJson?: string;
  openLoopsJson?: string;
  artifactHistoryJson?: string;
  summaryTokenCount?: number;
  rawMessageCount?: number;
}

export class ChatThreadContextRepository {
  findByThreadId(threadId: string): ChatThreadContextRecord | null {
    const row = getDb()
      .prepare<[string], ChatThreadContextRecord>(
        `SELECT *
           FROM chat_thread_contexts
          WHERE thread_id = ?`,
      )
      .get(threadId);
    return row ?? null;
  }

  listMessages(threadId: string): ThreadMessageRow[] {
    return getDb()
      .prepare<[string], ThreadMessageRow>(
        `SELECT id, role, content, progress, created_at, token_count
           FROM messages
          WHERE thread_id = ?
            AND role IN ('user', 'assistant')
          ORDER BY created_at ASC`,
      )
      .all(threadId);
  }

  upsert(input: UpsertThreadContextInput): void {
    getDb()
      .prepare(
        `INSERT INTO chat_thread_contexts (
           thread_id, course_id, node_id, agent, summary,
           covered_message_id, covered_message_created_at,
           important_facts_json, user_preferences_json, open_loops_json, artifact_history_json,
           summary_token_count, raw_message_count, version, updated_at
         ) VALUES (
           @thread_id, @course_id, @node_id, @agent, @summary,
           @covered_message_id, @covered_message_created_at,
           @important_facts_json, @user_preferences_json, @open_loops_json, @artifact_history_json,
           @summary_token_count, @raw_message_count, 1, datetime('now')
         )
         ON CONFLICT(thread_id) DO UPDATE SET
           course_id = excluded.course_id,
           node_id = excluded.node_id,
           agent = excluded.agent,
           summary = excluded.summary,
           covered_message_id = excluded.covered_message_id,
           covered_message_created_at = excluded.covered_message_created_at,
           important_facts_json = excluded.important_facts_json,
           user_preferences_json = excluded.user_preferences_json,
           open_loops_json = excluded.open_loops_json,
           artifact_history_json = excluded.artifact_history_json,
           summary_token_count = excluded.summary_token_count,
           raw_message_count = excluded.raw_message_count,
           version = chat_thread_contexts.version + 1,
           updated_at = datetime('now')`,
      )
      .run({
        thread_id: input.threadId,
        course_id: input.courseId,
        node_id: input.nodeId ?? null,
        agent: input.agent,
        summary: input.summary,
        covered_message_id: input.coveredMessageId ?? null,
        covered_message_created_at: input.coveredMessageCreatedAt ?? null,
        important_facts_json: input.importantFactsJson ?? '[]',
        user_preferences_json: input.userPreferencesJson ?? '[]',
        open_loops_json: input.openLoopsJson ?? '[]',
        artifact_history_json: input.artifactHistoryJson ?? '[]',
        summary_token_count: input.summaryTokenCount ?? 0,
        raw_message_count: input.rawMessageCount ?? 0,
      });
  }
}
