import { randomUUID } from 'crypto';
import type { AgentChatRequest, AgentType, ChatMessage, FileAttachment } from '@shared/types';
import { getDb } from '../db/sqlite';
import { countTokens } from '../llm/token-counter';

export interface PersistChatMessageInput {
  id: string;
  courseId: string;
  nodeId?: string;
  threadId?: string;
  role: ChatMessage['role'];
  content: string;
  progress?: string;
  thinking?: string;
  /** JSON-serialized DiagnosticRecord[] — the structured 查看思路 trace. */
  diagnostics?: string;
  /** JSON-serialized MessageArtifact[] — files generated this turn. */
  artifacts?: string;
  attachments?: FileAttachment[];
  agent: AgentType;
}

function sanitizeMessageAttachments(attachments?: FileAttachment[] | null): FileAttachment[] {
  if (!attachments || !Array.isArray(attachments)) return [];
  return attachments
    .filter((att) => att && typeof att.id === 'string' && typeof att.name === 'string')
    .map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType || 'application/octet-stream',
      size: Number.isFinite(att.size) ? att.size : 0,
      sourceId: att.sourceId,
      status: att.status,
      progressCurrent: att.progressCurrent,
      progressTotal: att.progressTotal,
      message: att.message,
      processingError: att.processingError ?? null,
    }));
}

function messageAttachmentsJson(attachments?: FileAttachment[] | null): string | null {
  const clean = sanitizeMessageAttachments(attachments);
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

export function shouldUseBackendPersistence(req: AgentChatRequest): boolean {
  return req.persistence?.mode === 'backend';
}

export function persistChatMessage(input: PersistChatMessageInput): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, course_id, node_id, role, content, progress, thinking, diagnostics, artifacts, attachments_json, agent, thread_id, token_count)
     VALUES (@id, @course_id, @node_id, @role, @content, @progress, @thinking, @diagnostics, @artifacts, @attachments_json, @agent, @thread_id, @token_count)`,
  ).run({
    id: input.id,
    course_id: input.courseId,
    node_id: input.nodeId ?? null,
    role: input.role,
    content: input.content,
    progress: input.progress ?? null,
    thinking: input.thinking ?? null,
    diagnostics: input.diagnostics ?? null,
    artifacts: input.artifacts ?? null,
    attachments_json: messageAttachmentsJson(input.attachments),
    agent: input.agent,
    thread_id: input.threadId ?? null,
    token_count: countTokens(input.content),
  });
  if (input.threadId) {
    db.prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`).run(input.threadId);
  }
}

export function resolveUserMessageId(req: AgentChatRequest): string {
  return req.persistence?.userMessageId || randomUUID();
}

export function resolveAssistantMessageId(req: AgentChatRequest): string {
  return req.persistence?.assistantMessageId || randomUUID();
}

