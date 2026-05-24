import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';

export type AgentToolEventStatus = 'completed' | 'failed';

export interface AgentToolEventCreateInput {
  sessionId?: string | null;
  courseId?: string | null;
  nodeId?: string | null;
  threadId?: string | null;
  agent?: string | null;
  toolName: string;
  toolCallId: string;
  inputJson: string;
  outputText?: string | null;
  status: AgentToolEventStatus;
  errorMessage?: string | null;
  durationMs: number;
}

export class AgentToolEventRepository {
  create(input: AgentToolEventCreateInput): void {
    getDb()
      .prepare(
        `INSERT INTO agent_tool_events (
           id, session_id, course_id, node_id, thread_id, agent,
           tool_name, tool_call_id, input_json, output_text,
           status, error_message, duration_ms
         )
         VALUES (
           @id, @session_id, @course_id, @node_id, @thread_id, @agent,
           @tool_name, @tool_call_id, @input_json, @output_text,
           @status, @error_message, @duration_ms
         )`,
      )
      .run({
        id: randomUUID(),
        session_id: input.sessionId ?? null,
        course_id: input.courseId ?? null,
        node_id: input.nodeId ?? null,
        thread_id: input.threadId ?? null,
        agent: input.agent ?? null,
        tool_name: input.toolName,
        tool_call_id: input.toolCallId,
        input_json: input.inputJson,
        output_text: input.outputText ?? null,
        status: input.status,
        error_message: input.errorMessage ?? null,
        duration_ms: Math.max(0, Math.round(input.durationMs)),
      });
  }
}
