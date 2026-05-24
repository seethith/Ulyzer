import type { WebContents } from 'electron';
import type { AgentChatRequest, AgentType, ChatRunEvent, DiagnosticRecord, FileAttachment, MessageArtifact } from '@shared/types';
import { emitChatRunEvent } from './chat-run-events';
import { localMsg } from '../agent-i18n/messages';
import {
  persistChatMessage,
  resolveAssistantMessageId,
  resolveUserMessageId,
  shouldUseBackendPersistence,
} from './chat-run-persistence';

export type AssistantTerminalStatus = 'completed' | 'failed' | 'aborted' | 'interrupted';

export interface ChatRunRecorderOptions {
  sender: WebContents;
  req: AgentChatRequest;
}

export class ChatRunRecorder {
  readonly runId: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly enabled: boolean;
  private assistantText = '';
  private progressText = '';
  private thinkingText = '';
  private readonly diagnostics: DiagnosticRecord[] = [];
  private readonly artifacts: MessageArtifact[] = [];
  private userPersisted = false;
  private assistantPersisted = false;

  constructor(private readonly options: ChatRunRecorderOptions) {
    this.runId = options.req.sessionId;
    this.sessionId = options.req.sessionId;
    this.userMessageId = resolveUserMessageId(options.req);
    this.assistantMessageId = resolveAssistantMessageId(options.req);
    this.enabled = shouldUseBackendPersistence(options.req);
  }

  get agentType(): AgentType {
    return this.options.req.agentType;
  }

  emitStarted(): void {
    this.emit({
      ...this.baseEvent(),
      type: 'run.started',
    });
  }


  emitCompleted(): void {
    this.emit({
      ...this.baseEvent(),
      type: 'run.completed',
      status: 'completed',
    });
  }

  emitAborted(): void {
    this.emit({
      ...this.baseEvent(),
      type: 'run.aborted',
      status: 'aborted',
    });
  }

  emitInterrupted(): void {
    this.emit({
      ...this.baseEvent(),
      type: 'run.interrupted',
      status: 'interrupted',
    });
  }

  emitFailed(error: string): void {
    this.emit({
      ...this.baseEvent(),
      type: 'run.failed',
      status: 'failed',
      error,
    });
  }

  persistUserMessage(content: string, attachments?: FileAttachment[]): void {
    const req = this.options.req;
    if (!this.enabled || req.persistence?.persistUserMessage === false || this.userPersisted) return;
    persistChatMessage({
      id: this.userMessageId,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
      role: 'user',
      content,
      attachments,
      agent: req.agentType,
    });
    this.userPersisted = true;
    this.emit({
      type: 'message.user.persisted',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: req.agentType,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
      messageId: this.userMessageId,
      role: 'user',
    });
  }

  appendAssistantDelta(chunk: string): void {
    this.assistantText += chunk;
    this.emit({
      type: 'message.delta',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: this.options.req.agentType,
      chunk,
      role: 'assistant',
    });
  }

  appendProgressDelta(chunk: string): void {
    this.progressText += chunk;
    this.emit({
      type: 'progress.delta',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: this.options.req.agentType,
      chunk,
    });
  }

  /** Accumulate + stream one structured developer-diagnostic record. */
  appendDiagnostic(record: DiagnosticRecord): void {
    this.diagnostics.push(record);
    this.emit({
      type: 'diagnostic',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: this.options.req.agentType,
      diagnostic: record,
    });
  }

  /** Accumulate a generated-file artifact, committed onto the assistant message. */
  recordArtifact(artifact: MessageArtifact): void {
    if (this.artifacts.some((a) => a.filePath === artifact.filePath)) return;
    this.artifacts.push(artifact);
  }

  /** Stream a clean, user-facing current-phase hint (not persisted). */
  setPhase(phase: string): void {
    this.emit({
      type: 'phase',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: this.options.req.agentType,
      phase,
    });
  }

  appendThinkingDelta(chunk: string): void {
    // Thinking is kept separate from the tool-trace progress so the UI can render
    // a dedicated, collapsible "thinking" block (the raw progress stays as 查看思路).
    this.thinkingText += chunk;
    this.emit({
      type: 'thinking.delta',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: this.options.req.agentType,
      chunk,
    });
  }

  persistAssistant(status: AssistantTerminalStatus, error?: string): void {
    const req = this.options.req;
    if (!this.enabled || req.persistence?.persistAssistantMessage === false || this.assistantPersisted) return;
    const content = this.finalAssistantContent(status, error);
    if (!content.trim()) return;
    if (status === 'failed' && !this.assistantText.trim()) return;
    persistChatMessage({
      id: this.assistantMessageId,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
      role: 'assistant',
      content,
      progress: this.progressText || undefined,
      thinking: this.thinkingText || undefined,
      diagnostics: this.diagnostics.length > 0 ? JSON.stringify(this.diagnostics) : undefined,
      artifacts: this.artifacts.length > 0 ? JSON.stringify(this.artifacts) : undefined,
      agent: req.agentType,
    });
    this.assistantPersisted = true;
    this.emit({
      type: 'message.assistant.persisted',
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: req.agentType,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
      messageId: this.assistantMessageId,
      role: 'assistant',
      status,
      error,
    });
  }

  emit(event: ChatRunEvent): void {
    emitChatRunEvent(this.options.sender, event);
  }

  private baseEvent(): Pick<ChatRunEvent, 'runId' | 'sessionId' | 'agentType' | 'courseId' | 'nodeId' | 'threadId'> {
    const req = this.options.req;
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      agentType: req.agentType,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
    };
  }

  private finalAssistantContent(status: AssistantTerminalStatus, error?: string): string {
    if (status === 'completed') return this.assistantText;
    if (status === 'interrupted') return this.assistantText;
    const lang = this.options.req.language;
    if (status === 'aborted') {
      const marker = `*⏹ ${localMsg(lang, '已停止生成', 'Generation stopped')}*`;
      return this.assistantText.trim() ? `${this.assistantText}\n\n---\n${marker}` : marker;
    }
    const failed = localMsg(lang, '生成失败', 'Generation failed');
    const suffix = error ? `\n\n---\n*${failed}：${error}*` : `\n\n---\n*${failed}*`;
    return this.assistantText.trim() ? `${this.assistantText}${suffix}` : suffix.trim();
  }
}
