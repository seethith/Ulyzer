import type { WebContents } from 'electron';
import type { DiagnosticRecord, FileGeneratedPayload, TokenUsage } from '@shared/types';
import type { ChatRunRecorder } from '../agent-chat/chat-run-recorder';
import { usageLedger } from '../llm/usage-ledger';
import { abortError } from './agent-errors';
import { TaskList } from './task-list';
import { RunDiagnostics } from './run-diagnostics';
import {
  dagGeneratedPayload,
  fileGeneratedPayload,
  streamChunkPayload,
  streamEndPayload,
  streamErrorPayload,
  toolCallPayload,
  toolResultPayload,
  type DagGeneratedPayload,
} from './agent-events';

/**
 * No-recorder fallback: only generic notes mirror to the legacy progress stream
 * (preserving the original `progress()` contract). Structured records are still
 * collected in RunDiagnostics but are streamed only when a recorder is present.
 */
function fallbackDiagnosticText(record: DiagnosticRecord): string {
  return record.kind === 'note' ? (record.text ?? '') : '';
}

const TOOL_EVENT_PREVIEW_CHARS = 600;

function previewText(value: string): string {
  return value.length <= TOOL_EVENT_PREVIEW_CHARS
    ? value
    : `${value.slice(0, TOOL_EVENT_PREVIEW_CHARS)}…[+${value.length - TOOL_EVENT_PREVIEW_CHARS}]`;
}

function previewInput(input: unknown): string {
  try {
    return previewText(typeof input === 'string' ? input : JSON.stringify(input));
  } catch {
    return previewText(String(input));
  }
}

export interface AgentRunContextOptions {
  sessionId: string;
  courseId?: string;
  nodeId?: string;
  threadId?: string;
  provider?: string;
  model?: string;
  usageSource?: string;
  sender: WebContents;
  signal?: AbortSignal;
  initialUsage?: Partial<TokenUsage>;
  /** Safe debug metadata added to terminal error payloads. Do not include secrets. */
  errorDetails?: Record<string, unknown>;
  recorder?: ChatRunRecorder;
}

export interface StreamChunkOptions {
  isProgress?: boolean;
  isThinking?: boolean;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costCny: 0,
};

function toUsage(input?: Partial<TokenUsage>): TokenUsage {
  const inputCacheHitTokens = input?.inputCacheHitTokens ?? 0;
  const inputCacheMissTokens = input?.inputCacheMissTokens ?? 0;
  return {
    inputTokens: input?.inputTokens ?? inputCacheHitTokens + inputCacheMissTokens,
    outputTokens: input?.outputTokens ?? 0,
    costCny: input?.costCny ?? 0,
    ...(inputCacheHitTokens > 0 ? { inputCacheHitTokens } : {}),
    ...(inputCacheMissTokens > 0 ? { inputCacheMissTokens } : {}),
    ...(input?.estimated ? { estimated: true } : {}),
  };
}

/**
 * Shared event/usage/abort context for long-running agent workflows.
 *
 * This is intentionally a thin compatibility layer over the existing IPC event
 * contract. Current workflows may keep using their local safeSend helpers while
 * new workflow wrappers move to this context incrementally.
 */
export class AgentRunContext {
  private readonly usageValue: TokenUsage;
  private completed = false;
  private failed = false;
  /** Per-run task checklist (write_todos). Drives the loop's completion gate and is checkpointed. */
  readonly taskList = new TaskList();
  /** Unified structured developer-diagnostic trace ("查看思路"). */
  readonly diagnostics: RunDiagnostics;

