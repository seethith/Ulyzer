import { create } from 'zustand';
import type { ChatMessage, AgentType, ChatThread } from '@shared/types';

interface ChatState {
  messages: Record<AgentType, ChatMessage[]>;
  isStreaming: boolean;
  streamingContent: string;
  /** Accumulated tool-execution progress messages (shown inline, not saved to history) */
  progressContent: string;
  streamingAgent: AgentType | null;
  streamError: Record<AgentType, string | null>;

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
  updateMessage: (agent: AgentType, id: string, content: string) => void;
  truncateAfterMessage: (agent: AgentType, id: string) => void;
  setStreaming: (streaming: boolean, agent?: AgentType) => void;
  appendChunk: (chunk: string) => void;
  appendProgressChunk: (chunk: string) => void;
  finalizeStream: () => void;
  /** Commit any partial streaming content as a message marked "已停止生成", then reset streaming state.
   *  Returns the created message so callers can persist it to DB, or null if nothing was committed. */
  finalizeWithAbort: () => ChatMessage | null;
  setStreamError: (agent: AgentType, err: string | null) => void;
  clearMessages: (agent: AgentType) => void;
}

const NO_ERROR: Record<AgentType, string | null> = { main_tutor: null, sub_tutor: null };
const NO_THREADS: Record<AgentType, ChatThread[]> = { main_tutor: [], sub_tutor: [] };
const NO_ACTIVE_THREAD: Record<AgentType, string | null> = { main_tutor: null, sub_tutor: null };

export const useChatStore = create<ChatState>((set, get) => ({
  messages: { main_tutor: [], sub_tutor: [] },
  isStreaming: false,
  streamingContent: '',
  progressContent: '',
  streamingAgent: null,
  streamError: { ...NO_ERROR },
  threads: { ...NO_THREADS },
  activeThreadId: { ...NO_ACTIVE_THREAD },

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

  updateMessage: (agent, id, content) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agent]: state.messages[agent].map((m) =>
          m.id === id ? { ...m, content } : m
        ),
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

  setStreaming: (streaming, agent) =>
    set((s) => ({
      isStreaming: streaming,
      streamingAgent: agent ?? null,
      streamingContent: streaming ? '' : s.streamingContent,
      progressContent: streaming ? '' : s.progressContent,
      // Clear the error for this agent when starting a new stream
      streamError: agent && streaming
        ? { ...s.streamError, [agent]: null }
        : s.streamError,
    })),

  appendChunk: (chunk) =>
    set((state) => ({ streamingContent: state.streamingContent + chunk })),

  appendProgressChunk: (chunk) =>
    set((state) => ({ progressContent: state.progressContent + chunk })),

  finalizeStream: () => {
    const { streamingContent, streamingAgent, messages } = get();
    if (!streamingAgent || !streamingContent) {
      set({ isStreaming: false, streamingContent: '', progressContent: '', streamingAgent: null });
      return;
    }

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: streamingContent,
      timestamp: Date.now(),
    };

    set({
      isStreaming: false,
      streamingContent: '',
      progressContent: '',
      streamingAgent: null,
      messages: {
        ...messages,
        [streamingAgent]: [...messages[streamingAgent], assistantMsg],
      },
    });
  },

  finalizeWithAbort: () => {
    const { streamingContent, streamingAgent, messages } = get();
    if (!streamingAgent) {
      set({ isStreaming: false, streamingContent: '', progressContent: '', streamingAgent: null });
      return null;
    }
    const content = (streamingContent ?? '').trim()
      ? streamingContent + '\n\n---\n*⏹ 已停止生成*'
      : '*⏹ 已停止生成*';
    const msg: ChatMessage = {
      id: crypto.randomUUID(), role: 'assistant', content, timestamp: Date.now(),
    };
    set({
      isStreaming: false, streamingContent: '', progressContent: '', streamingAgent: null,
      messages: { ...messages, [streamingAgent]: [...messages[streamingAgent], msg] },
    });
    return msg;
  },

  setStreamError: (agent, err) => {
    // On real errors, also commit any partial content before clearing, so it isn't lost.
    const { streamingContent, streamingAgent, messages } = get();
    const hasPartial = streamingAgent === agent && (streamingContent ?? '').trim();
    const committedMessages = hasPartial
      ? {
          ...messages,
          [agent]: [...messages[agent], {
            id: crypto.randomUUID(), role: 'assistant' as const,
            content: streamingContent + '\n\n---\n*⏹ 已停止生成*',
            timestamp: Date.now(),
          }],
        }
      : messages;
    set({
      streamError: { ...get().streamError, [agent]: err },
      isStreaming: false, streamingContent: '', progressContent: '', streamingAgent: null,
      messages: committedMessages,
    });
  },

  clearMessages: (agent) =>
    set((state) => ({
      messages: { ...state.messages, [agent]: [] },
      streamError: { ...state.streamError, [agent]: null },
    })),
}));
