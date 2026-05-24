import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { AgentChatRequest, AgentClarifyRequest, AgentContextStatus, AgentContextStatusRequest, ClarifyResult, IpcResponse, OutlineStatusRequest, KcCoverageStatus } from '@shared/types';
import { analyzeIntent } from '../services/agent-workflows/intent-clarifier';
import { abortSession } from '../services/abort-registry';
import { checkKcCoverage } from '../services/agent-workflows/outline-version';
import { getDb } from '../services/db/sqlite';
import { ContextWindowManager } from '../services/agent-context/context-window-manager';
import { buildAgentContextProjectionPreview } from '../services/agent-context/agent-context-preview';
import { ChatRunService } from '../services/agent-chat/chat-run-service';

const chatRunService = new ChatRunService();
const contextWindowManager = new ContextWindowManager();

function validContextThreadId(req: AgentContextStatusRequest): string | undefined {
  const threadId = req.threadId ?? undefined;
  if (!threadId) return undefined;
  try {
    const row = getDb()
      .prepare<[string], { course_id: string; node_id: string | null; agent: string; deleted: number }>(
        `SELECT course_id, node_id, agent, deleted
           FROM chat_threads
          WHERE id = ?`,
      )
      .get(threadId);
    if (!row || row.deleted === 1) return undefined;
    const nodeMatches = req.nodeId ? row.node_id === req.nodeId : row.node_id === null;
    return row.course_id === req.courseId && row.agent === req.agentType && nodeMatches
      ? threadId
      : undefined;
  } catch {
    return undefined;
  }
}

export function registerAgentHandlers(): void {
  // ── General agent chat ────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.AGENT_CONTEXT_STATUS,
    async (_event, req: AgentContextStatusRequest): Promise<IpcResponse<AgentContextStatus>> => {
      try {
        const threadId = validContextThreadId(req);
        const preview = await buildAgentContextProjectionPreview(req);
        const snapshot = contextWindowManager.getSnapshot({
          modelProvider: req.provider,
          model: req.model,
          courseId: req.courseId,
          nodeId: req.nodeId,
          threadId,
          agent: req.agentType,
          thinkingMode: req.thinkingMode ?? 'off',
          taskKind: preview.taskKind,
          systemPrompt: preview.systemPrompt,
          initialMessages: preview.initialMessages,
          tools: preview.tools,
          fallbackMessages: [],
          visibleMessages: threadId ? req.messages ?? [] : [],
          currentUserMessage: req.currentUserMessage ?? '',
        });
        // Gauge = input fullness (how much of the usable input space the prompt
        // occupies), NOT total window reservation. Reserved output/thinking/safety
        // are excluded from the numerator and instead shrink the denominator
        // (inputBudget), matching the compaction thresholds (compressAt/collapseAt).
        const inputTokens = snapshot.estimatedInputTokens;
        const inputBudget = snapshot.inputBudget;
        const usageRatio = inputBudget > 0 ? inputTokens / inputBudget : 0;
        const percent = Math.max(0, Math.min(100, Number((usageRatio * 100).toFixed(1))));
        return {
          success: true,
          data: {
            percent,
            inputTokens,
            inputBudget,
            contextWindow: snapshot.contextWindow,
          },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.AGENT_CHAT,
    async (event, req: AgentChatRequest): Promise<IpcResponse<void>> => {
      return chatRunService.handleAgentChat(event, req);
    }
  );


  // ── Intent clarification (fast invoke, never blocks the user) ────────────────

  ipcMain.handle(
    IPC.AGENT_CLARIFY,
    async (_event, req: AgentClarifyRequest): Promise<IpcResponse<ClarifyResult>> => {
      try {
        const result = await analyzeIntent(
          req.userMessage,
          req.messages ?? [],
          req.provider,
          req.model,
          {
            sessionId: req.sessionId,
            courseId: req.courseId,
            threadId: req.threadId,
          },
        );
        return { success: true, data: result };
      } catch {
        // Always succeed — clarification failures must never block the user
        return { success: true, data: { needsClarification: false, questions: [] } };
      }
    }
  );

  // ── Outline: get KC coverage status ──────────────────────────────────────────

  ipcMain.handle(
    IPC.OUTLINE_GET_STATUS,
    async (_event, req: OutlineStatusRequest): Promise<IpcResponse<KcCoverageStatus>> => {
      try {
        const status = checkKcCoverage(req.courseId, req.nodeId);
        return { success: true, data: status };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── Abort any stream (agent or direct LLM) ────────────────────────────────────

  ipcMain.handle(
    IPC.LLM_ABORT,
    (_event, sessionId: string): IpcResponse<void> => {
      abortSession(sessionId);
      return { success: true };
    }
  );
}
