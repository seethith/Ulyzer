import { create } from 'zustand';
import i18n from '../i18n';
import type {
  ChatMessage,
  AgentType,
  ChatThread,
  DiagnosticRecord,
  FileAttachment,
  MessageArtifact,
  SearchMode,
  ThinkingMode,
  AgentToolCallPayload,
  AgentToolResultPayload,
} from '@shared/types';

/** Live view of one tool invocation in the active run (call → result). */
export interface ToolCallUi {
  toolCallId: string;
  toolName: string;
  inputPreview: string;
  status: 'running' | 'completed' | 'failed';
  isError?: boolean;
  durationMs?: number;
  contentPreview?: string;
}

export interface ChatDraftQuote {
  id: string;
  text: string;
  sourceName?: string;
  sourcePath?: string;
  relativePath?: string;
  lineFrom?: number;
  lineTo?: number;
  createdAt: number;
}

export interface ChatRunUiState {
  runId: string;
  agent: AgentType;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  streamingContent: string;
  progressContent: string;
  error?: string | null;
  startedAt: number;
  updatedAt: number;
}

interface ChatState {
  messages: Record<AgentType, ChatMessage[]>;
  isStreaming: boolean;
  streamingContent: string;
  /** Accumulated live tool-trace progress (查看思路); committed to the final assistant message. */
  progressContent: string;
  /** Accumulated live reasoning/thinking; committed to the final assistant message's thinking. */
  thinkingContent: string;
  /** Structured tool calls for the active run, shown as live tool cards. */
  liveToolEvents: ToolCallUi[];
  /** Structured developer-diagnostic records for the active run (查看思路). */
  liveDiagnostics: DiagnosticRecord[];
  /** Files generated during the active run, committed onto the final assistant message. */
  liveArtifacts: MessageArtifact[];
  /** Clean user-facing current-phase hint for the active run. */
  currentPhase: string | null;
  streamingAgent: AgentType | null;
  runs: Record<string, ChatRunUiState>;
  activeRunId: Record<AgentType, string | null>;
  streamError: Record<AgentType, string | null>;
  searchMode: Record<AgentType, SearchMode>;
  setSearchMode: (agent: AgentType, mode: SearchMode) => void;
  thinkingMode: Record<AgentType, ThinkingMode>;
  setThinkingMode: (agent: AgentType, mode: ThinkingMode) => void;
  draftQuote: Record<AgentType, ChatDraftQuote | null>;
  setDraftQuote: (agent: AgentType, quote: ChatDraftQuote) => void;
  clearDraftQuote: (agent: AgentType) => void;

  // ── Thread state ──────────────────────────────────────────────────────────────
  threads: Record<AgentType, ChatThread[]>;
  activeThreadId: Record<AgentType, string | null>;
  setThreads: (agent: AgentType, threads: ChatThread[]) => void;
  setActiveThreadId: (agent: AgentType, threadId: string | null) => void;
  addThread: (agent: AgentType, thread: ChatThread) => void;
  updateThread: (agent: AgentType, threadId: string, updates: Partial<ChatThread>) => void;
  removeThread: (agent: AgentType, threadId: string) => void;

  addMessage: (agent: AgentType, msg: ChatMessage) => void;
  deleteMessage: (agent: AgentType, id: string) => void;
  updateMessage: (agent: AgentType, id: string, content: string, attachments?: FileAttachment[]) => void;
  truncateAfterMessage: (agent: AgentType, id: string) => void;
  beginRun: (agent: AgentType, runId: string) => void;
  setStreaming: (streaming: boolean, agent?: AgentType, runId?: string) => void;
  appendChunk: (chunk: string) => void;
  appendProgressChunk: (chunk: string) => void;
  appendThinkingChunk: (chunk: string) => void;
  appendDiagnostic: (record: DiagnosticRecord) => void;
  appendArtifact: (artifact: MessageArtifact) => void;
  setCurrentPhase: (phase: string | null) => void;
  appendToolCall: (payload: AgentToolCallPayload) => void;
  completeToolCall: (payload: AgentToolResultPayload) => void;
  finalizeStream: (messageId?: string) => ChatMessage | null;
  /** Commit any partial streaming content as a message marked "已停止生成", then reset streaming state.
   *  Returns the created message so callers can persist it to DB, or null if nothing was committed. */
  finalizeWithAbort: (messageId?: string) => ChatMessage | null;
  setStreamError: (agent: AgentType, err: string | null, messageId?: string) => void;
  clearMessages: (agent: AgentType) => void;
}

