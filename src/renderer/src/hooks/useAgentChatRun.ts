import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import { normalizeLocale } from '@shared/i18n';
import type {
  ActiveNodeFileContext,
  AgentChatRequest,
  AgentType,
  ChatMessage,
  DagGraph,
  FileAttachment,
  FileGeneratedPayload,
  LLMProvider,
  SearchMode,
  StreamChunkPayload,
  StreamEndPayload,
  StreamErrorPayload,
  ThinkingMode,
  TokenUsage,
  ChatRunEvent,
  AgentToolCallPayload,
  AgentToolResultPayload,
} from '@shared/types';
import { useChatStore } from '../stores/chat.store';
import { useSettingsStore } from '../stores/settings.store';
import { sanitizeAttachmentsForMessage } from '../components/chat/useChatAttachments';
import { selectedModelIsAvailable } from '../utils/model-selection';
import { formatStreamError } from '../utils/stream-error';

export interface DagGeneratedPayload {
  nodes: DagGraph['nodes'];
  edges: DagGraph['edges'];
  summary: string;
  usage: TokenUsage;
  sessionId: string;
}

interface GeneratedEventHelpers {
  resetSession: () => void;
}

export interface UseAgentChatRunOptions {
  agentType: AgentType;
  backendPersistence?: boolean;
  getCourseId: () => string | null | undefined;
  getNodeId?: () => string | null | undefined;
  getActiveFile?: () => ActiveNodeFileContext | undefined;
  onDagGenerated?: (payload: DagGeneratedPayload, helpers: GeneratedEventHelpers) => boolean | void;
  onFileGenerated?: (payload: FileGeneratedPayload, helpers: GeneratedEventHelpers) => void;
  onEmptyAssistantEnd?: () => void;
  onAbortRun?: (sessionId: string) => void;
  onStreamError?: (payload: StreamErrorPayload) => void;
}

function persistMessage(input: {
  message: ChatMessage;
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
}): void {
  const { message, agentType, courseId, nodeId, threadId } = input;
  window.api.invoke(IPC.DB_MESSAGE_CREATE, {
    id: message.id,
    courseId,
    nodeId,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    progress: message.progress,
    thinking: message.thinking,
    diagnostics: message.diagnostics ? JSON.stringify(message.diagnostics) : undefined,
    artifacts: message.artifacts ? JSON.stringify(message.artifacts) : undefined,
    agent: agentType,
    threadId: threadId ?? undefined,
  }).catch(() => {/* ignore */});
}