  constructor(private readonly options: AgentRunContextOptions) {
    this.usageValue = toUsage(options.initialUsage ?? ZERO_USAGE);
    this.diagnostics = new RunDiagnostics((record) => {
      const recorder = this.options.recorder;
      if (recorder) {
        recorder.appendDiagnostic(record);
        return;
      }
      // No recorder (legacy path): render a terse line into the raw progress stream.
      const line = fallbackDiagnosticText(record);
      if (line) {
        const event = streamChunkPayload(this.sessionId, line, { isProgress: true });
        this.send(event.channel, event.data);
      }
    });
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get signal(): AbortSignal | undefined {
    return this.options.signal;
  }

  get sender(): WebContents {
    return this.options.sender;
  }

  get usage(): TokenUsage {
    return { ...this.usageValue };
  }

  get isAborted(): boolean {
    return this.options.signal?.aborted ?? false;
  }

  addUsage(usage: Partial<TokenUsage> | undefined, source?: string): TokenUsage {
    if (!usage) return this.usage;
    const normalized = toUsage(usage);
    this.usageValue.inputTokens += normalized.inputTokens;
    this.usageValue.outputTokens += normalized.outputTokens;
    this.usageValue.costCny += normalized.costCny;
    if ((normalized.inputCacheHitTokens ?? 0) > 0) {
      this.usageValue.inputCacheHitTokens = (this.usageValue.inputCacheHitTokens ?? 0) + (normalized.inputCacheHitTokens ?? 0);
    }
    if ((normalized.inputCacheMissTokens ?? 0) > 0) {
      this.usageValue.inputCacheMissTokens = (this.usageValue.inputCacheMissTokens ?? 0) + (normalized.inputCacheMissTokens ?? 0);
    }
    if (normalized.estimated) this.usageValue.estimated = true;
    if (this.options.provider && this.options.model) {
      usageLedger.record({
        sessionId: this.options.sessionId,
        courseId: this.options.courseId,
        provider: this.options.provider,
        model: this.options.model,
        usage: normalized,
        source: source ?? this.options.usageSource ?? 'agent_run',
        estimateSource: source,
      });
    }
    return this.usage;
  }

  chunk(chunk: string, options: StreamChunkOptions = {}): void {
    // Single channel per chunk: a recorder routes through CHAT_RUN_EVENT (typed,
    // persisted); without one we fall back to the raw LLM_STREAM_CHUNK stream.
    const recorder = this.options.recorder;
    if (recorder) {
      if (options.isThinking) recorder.appendThinkingDelta(chunk);
      else if (options.isProgress) recorder.appendProgressDelta(chunk);
      else recorder.appendAssistantDelta(chunk);
      return;
    }
    const event = streamChunkPayload(this.sessionId, chunk, options);
    this.send(event.channel, event.data);
  }

  /** Generic narration → unified diagnostics as a note record (was: free-form progress text). */
  progress(message: string): void {
    this.diagnostics.note(message);
  }

  /** Clean, user-facing current-phase hint (separate from the dev diagnostics). Localized by the caller. */
  phase(label: string): void {
    const recorder = this.options.recorder;
    if (recorder) {
      recorder.setPhase(label);
      return;
    }
    const event = streamChunkPayload(this.sessionId, label, { isProgress: true });
    this.send(event.channel, event.data);
  }

  thinking(message: string): void {
    this.chunk(message, { isThinking: true });
  }

  /** Stream a structured "tool starting" event so the UI can render a tool card. */
  toolCall(input: { toolCallId: string; toolName: string; input: unknown }): void {
    const event = toolCallPayload(this.sessionId, {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      inputPreview: previewInput(input.input),
    });
    this.send(event.channel, event.data);
  }

  /** Stream a structured tool outcome so the UI can complete the matching tool card. */
  toolResult(input: {
    toolCallId: string;
    toolName: string;
    status: 'completed' | 'failed';
    isError: boolean;
    durationMs?: number;
    content: string;
  }): void {
    const event = toolResultPayload(this.sessionId, {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status,
      isError: input.isError,
      durationMs: input.durationMs,
      contentPreview: previewText(input.content),
    });
    this.send(event.channel, event.data);
  }

  fileGenerated(payload: Omit<FileGeneratedPayload, 'sessionId' | 'usage'> & { usage?: TokenUsage }): void {
    const event = fileGeneratedPayload(this.sessionId, {
      ...payload,
      usage: payload.usage ?? this.usage,
    });
    this.options.recorder?.recordArtifact({
      filePath: payload.filePath,
      folderName: payload.folderName,
      nodeId: payload.nodeId,
    });
    this.options.recorder?.emit({
      type: 'artifact.created',
      runId: this.sessionId,
      sessionId: this.sessionId,
      artifactType: 'file',
      artifactId: payload.filePath,
      filePath: payload.filePath,
      folderName: payload.folderName,
      nodeId: payload.nodeId,
      usage: payload.usage ?? this.usage,
    });
    this.send(event.channel, event.data);
  }

  dagGenerated(payload: Omit<DagGeneratedPayload, 'sessionId' | 'usage'> & { usage?: TokenUsage }): void {
    const event = dagGeneratedPayload(this.sessionId, {
      ...payload,
      usage: payload.usage ?? this.usage,
    });
    this.options.recorder?.emit({
      type: 'artifact.created',
      runId: this.sessionId,
      sessionId: this.sessionId,
      artifactType: 'dag',
      artifactId: this.options.courseId,
      courseId: this.options.courseId,
      usage: payload.usage ?? this.usage,
      metadata: { nodeCount: payload.nodes.length, edgeCount: payload.edges.length },
    });
    this.send(event.channel, event.data);
  }

  complete(usage?: Partial<TokenUsage>): void {
    if (this.completed || this.failed) return;
    this.addUsage(usage);
    this.completed = true;
    const recorder = this.options.recorder;
    recorder?.persistAssistant('completed');
    // With a recorder, ChatRunService emits the terminal run.completed/aborted event.
    if (!recorder) {
      const event = streamEndPayload(this.sessionId, this.usage);
      this.send(event.channel, event.data);
    }
  }

  fail(error: unknown): void {
    if (this.completed || this.failed) return;
    this.failed = true;
    const recorder = this.options.recorder;
    const message = error instanceof Error ? error.message : String(error);
    recorder?.persistAssistant('failed', message);
    // Single channel: recorder → run.failed (CHAT_RUN_EVENT); otherwise raw LLM_STREAM_ERROR.
    // (A loop-internal failure resolves dispatch normally, so the recorder is the only
    // failure signal the renderer receives here.)
    if (recorder) {
      recorder.emitFailed(message);
    } else {
      const event = streamErrorPayload(this.sessionId, error, 'LLM_FAILED', this.options.errorDetails);
      this.send(event.channel, event.data);
    }
  }

  throwIfAborted(): void {
    if (this.isAborted) throw abortError();
  }

  private send(channel: string, data: unknown): void {
    try {
      if (!this.options.sender.isDestroyed()) {
        this.options.sender.send(channel, data);
      }
    } catch {
      // The renderer may have closed while a workflow is still unwinding.
    }
  }
}
