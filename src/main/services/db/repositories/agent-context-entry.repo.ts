import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import { countTokens } from '../../llm/token-counter';

export type AgentContextEntryKind =
  | 'course_dag_artifact'
  | 'generated_material_artifact'
  | 'tool_trace'
  | 'retrieval_digest'
  | 'manual_note';

export interface AgentContextEntryRecord {
  id: string;
  course_id: string;
  node_id: string | null;
  thread_id: string | null;
  agent: string;
  kind: AgentContextEntryKind;
  title: string;
  content: string;
  token_count: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentContextEntryInput {
  courseId: string;
  nodeId?: string | null;
  threadId?: string | null;
  agent: string;
  kind: AgentContextEntryKind;
  title: string;
  content: string;
  active?: boolean;
}

export interface ListAgentContextEntriesInput {
  courseId: string;
  nodeId?: string | null;
  threadId?: string | null;
  agent: string;
  limit?: number;
}

export class AgentContextEntryRepository {
  create(input: CreateAgentContextEntryInput): AgentContextEntryRecord | null {
    try {
      const id = randomUUID();
      getDb()
        .prepare(
          `INSERT INTO agent_context_entries (
             id, course_id, node_id, thread_id, agent, kind,
             title, content, token_count, active
           ) VALUES (
             @id, @course_id, @node_id, @thread_id, @agent, @kind,
             @title, @content, @token_count, @active
           )`,
        )
        .run({
          id,
          course_id: input.courseId,
          node_id: input.nodeId ?? null,
          thread_id: input.threadId ?? null,
          agent: input.agent,
          kind: input.kind,
          title: input.title,
          content: input.content,
          token_count: countTokens(input.content),
          active: input.active === false ? 0 : 1,
        });
      return this.findById(id);
    } catch {
      return null;
    }
  }

  deactivateKind(input: {
    courseId: string;
    agent: string;
    kind: AgentContextEntryKind;
    nodeId?: string | null;
  }): void {
    try {
      getDb()
        .prepare(
          `UPDATE agent_context_entries
              SET active = 0,
                  updated_at = datetime('now')
            WHERE course_id = @course_id
              AND agent = @agent
              AND kind = @kind
              AND ((@node_id IS NULL AND node_id IS NULL) OR node_id = @node_id)`,
        )
        .run({
          course_id: input.courseId,
          agent: input.agent,
          kind: input.kind,
          node_id: input.nodeId ?? null,
        });
    } catch {
      // Context entries are advisory; never break the agent on ledger failure.
    }
  }

  listActive(input: ListAgentContextEntriesInput): AgentContextEntryRecord[] {
    try {
      return getDb()
        .prepare<
          {
            course_id: string;
            node_id: string | null;
            thread_id: string | null;
            agent: string;
            limit: number;
          },
          AgentContextEntryRecord
        >(
          `SELECT *
             FROM agent_context_entries
            WHERE course_id = @course_id
              AND agent = @agent
              AND active = 1
              AND (thread_id IS NULL OR thread_id = @thread_id)
              AND ((@node_id IS NULL AND node_id IS NULL) OR node_id = @node_id)
            ORDER BY created_at DESC
            LIMIT @limit`,
        )
        .all({
          course_id: input.courseId,
          node_id: input.nodeId ?? null,
          thread_id: input.threadId ?? null,
          agent: input.agent,
          limit: input.limit ?? 6,
        })
        .reverse();
    } catch {
      return [];
    }
  }

  findById(id: string): AgentContextEntryRecord | null {
    try {
      const row = getDb()
        .prepare<[string], AgentContextEntryRecord>(
          `SELECT *
             FROM agent_context_entries
            WHERE id = ?`,
        )
        .get(id);
      return row ?? null;
    } catch {
      return null;
    }
  }
}