const NO_ERROR: Record<AgentType, string | null> = { main_tutor: null, sub_tutor: null };
const NO_THREADS: Record<AgentType, ChatThread[]> = { main_tutor: [], sub_tutor: [] };
const NO_ACTIVE_THREAD: Record<AgentType, string | null> = { main_tutor: null, sub_tutor: null };
const NO_ACTIVE_RUN: Record<AgentType, string | null> = { main_tutor: null, sub_tutor: null };
const DEFAULT_SEARCH_MODE: Record<AgentType, SearchMode> = { main_tutor: 'auto', sub_tutor: 'auto' };
const DEFAULT_THINKING_MODE: Record<AgentType, ThinkingMode> = { main_tutor: 'off', sub_tutor: 'off' };
const NO_DRAFT_QUOTE: Record<AgentType, ChatDraftQuote | null> = { main_tutor: null, sub_tutor: null };

export const useChatStore = create<ChatState>((set, get) => ({
  messages: { main_tutor: [], sub_tutor: [] },
  isStreaming: false,
  streamingContent: '',
  progressContent: '',
  thinkingContent: '',
  liveToolEvents: [],
  liveDiagnostics: [],
  liveArtifacts: [],
  currentPhase: null,
  streamingAgent: null,
  runs: {},
  activeRunId: { ...NO_ACTIVE_RUN },
  streamError: { ...NO_ERROR },
  searchMode: { ...DEFAULT_SEARCH_MODE },
  thinkingMode: { ...DEFAULT_THINKING_MODE },
  draftQuote: { ...NO_DRAFT_QUOTE },
  threads: { ...NO_THREADS },
  activeThreadId: { ...NO_ACTIVE_THREAD },

  setSearchMode: (agent, mode) =>
    set((s) => ({ searchMode: { ...s.searchMode, [agent]: mode } })),

  setThinkingMode: (agent, mode) =>
    set((s) => ({ thinkingMode: { ...s.thinkingMode, [agent]: mode } })),

  setDraftQuote: (agent, quote) =>
    set((s) => ({ draftQuote: { ...s.draftQuote, [agent]: quote } })),

  clearDraftQuote: (agent) =>
    set((s) => ({ draftQuote: { ...s.draftQuote, [agent]: null } })),

  setThreads: (agent, threads) =>
    set((s) => ({ threads: { ...s.threads, [agent]: threads } })),

  setActiveThreadId: (agent, threadId) =>
    set((s) => ({ activeThreadId: { ...s.activeThreadId, [agent]: threadId } })),

  addThread: (agent, thread) =>
    set((s) => ({ threads: { ...s.threads, [agent]: [thread, ...s.threads[agent]] } })),

  updateThread: (agent, threadId, updates) =>
    set((s) => ({
      threads: {
        ...s.threads,
        [agent]: s.threads[agent].map((t) =>
          t.id === threadId ? { ...t, ...updates } : t
        ),
      },
    })),

  removeThread: (agent, threadId) =>
    set((s) => ({
      threads: {
        ...s.threads,
        [agent]: s.threads[agent].filter((t) => t.id !== threadId),
      },
    })),

  addMessage: (agent, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agent]: [...state.messages[agent], msg],
      },
    })),

  deleteMessage: (agent, id) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agent]: state.messages[agent].filter((m) => m.id !== id),
      },
    })),

  updateMessage: (agent, id, content, attachments) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agent]: state.messages[agent].map((m) => {
          if (m.id !== id) return m;
          const next: ChatMessage = { ...m, content };
          if (attachments !== undefined) next.attachments = attachments.length > 0 ? attachments : undefined;
          return next;
        }),
      },
    })),

  truncateAfterMessage: (agent, id) =>
    set((state) => {
      const msgs = state.messages[agent];
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx === -1) return state;
      return {
        messages: { ...state.messages, [agent]: msgs.slice(0, idx + 1) },
      };
    }),

  beginRun: (agent, runId) =>
    set((s) => ({
      isStreaming: true,
      streamingAgent: agent,
      streamingContent: '',
      progressContent: '',
      thinkingContent: '',
      liveToolEvents: [],
      liveDiagnostics: [],
      liveArtifacts: [],
      currentPhase: null,
      activeRunId: { ...s.activeRunId, [agent]: runId },
      runs: {
        ...s.runs,
        [runId]: {
          runId,
          agent,
          status: 'running',
          streamingContent: '',
          progressContent: '',
          error: null,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      streamError: { ...s.streamError, [agent]: null },
    })),

  setStreaming: (streaming, agent, runId) =>
    set((s) => {
      if (streaming && agent) {
        const nextRunId = runId ?? s.activeRunId[agent] ?? crypto.randomUUID();
        return {
          isStreaming: true,
          streamingAgent: agent,
          streamingContent: '',
          progressContent: '',
          thinkingContent: '',
          liveToolEvents: [],
          liveDiagnostics: [],
          liveArtifacts: [],
          currentPhase: null,
          activeRunId: { ...s.activeRunId, [agent]: nextRunId },
          runs: {
            ...s.runs,
            [nextRunId]: {
              runId: nextRunId,
              agent,
              status: 'running',
              streamingContent: '',
              progressContent: '',
              error: null,
              startedAt: s.runs[nextRunId]?.startedAt ?? Date.now(),
              updatedAt: Date.now(),
            },
          },
          streamError: { ...s.streamError, [agent]: null },
        };
      }
      const activeAgent = agent ?? s.streamingAgent;
      const activeRunId = activeAgent ? s.activeRunId[activeAgent] : null;
      return {
        isStreaming: false,
        streamingAgent: null,
        streamingContent: '',
        progressContent: '',
        thinkingContent: '',
        liveToolEvents: [],
        liveDiagnostics: [],
        liveArtifacts: [],
        currentPhase: null,
        activeRunId: activeAgent ? { ...s.activeRunId, [activeAgent]: null } : s.activeRunId,
        runs: activeRunId && s.runs[activeRunId]
          ? {
              ...s.runs,
              [activeRunId]: { ...s.runs[activeRunId], status: 'completed', updatedAt: Date.now() },
            }
          : s.runs,
      };
    }),

  appendChunk: (chunk) =>
    set((state) => {
      const runId = state.streamingAgent ? state.activeRunId[state.streamingAgent] : null;
      return {
        streamingContent: state.streamingContent + chunk,
        runs: runId && state.runs[runId]
          ? {
              ...state.runs,
              [runId]: {
                ...state.runs[runId],
                streamingContent: state.runs[runId].streamingContent + chunk,
                updatedAt: Date.now(),
              },
            }
          : state.runs,
      };
    }),

  appendProgressChunk: (chunk) =>
    set((state) => {
      const runId = state.streamingAgent ? state.activeRunId[state.streamingAgent] : null;
      return {
        progressContent: state.progressContent + chunk,
        runs: runId && state.runs[runId]
          ? {
              ...state.runs,
              [runId]: {
                ...state.runs[runId],
                progressContent: state.runs[runId].progressContent + chunk,
                updatedAt: Date.now(),
              },
            }
          : state.runs,
      };
    }),

  appendThinkingChunk: (chunk) =>
    set((state) => ({ thinkingContent: state.thinkingContent + chunk })),

  appendDiagnostic: (record) =>
    set((state) => ({ liveDiagnostics: [...state.liveDiagnostics, record] })),

  appendArtifact: (artifact) =>
    set((state) =>
      state.liveArtifacts.some((a) => a.filePath === artifact.filePath)
        ? state
        : { liveArtifacts: [...state.liveArtifacts, artifact] }),

  setCurrentPhase: (phase) => set({ currentPhase: phase }),

  appendToolCall: (payload) =>
    set((state) => {
      const existing = state.liveToolEvents.some((e) => e.toolCallId === payload.toolCallId);
      if (existing) {
        return {
          liveToolEvents: state.liveToolEvents.map((e) =>
            e.toolCallId === payload.toolCallId
              ? { ...e, toolName: payload.toolName, inputPreview: payload.inputPreview }
              : e),
        };
      }
      return {
        liveToolEvents: [
          ...state.liveToolEvents,
          {
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            inputPreview: payload.inputPreview,
            status: 'running' as const,
          },
        ],
      };
    }),

  completeToolCall: (payload) =>
    set((state) => ({
      liveToolEvents: state.liveToolEvents.map((e) =>
        e.toolCallId === payload.toolCallId
          ? {
              ...e,
              status: payload.status,
              isError: payload.isError,
              durationMs: payload.durationMs,
              contentPreview: payload.contentPreview,
            }
          : e),
    })),

  finalizeStream: (messageId) => {
    const { streamingContent, progressContent, thinkingContent, liveDiagnostics, liveArtifacts, streamingAgent, messages, activeRunId, runs } = get();
    if (!streamingAgent || !streamingContent) {
      const runId = streamingAgent ? activeRunId[streamingAgent] : null;
      set({
        isStreaming: false,
        streamingContent: '',
        progressContent: '',
        thinkingContent: '',
        liveToolEvents: [],
        liveDiagnostics: [],
        liveArtifacts: [],
        currentPhase: null,
        streamingAgent: null,
        activeRunId: streamingAgent ? { ...activeRunId, [streamingAgent]: null } : activeRunId,
        runs: runId && runs[runId]
          ? { ...runs, [runId]: { ...runs[runId], status: 'completed', updatedAt: Date.now() } }
          : runs,
      });
      return null;
    }

    const assistantMsg: ChatMessage = {
      id: messageId ?? crypto.randomUUID(),
      role: 'assistant',
      content: streamingContent,
      timestamp: Date.now(),
      progress: progressContent || undefined,
      thinking: thinkingContent || undefined,
      diagnostics: liveDiagnostics.length > 0 ? liveDiagnostics : undefined,
      artifacts: liveArtifacts.length > 0 ? liveArtifacts : undefined,
    };

    const runId = activeRunId[streamingAgent];
    set({
      isStreaming: false,
      streamingContent: '',
      progressContent: '',
      thinkingContent: '',
      liveToolEvents: [],
      liveDiagnostics: [],
      liveArtifacts: [],
      currentPhase: null,
      streamingAgent: null,
      activeRunId: { ...activeRunId, [streamingAgent]: null },
      runs: runId && runs[runId]
        ? { ...runs, [runId]: { ...runs[runId], status: 'completed', updatedAt: Date.now() } }
        : runs,
      messages: {
        ...messages,
        [streamingAgent]: [...messages[streamingAgent], assistantMsg],
      },
    });
    return assistantMsg;
  },

  finalizeWithAbort: (messageId) => {
    const { streamingContent, progressContent, thinkingContent, liveDiagnostics, liveArtifacts, streamingAgent, messages, activeRunId, runs } = get();
    if (!streamingAgent) {
      set({ isStreaming: false, streamingContent: '', progressContent: '', thinkingContent: '', liveToolEvents: [], liveDiagnostics: [], liveArtifacts: [], currentPhase: null, streamingAgent: null });
      return null;
    }
    const stoppedMarker = `*⏹ ${i18n.t('chat_messages.stopped')}*`;
    const content = (streamingContent ?? '').trim()
      ? streamingContent + '\n\n---\n' + stoppedMarker
      : stoppedMarker;
    const msg: ChatMessage = {
      id: messageId ?? crypto.randomUUID(), role: 'assistant', content, timestamp: Date.now(),
      progress: progressContent || undefined,
      thinking: thinkingContent || undefined,
      diagnostics: liveDiagnostics.length > 0 ? liveDiagnostics : undefined,
      artifacts: liveArtifacts.length > 0 ? liveArtifacts : undefined,
    };
    const runId = activeRunId[streamingAgent];
    set({
      isStreaming: false, streamingContent: '', progressContent: '', thinkingContent: '', liveToolEvents: [], liveDiagnostics: [], liveArtifacts: [], currentPhase: null, streamingAgent: null,
      activeRunId: { ...activeRunId, [streamingAgent]: null },
      runs: runId && runs[runId]
        ? { ...runs, [runId]: { ...runs[runId], status: 'aborted', updatedAt: Date.now() } }
        : runs,
      messages: { ...messages, [streamingAgent]: [...messages[streamingAgent], msg] },
    });
    return msg;
  },

  setStreamError: (agent, err, messageId) => {
    // On real errors, also commit any partial content before clearing, so it isn't lost.
    const { streamingContent, progressContent, thinkingContent, liveDiagnostics, liveArtifacts, streamingAgent, messages, activeRunId, runs } = get();
    const hasPartial = streamingAgent === agent && (streamingContent ?? '').trim();
    const runId = activeRunId[agent];
    const committedMessages = hasPartial
      ? {
          ...messages,
          [agent]: [...messages[agent], {
            id: messageId ?? crypto.randomUUID(), role: 'assistant' as const,
            content: streamingContent + `\n\n---\n*⏹ ${i18n.t('chat_messages.stopped')}*`,
            timestamp: Date.now(),
            progress: progressContent || undefined,
            thinking: thinkingContent || undefined,
            diagnostics: liveDiagnostics.length > 0 ? liveDiagnostics : undefined,
            artifacts: liveArtifacts.length > 0 ? liveArtifacts : undefined,
          }],
        }
      : messages;
    set((s) => ({
      streamError: { ...s.streamError, [agent]: err },
      activeRunId: streamingAgent === agent ? { ...s.activeRunId, [agent]: null } : s.activeRunId,
      runs: runId && runs[runId]
        ? {
            ...runs,
            [runId]: {
              ...runs[runId],
              status: err ? 'failed' : runs[runId].status,
              error: err,
              updatedAt: Date.now(),
            },
          }
        : runs,
      isStreaming: false, streamingContent: '', progressContent: '', thinkingContent: '', liveToolEvents: [], liveDiagnostics: [], liveArtifacts: [], currentPhase: null, streamingAgent: null,
      messages: committedMessages,
    }));
  },

  clearMessages: (agent) =>
    set((state) => ({
      messages: { ...state.messages, [agent]: [] },
      streamError: { ...state.streamError, [agent]: null },
    })),
}));