export function useAgentChatRun(options: UseAgentChatRunOptions) {
  const { t, i18n } = useTranslation();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionIdRef = useRef(crypto.randomUUID());
  const assistantMessageIdRef = useRef<string | null>(null);
  const agentType = options.agentType;
  const backendPersistence = options.backendPersistence ?? true;

  const resetSession = useCallback(() => {
    sessionIdRef.current = crypto.randomUUID();
    assistantMessageIdRef.current = null;
  }, []);

  const persistAssistant = useCallback((message: ChatMessage) => {
    const courseId = optionsRef.current.getCourseId();
    if (!courseId) return;
    persistMessage({
      message,
      agentType,
      courseId,
      nodeId: optionsRef.current.getNodeId?.() ?? undefined,
      threadId: useChatStore.getState().activeThreadId[agentType],
    });
  }, [agentType]);

  useEffect(() => {
    useChatStore.getState().setStreaming(false, agentType);
    return () => {
      const sid = sessionIdRef.current;
      const assistantMessageId = assistantMessageIdRef.current ?? undefined;
      const abortedMsg = useChatStore.getState().finalizeWithAbort(assistantMessageId);
      if (abortedMsg && !backendPersistence) persistAssistant(abortedMsg);
      resetSession();
      optionsRef.current.onAbortRun?.(sid);
      window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/* ignore */});
    };
  }, [agentType, backendPersistence, persistAssistant, resetSession]);

  useEffect(() => {
    const onChunk = (data: unknown) => {
      const { sessionId, chunk, isProgress, isThinking } = data as StreamChunkPayload;
      if (sessionId !== sessionIdRef.current) return;
      if (isThinking) {
        useChatStore.getState().appendThinkingChunk(chunk);
      } else if (isProgress) {
        useChatStore.getState().appendProgressChunk(chunk);
      } else {
        useChatStore.getState().appendChunk(chunk);
      }
    };

    const onEnd = (data: unknown) => {
      const { sessionId } = data as StreamEndPayload;
      if (sessionId !== sessionIdRef.current) return;
      const msg = useChatStore.getState().finalizeStream(assistantMessageIdRef.current ?? undefined);
      if (msg) {
        if (!backendPersistence) persistAssistant(msg);
      } else {
        optionsRef.current.onEmptyAssistantEnd?.();
      }
      resetSession();
    };

    const onError = (data: unknown) => {
      const payload = data as StreamErrorPayload;
      if (payload.sessionId !== sessionIdRef.current) return;
      useChatStore.getState().setStreamError(agentType, formatStreamError(payload), assistantMessageIdRef.current ?? undefined);
      optionsRef.current.onStreamError?.(payload);
      resetSession();
    };

    const onRunEvent = (data: unknown) => {
      const event = data as ChatRunEvent;
      if (event.sessionId !== sessionIdRef.current) return;
      if (event.type === 'message.delta') {
        useChatStore.getState().appendChunk(event.chunk ?? '');
      } else if (event.type === 'progress.delta') {
        useChatStore.getState().appendProgressChunk(event.chunk ?? '');
      } else if (event.type === 'thinking.delta') {
        useChatStore.getState().appendThinkingChunk(event.chunk ?? '');
      } else if (event.type === 'diagnostic') {
        if (event.diagnostic) useChatStore.getState().appendDiagnostic(event.diagnostic);
      } else if (event.type === 'phase') {
        useChatStore.getState().setCurrentPhase(event.phase ?? null);
      } else if (event.type === 'run.failed' && event.error) {
        useChatStore.getState().setStreamError(agentType, event.error, assistantMessageIdRef.current ?? undefined);
        resetSession();
      } else if (event.type === 'run.completed') {
        const msg = useChatStore.getState().finalizeStream(assistantMessageIdRef.current ?? undefined);
        if (msg) {
          if (!backendPersistence) persistAssistant(msg);
        } else {
          optionsRef.current.onEmptyAssistantEnd?.();
        }
        resetSession();
      } else if (event.type === 'run.aborted') {
        const abortedMsg = useChatStore.getState().finalizeWithAbort(assistantMessageIdRef.current ?? undefined);
        if (abortedMsg && !backendPersistence) persistAssistant(abortedMsg);
        resetSession();
      } else if (event.type === 'run.interrupted') {
        const msg = useChatStore.getState().finalizeStream(assistantMessageIdRef.current ?? undefined);
        if (msg) {
          if (!backendPersistence) persistAssistant(msg);
        }
        resetSession();
      }
    };

    const onDagGenerated = (data: unknown) => {
      const payload = data as DagGeneratedPayload;
      if (payload.sessionId !== sessionIdRef.current) return;
      const handledTerminal = optionsRef.current.onDagGenerated?.(payload, { resetSession });
      if (handledTerminal) resetSession();
    };

    const onFileGenerated = (data: unknown) => {
      const payload = data as FileGeneratedPayload;
      if (payload.sessionId !== sessionIdRef.current) return;
      useChatStore.getState().appendArtifact({
        filePath: payload.filePath,
        folderName: payload.folderName,
        nodeId: payload.nodeId,
      });
      optionsRef.current.onFileGenerated?.(payload, { resetSession });
    };

    const onToolCall = (data: unknown) => {
      const payload = data as AgentToolCallPayload;
      if (payload.sessionId !== sessionIdRef.current) return;
      useChatStore.getState().appendToolCall(payload);
    };

    const onToolResult = (data: unknown) => {
      const payload = data as AgentToolResultPayload;
      if (payload.sessionId !== sessionIdRef.current) return;
      useChatStore.getState().completeToolCall(payload);
    };

    window.api.on(IPC.LLM_STREAM_CHUNK, onChunk);
    window.api.on(IPC.LLM_STREAM_END, onEnd);
    window.api.on(IPC.LLM_STREAM_ERROR, onError);
    window.api.on(IPC.LLM_TOOL_CALL, onToolCall);
    window.api.on(IPC.LLM_TOOL_RESULT, onToolResult);
    window.api.on(IPC.CHAT_RUN_EVENT, onRunEvent);
    window.api.on(IPC.DAG_GENERATED, onDagGenerated);
    window.api.on(IPC.FILE_GENERATED, onFileGenerated);
    return () => {
      window.api.off(IPC.LLM_STREAM_CHUNK, onChunk);
      window.api.off(IPC.LLM_STREAM_END, onEnd);
      window.api.off(IPC.LLM_STREAM_ERROR, onError);
      window.api.off(IPC.LLM_TOOL_CALL, onToolCall);
      window.api.off(IPC.LLM_TOOL_RESULT, onToolResult);
      window.api.off(IPC.CHAT_RUN_EVENT, onRunEvent);
      window.api.off(IPC.DAG_GENERATED, onDagGenerated);
      window.api.off(IPC.FILE_GENERATED, onFileGenerated);
    };
  }, [agentType, backendPersistence, persistAssistant, resetSession]);

  const dispatchAgentChat = useCallback(async (req: AgentChatRequest) => {
    try {
      await window.api.invoke(IPC.AGENT_CHAT, req);
    } catch (err) {
      useChatStore.getState().setStreamError(agentType, err instanceof Error ? err.message : String(err), assistantMessageIdRef.current ?? undefined);
    }
  }, [agentType]);

  const handleChat = useCallback(async (
    message: string,
    attachments: FileAttachment[] = [],
    searchMode: SearchMode = 'auto',
    thinkingMode: ThinkingMode = 'off',
  ) => {
    const courseId = optionsRef.current.getCourseId();
    if (!courseId) {
      useChatStore.getState().setStreamError(agentType, t('common.select_course_first'));
      return;
    }
    if (useChatStore.getState().isStreaming) return;
    const settings = useSettingsStore.getState();
    if (!selectedModelIsAvailable(settings.provider, settings.model, settings.models, settings.providers)) {
      useChatStore.getState().setStreamError(agentType, t('common.configure_model_first'));
      return;
    }

    const sessionId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    assistantMessageIdRef.current = assistantMessageId;
    const userAttachments = sanitizeAttachmentsForMessage(attachments);
    const userMsg: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: userAttachments.length > 0 ? userAttachments : undefined,
    };
    useChatStore.getState().addMessage(agentType, userMsg);
    useChatStore.getState().setStreaming(true, agentType, sessionId);

    const threadId = useChatStore.getState().activeThreadId[agentType];
    if (!backendPersistence) {
      persistMessage({
        message: userMsg,
        agentType,
        courseId,
        nodeId: optionsRef.current.getNodeId?.() ?? undefined,
        threadId,
      });
    }

    const currentMsgs = useChatStore.getState().messages[agentType];
    if (threadId && currentMsgs.length === 1) {
      const autoTitle = message.slice(0, 30).trim() || userAttachments[0]?.name.slice(0, 30) || t('common.new_chat');
      window.api.invoke(IPC.DB_THREAD_UPDATE, threadId, { title: autoTitle }).catch(() => {/* ignore */});
      useChatStore.getState().updateThread(agentType, threadId, { title: autoTitle });
    }

    await dispatchAgentChat({
      agentType,
      courseId,
      nodeId: optionsRef.current.getNodeId?.() ?? undefined,
      threadId: threadId ?? undefined,
      sessionId,
      provider: settings.provider as LLMProvider,
      model: settings.model,
      userMessage: message,
      attachments: userAttachments.length > 0 ? userAttachments : undefined,
      searchMode,
      thinkingMode,
      language: normalizeLocale(i18n.language),
      activeFile: optionsRef.current.getActiveFile?.(),
      persistence: backendPersistence
        ? {
            mode: 'backend',
            userMessageId,
            assistantMessageId,
            persistUserMessage: true,
            persistAssistantMessage: true,
          }
        : undefined,
    });
  }, [agentType, backendPersistence, dispatchAgentChat, i18n.language, t]);

  const handleResendHistory = useCallback(async (attachments?: FileAttachment[]) => {
    const courseId = optionsRef.current.getCourseId();
    if (!courseId || useChatStore.getState().isStreaming) return;
    const settings = useSettingsStore.getState();
    if (!selectedModelIsAvailable(settings.provider, settings.model, settings.models, settings.providers)) {
      useChatStore.getState().setStreamError(agentType, t('common.configure_model_first'));
      return;
    }
    const sessionId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    sessionIdRef.current = sessionId;
    assistantMessageIdRef.current = assistantMessageId;
    useChatStore.getState().setStreaming(true, agentType, sessionId);

    const currentMessages = useChatStore.getState().messages[agentType];
    const lastMessage = currentMessages[currentMessages.length - 1];
    const resendAttachments = sanitizeAttachmentsForMessage(
      attachments ?? (lastMessage?.role === 'user' ? lastMessage.attachments ?? [] : []),
    );
    const resendSearchMode = useChatStore.getState().searchMode[agentType];
    await dispatchAgentChat({
      agentType,
      courseId,
      nodeId: optionsRef.current.getNodeId?.() ?? undefined,
      threadId: useChatStore.getState().activeThreadId[agentType] ?? undefined,
      sessionId,
      provider: settings.provider as LLMProvider,
      model: settings.model,
      userMessage: lastMessage?.content ?? '',
      attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
      searchMode: resendSearchMode,
      thinkingMode: useChatStore.getState().thinkingMode[agentType],
      language: normalizeLocale(i18n.language),
      activeFile: optionsRef.current.getActiveFile?.(),
      persistence: backendPersistence
        ? {
            mode: 'backend',
            assistantMessageId,
            persistUserMessage: false,
            persistAssistantMessage: true,
          }
        : undefined,
    });
  }, [agentType, backendPersistence, dispatchAgentChat, i18n.language, t]);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    const assistantMessageId = assistantMessageIdRef.current ?? undefined;
    const abortedMsg = useChatStore.getState().finalizeWithAbort(assistantMessageId);
    if (abortedMsg && !backendPersistence) persistAssistant(abortedMsg);
    resetSession();
    optionsRef.current.onAbortRun?.(sid);
    window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/* ignore */});
  }, [backendPersistence, persistAssistant, resetSession]);

  return {
    sessionIdRef,
    handleChat,
    handleResendHistory,
    handleAbort,
  };
}
