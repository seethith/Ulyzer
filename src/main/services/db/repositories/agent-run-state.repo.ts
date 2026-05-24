import { getDb } from '../sqlite';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface AgentRunStateRecord {
  session_id: string;
  thread_id: string | null;
  course_id: string | null;
  node_id: string | null;
  agent: string | null;
  status: AgentRunStatus;
  turn: number;
  messages_json: string;
  task_list_json: string;
  created_at: string;
  updated_at: string;
}

export interface SaveRunStateInput {
  sessionId: string;
  threadId?: string | null;
  courseId?: string | null;
  nodeId?: string | null;
  agent?: string | null;
  status: AgentRunStatus;
  turn: number;
  messagesJson: string;
  taskListJson: string;
}

/**
 * Persists the live state of an in-flight agent loop (messages + task list) so an
 * aborted or crashed run can be resumed mid-task rather than restarted from scratch.
 */
export class AgentRunStateRepository {
  save(input: SaveRunStateInput): void {
    getDb()
      .prepare(
        `INSERT INTO agent_run_states
           (session_id, thread_id, course_id, node_id, agent, status, turn, messages_json, task_list_json, updated_at)
         VALUES
           (@session_id, @thread_id, @course_id, @node_id, @agent, @status, @turn, @messages_json, @task_list_json, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           thread_id      = excluded.thread_id,
           course_id      = excluded.course_id,
           node_id        = excluded.node_id,
           agent          = excluded.agent,
           status         = excluded.status,
           turn           = excluded.turn,
           messages_json  = excluded.messages_json,
           task_list_json = excluded.task_list_json,
           updated_at     = datetime('now')`,
      )
      .run({
        session_id:     input.sessionId,
        thread_id:      input.threadId ?? null,
        course_id:      input.courseId ?? null,
        node_id:        input.nodeId ?? null,
        agent:          input.agent ?? null,
        status:         input.status,
        turn:           input.turn,
        messages_json:  input.messagesJson,
        task_list_json: input.taskListJson,
      });
  }

  findBySession(sessionId: string): AgentRunStateRecord | null {
    return getDb()
      .prepare<[string], AgentRunStateRecord>(
        `SELECT * FROM agent_run_states WHERE session_id = ?`,
      )
      .get(sessionId) ?? null;
  }

  /** Most recent non-completed run on a thread — the resume candidate. */
  findResumable(threadId: string): AgentRunStateRecord | null {
    return getDb()
      .prepare<[string], AgentRunStateRecord>(
        `SELECT * FROM agent_run_states
          WHERE thread_id = ?
            AND status IN ('running', 'failed', 'aborted')
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(threadId) ?? null;
  }

  markTerminal(sessionId: string, status: Extract<AgentRunStatus, 'completed' | 'failed' | 'aborted'>): void {
    getDb()
      .prepare(
        `UPDATE agent_run_states SET status = ?, updated_at = datetime('now') WHERE session_id = ?`,
      )
      .run(status, sessionId);
  }

  delete(sessionId: string): void {
    getDb().prepare(`DELETE FROM agent_run_states WHERE session_id = ?`).run(sessionId);
  }

  /** Clear all resumable state for a thread — used when a run completes cleanly or fresh-starts. */
  deleteByThread(threadId: string): void {
    getDb().prepare(`DELETE FROM agent_run_states WHERE thread_id = ?`).run(threadId);
  }

  /**
   * A run still marked 'running' at process start was left mid-flight by the previous
   * session (nothing can be live the instant we launch) → mark it 'aborted'. It stays
   * resumable via findResumable but no longer falsely reports as active. Returns the count.
   * updated_at is intentionally left untouched so a long-abandoned run is still pruned by age.
   */
  reconcileInterrupted(): number {
    return getDb()
      .prepare(`UPDATE agent_run_states SET status = 'aborted' WHERE status = 'running'`)
      .run().changes;
  }

  /** Drop completed runs older than N days to keep the table small. Returns the count. */
  pruneCompleted(days: number): number {
    return getDb()
      .prepare(`DELETE FROM agent_run_states WHERE status = 'completed' AND updated_at < datetime('now', ?)`)
      .run(`-${days} days`).changes;
  }

  /** Drop any run not touched in N days — bounds the table even if runs crash. Returns the count. */
  pruneOlderThan(days: number): number {
    return getDb()
      .prepare(`DELETE FROM agent_run_states WHERE updated_at < datetime('now', ?)`)
      .run(`-${days} days`).changes;
  }
}
