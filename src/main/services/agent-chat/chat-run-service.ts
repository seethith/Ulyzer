import type { IpcMainInvokeEvent } from 'electron';
import type { AgentChatRequest, IpcResponse, SearchMode } from '@shared/types';
import { normalizeLocale } from '@shared/i18n';
import { getDb } from '../db/sqlite';
import { getApiKey } from '../../utils/keychain';
import { AgentOrchestrator } from '../agent-core/orchestrator';
import { registerAbort, unregisterAbort } from '../abort-registry';
import { routeChatAttachments } from '../attachments/attachment-router';
import { localMsg } from '../agent-i18n/messages';
import { ChatRunRecorder } from './chat-run-recorder';

export interface ChatRunServiceDeps {
  orchestrator?: Pick<AgentOrchestrator, 'dispatch'>;
  selectedModelAvailable?: (provider: string, model: string) => Promise<boolean>;
  createAbortController?: () => AbortController;
  registerAbort?: (sessionId: string, controller: AbortController) => void;
  unregisterAbort?: (sessionId: string) => void;
  routeChatAttachments?: typeof routeChatAttachments;
}

const DEFAULT_SEARCH_MODE: SearchMode = 'auto';

export async function selectedModelAvailable(provider: string, model: string): Promise<boolean> {
  if (!provider || !model) return false;
  try {
    const row = getDb()
      .prepare<[string, string], { id: string; type: string; api_key_name: string | null; enabled: number }>(
        `SELECT provider_models.id, providers.type, providers.api_key_name, providers.enabled
         FROM provider_models
         JOIN providers ON providers.id = provider_models.provider_id
         WHERE provider_id = ?
           AND model_id = ?
           AND providers.enabled = 1
           AND COALESCE(provider_models.source, CASE WHEN provider_models.is_builtin = 1 THEN 'builtin' ELSE 'user' END) <> 'builtin'`,
      )
      .get(provider, model);
    if (!row) return false;
    if (row.type === 'ollama') return true;
    return Boolean(await getApiKey(row.api_key_name ?? provider));
  } catch {
    return false;
  }
}

/**
 * Entry point for an agent chat turn. There is intentionally no intent classifier:
 * the request is dispatched to the agent with its full, stable tool set, and the
 * model decides which tools to call (opencode / Claude Code style).
 */
export class ChatRunService {
  private readonly orchestrator: Pick<AgentOrchestrator, 'dispatch'>;
  private readonly isModelAvailable: (provider: string, model: string) => Promise<boolean>;
  private readonly newAbortController: () => AbortController;
  private readonly register: (sessionId: string, controller: AbortController) => void;
  private readonly unregister: (sessionId: string) => void;
  private readonly routeAttachments: typeof routeChatAttachments;

  constructor(deps: ChatRunServiceDeps = {}) {
    this.orchestrator = deps.orchestrator ?? new AgentOrchestrator();
    this.isModelAvailable = deps.selectedModelAvailable ?? selectedModelAvailable;
    this.newAbortController = deps.createAbortController ?? (() => new AbortController());
    this.register = deps.registerAbort ?? registerAbort;
    this.unregister = deps.unregisterAbort ?? unregisterAbort;
    this.routeAttachments = deps.routeChatAttachments ?? routeChatAttachments;
  }

  async handleAgentChat(event: IpcMainInvokeEvent, req: AgentChatRequest): Promise<IpcResponse<void>> {
    const recorder = new ChatRunRecorder({ sender: event.sender, req });
    let controller: AbortController | null = null;
    recorder.emitStarted();

    try {
      recorder.persistUserMessage(req.userMessage, req.attachments);
      if (!(await this.isModelAvailable(req.provider, req.model))) {
        const error = localMsg(req.language, '请先在设置中配置 API Key，获取模型后再选择模型', 'Configure an API key in Settings and fetch models before selecting one.');
        recorder.persistAssistant('failed', error);
        recorder.emitFailed(error);
        return { success: true };
      }

      controller = this.newAbortController();
      this.register(req.sessionId, controller);
      const routed = req.attachments?.length
        ? await this.routeAttachments({
            attachments: req.attachments,
            baseMessage: req.userMessage,
            provider: req.provider,
            model: req.model,
            nodeId: req.nodeId,
            courseId: req.courseId,
          })
        : { userMessage: req.userMessage, imageAttachments: [], pdfAttachments: [] };

      this.orchestrator
        .dispatch({
          type: req.agentType,
          action: 'chat',
          courseId: req.courseId,
          nodeId: req.nodeId,
          threadId: req.threadId,
          sessionId: req.sessionId,
          provider: req.provider,
          model: req.model,
          userMessage: routed.userMessage,
          messages: req.messages,
          activeFile: req.activeFile,
          imageAttachments: routed.imageAttachments.length > 0 ? routed.imageAttachments : undefined,
          pdfAttachments: routed.pdfAttachments.length > 0 ? routed.pdfAttachments : undefined,
          searchMode: req.searchMode ?? DEFAULT_SEARCH_MODE,
          thinkingMode: req.thinkingMode ?? 'off',
          language: normalizeLocale(req.language),
          senderEvent: event,
          signal: controller.signal,
          recorder,
        })
        .then(() => {
          if (controller?.signal.aborted) {
            recorder.persistAssistant('aborted');
            recorder.emitAborted();
          } else {
            recorder.emitCompleted();
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          recorder.persistAssistant('failed', message);
          this.sendAgentChatError(event, req, err);
          recorder.emitFailed(message);
        })
        .finally(() => {
          this.unregister(req.sessionId);
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recorder.persistAssistant('failed', message);
      this.sendAgentChatError(event, req, err);
      if (controller && !controller.signal.aborted) controller.abort();
      if (controller) this.unregister(req.sessionId);
      recorder.emitFailed(message);
    }

    return { success: true };
  }

  private sendAgentChatError(_event: IpcMainInvokeEvent, req: AgentChatRequest, err: unknown): void {
    // The renderer learns of failures via the recorder's run.failed event; here we only log.
    console.error('[agent:chat] failed', {
      agentType: req.agentType,
      provider: req.provider,
      model: req.model,
      searchMode: req.searchMode ?? DEFAULT_SEARCH_MODE,
      error: err,
    });
  }
}
