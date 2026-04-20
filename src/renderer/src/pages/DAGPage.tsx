import React, { useEffect, useRef, useCallback } from 'react';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import type {
  FileAttachment,
  DagGraph,
  StreamChunkPayload,
  StreamEndPayload,
  StreamErrorPayload,
  AgentChatRequest,
  LLMMessage,
  LLMProvider,
  ChatMessage,
  ChatThread,
  TokenUsage,
} from '@shared/types';
import { useAppStore } from '../stores/app.store';
import { useDAGStore } from '../stores/dag.store';
import { useChatStore } from '../stores/chat.store';
import { useSettingsStore } from '../stores/settings.store';
import { useCourseStore } from '../stores/course.store';
import { DAGCanvas } from '../components/dag/DAGCanvas';
import { ChatPanel } from '../components/chat/ChatPanel';
import type { ChatPanelPreset } from '../components/chat/ChatPanel';

// ── Preset commands ────────────────────────────────────────────────────────────
// Defined inside the component so they can use the t() function

// ── DAGPage ────────────────────────────────────────────────────────────────────

interface DagGeneratedPayload {
  nodes: DagGraph['nodes'];
  edges: DagGraph['edges'];
  summary: string;
  usage: TokenUsage;
  sessionId: string;
}

const DAGPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const setBreadcrumbs = useAppStore((s) => s.setBreadcrumbs);
  const courseId       = useAppStore((s) => s.currentCourseId);
  const courseName     = useCourseStore((s) => s.courses.find((c) => c.id === courseId)?.name ?? t('dag_page.breadcrumb_courses'));

  const isStreaming      = useChatStore((s) => s.isStreaming);
  const messages         = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const progressContent  = useChatStore((s) => s.progressContent);
  const streamError      = useChatStore((s) => s.streamError.main_tutor);
  const threads          = useChatStore((s) => s.threads.main_tutor);
  const activeThreadId   = useChatStore((s) => s.activeThreadId.main_tutor);

  const sessionIdRef = useRef(crypto.randomUUID());

  // ── Breadcrumbs ─────────────────────────────────────────────────────────────

  const mainTutorPresets: ChatPanelPreset[] = [
    { label: t('dag_page.preset_create_roadmap'), prefix: t('dag_page.preset_create_roadmap_prefix') },
    { label: t('dag_page.preset_add_node'),       prefix: t('dag_page.preset_add_node_prefix') },
    { label: t('dag_page.preset_remove_node'),    prefix: t('dag_page.preset_remove_node_prefix') },
  ];

  useEffect(() => {
    setBreadcrumbs([
      { label: t('dag_page.breadcrumb_courses'), path: '/' },
      { label: courseName, path: '/dag' },
    ]);
  }, [setBreadcrumbs, courseName, t]);

  // ── Ensure clean state on mount; abort + reset on unmount ───────────────────

  useEffect(() => {
    // Reset any stale streaming state left over from a previous mount
    useChatStore.getState().setStreaming(false);
    useDAGStore.getState().setGenerating(false);

    return () => {
      // Commit any partial streaming content before aborting so it isn't lost
      const sid = sessionIdRef.current;
      sessionIdRef.current = crypto.randomUUID();
      const abortedMsg = useChatStore.getState().finalizeWithAbort();
      // Persist the aborted message to DB so it survives page navigation
      if (abortedMsg) {
        const cid = useAppStore.getState().currentCourseId;
        const tid = useChatStore.getState().activeThreadId.main_tutor;
        if (cid) {
          window.api.invoke(IPC.DB_MESSAGE_CREATE, {
            id: abortedMsg.id, courseId: cid, role: 'assistant', content: abortedMsg.content,
            agent: 'main_tutor', threadId: tid ?? undefined,
          }).catch(() => {/* ignore */});
        }
      }
      useDAGStore.getState().setGenerating(false);
      window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/* ignore */});
    };
  }, []);  

  // ── Load DAG and thread/message history ─────────────────────────────────────

  useEffect(() => {
    if (!courseId) return;

    useDAGStore.getState().loadDAG(courseId);

    window.api
      .invoke(IPC.DB_THREAD_LIST, courseId, 'main_tutor')
      .then(async (res: unknown) => {
        const r = res as { success: boolean; data?: ChatThread[] };
        const threads = r.success && r.data ? r.data : [];

        // Clear stale state only once new data is ready to replace it
        useChatStore.getState().clearMessages('main_tutor');
        useChatStore.getState().setThreads('main_tutor', []);
        useChatStore.getState().setActiveThreadId('main_tutor', null);

        let activeThread: ChatThread;
        if (threads.length > 0) {
          activeThread = threads[0];
          useChatStore.getState().setThreads('main_tutor', threads);
        } else {
          // No threads yet — create one
          const createRes = await window.api.invoke(IPC.DB_THREAD_CREATE, {
            courseId, agent: 'main_tutor',
          });
          const cr = createRes as { success: boolean; data?: ChatThread };
          if (!cr.success || !cr.data) return;
          activeThread = cr.data;
          useChatStore.getState().setThreads('main_tutor', [activeThread]);
        }

        useChatStore.getState().setActiveThreadId('main_tutor', activeThread.id);

        // Load messages for active thread
        window.api
          .invoke(IPC.DB_MESSAGES_GET, courseId, 'main_tutor', undefined, activeThread.id)
          .then((msgRes: unknown) => {
            const mr = msgRes as { success: boolean; data?: ChatMessage[] };
            if (mr.success && mr.data) {
              const store = useChatStore.getState();
              for (const msg of mr.data) store.addMessage('main_tutor', msg);
            }
          })
          .catch(() => {/* ignore */});
      })
      .catch(() => {/* ignore */});
  }, [courseId]);

  // ── IPC stream listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const onChunk = (data: unknown) => {
      const { sessionId, chunk, isProgress } = data as StreamChunkPayload;
      if (sessionId !== sessionIdRef.current) return;
      if (isProgress) {
        useChatStore.getState().appendProgressChunk(chunk);
      } else {
        useChatStore.getState().appendChunk(chunk);
      }
    };

    const onEnd = (data: unknown) => {
      const { sessionId } = data as StreamEndPayload;
      if (sessionId !== sessionIdRef.current) return;

      // Capture content before finalizing (for persistence)
      const { streamingContent: content, streamingAgent: agent } = useChatStore.getState();
      useChatStore.getState().finalizeStream();

      // Save assistant message to DB
      if (content && agent) {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: Date.now(),
        };
        const cid = useAppStore.getState().currentCourseId;
        const tid = useChatStore.getState().activeThreadId.main_tutor;
        if (cid) {
          window.api
            .invoke(IPC.DB_MESSAGE_CREATE, { id: msg.id, courseId: cid, role: msg.role, content: msg.content, agent: 'main_tutor', threadId: tid ?? undefined })
            .catch(() => {/* ignore */});
        }
      }

      sessionIdRef.current = crypto.randomUUID();
    };

    const onError = (data: unknown) => {
      const { sessionId, error } = data as StreamErrorPayload;
      if (sessionId !== sessionIdRef.current) return;
      useChatStore.getState().setStreamError('main_tutor', error);
      useDAGStore.getState().setGenerating(false);
      sessionIdRef.current = crypto.randomUUID();
    };

    const onDagGenerated = (data: unknown) => {
      const { nodes, edges, summary, sessionId } = data as DagGeneratedPayload;
      if (sessionId !== sessionIdRef.current) return;

      useDAGStore.getState().setDAG(nodes, edges);
      useDAGStore.getState().setGenerating(false);
      // Refresh course list so progress bar/card shows updated total_nodes
      useCourseStore.getState().loadCourses().catch(() => {/* ignore */});

      // If summary is empty, this is a tool-triggered incremental DAG update (add/remove/connect node).
      // Do NOT touch streaming state or add any message — the ongoing chat stream handles that.
      if (!summary) return;

      // Attach the generation progress (curriculum refs, AI reasoning) to the summary message
      // so the user can expand it later via the "查看思路" toggle.
      const capturedProgress = useChatStore.getState().progressContent;

      // Add human-friendly summary as assistant message
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        timestamp: Date.now(),
        progress: capturedProgress || undefined,
      };
      useChatStore.getState().addMessage('main_tutor', msg);
      useChatStore.getState().setStreaming(false);

      // Save summary to DB
      const cid = useAppStore.getState().currentCourseId;
      const tid = useChatStore.getState().activeThreadId.main_tutor;
      if (cid) {
        window.api
          .invoke(IPC.DB_MESSAGE_CREATE, { id: msg.id, courseId: cid, role: 'assistant', content: summary, agent: 'main_tutor', threadId: tid ?? undefined })
          .catch(() => {/* ignore */});
      }

      sessionIdRef.current = crypto.randomUUID();
    };

    window.api.on(IPC.LLM_STREAM_CHUNK, onChunk);
    window.api.on(IPC.LLM_STREAM_END,   onEnd);
    window.api.on(IPC.LLM_STREAM_ERROR, onError);
    window.api.on(IPC.DAG_GENERATED,    onDagGenerated);

    return () => {
      window.api.off(IPC.LLM_STREAM_CHUNK, onChunk);
      window.api.off(IPC.LLM_STREAM_END,   onEnd);
      window.api.off(IPC.LLM_STREAM_ERROR, onError);
      window.api.off(IPC.DAG_GENERATED,    onDagGenerated);
    };
  }, []); // intentionally empty — handlers use getState() not props/state

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleChat = useCallback(async (message: string, attachments: FileAttachment[], _webSearchEnabled = false) => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) {
      useChatStore.getState().setStreamError('main_tutor', '请先在课程列表选择一个课程');
      return;
    }
    if (useChatStore.getState().isStreaming) return;

    const sid = crypto.randomUUID();
    sessionIdRef.current = sid;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    useChatStore.getState().addMessage('main_tutor', userMsg);
    useChatStore.getState().setStreaming(true, 'main_tutor');

    // Persist user message
    const chatTid = useChatStore.getState().activeThreadId.main_tutor;
    window.api
      .invoke(IPC.DB_MESSAGE_CREATE, { id: userMsg.id, courseId: cid, role: 'user', content: message, agent: 'main_tutor', threadId: chatTid ?? undefined })
      .catch(() => {/* ignore */});
    // Auto-title the thread on first message
    if (chatTid) {
      const currentMsgs = useChatStore.getState().messages.main_tutor;
      if (currentMsgs.length === 1) {
        const autoTitle = message.slice(0, 30).trim() || '新对话';
        window.api.invoke(IPC.DB_THREAD_UPDATE, chatTid, { title: autoTitle }).catch(() => {/* ignore */});
        useChatStore.getState().updateThread('main_tutor', chatTid, { title: autoTitle });
      }
    }

    const history: LLMMessage[] = useChatStore
      .getState()
      .messages.main_tutor.slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const req: AgentChatRequest = {
      agentType: 'main_tutor',
      courseId:  cid,
      sessionId: sid,
      provider:  useSettingsStore.getState().provider as LLMProvider,
      model:     useSettingsStore.getState().model,
      userMessage: message,
      messages: history,
      attachments: attachments.length > 0 ? attachments : undefined,
      language: i18n.language,
    };

    try {
      await window.api.invoke(IPC.AGENT_CHAT, req);
    } catch (err) {
      useChatStore.getState().setStreamError('main_tutor', err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Resend current history to AI without adding a new user message
  const handleResendHistory = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) return;
    if (useChatStore.getState().isStreaming) return;

    const sid = crypto.randomUUID();
    sessionIdRef.current = sid;
    useChatStore.getState().setStreaming(true, 'main_tutor');

    const history: LLMMessage[] = useChatStore.getState().messages.main_tutor.slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const req: AgentChatRequest = {
      agentType: 'main_tutor', courseId: cid, sessionId: sid,
      provider: useSettingsStore.getState().provider as LLMProvider,
      model:    useSettingsStore.getState().model,
      userMessage: history[history.length - 1]?.content ?? '',
      messages: history,
      language: i18n.language,
    };
    try {
      await window.api.invoke(IPC.AGENT_CHAT, req);
    } catch (err) {
      useChatStore.getState().setStreamError('main_tutor', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleEditAndResend = useCallback((id: string, content: string) => {
    useChatStore.getState().updateMessage('main_tutor', id, content);
    useChatStore.getState().truncateAfterMessage('main_tutor', id);
    handleResendHistory();
  }, [handleResendHistory]);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    sessionIdRef.current = crypto.randomUUID();
    const abortedMsg = useChatStore.getState().finalizeWithAbort();
    if (abortedMsg) {
      const cid = useAppStore.getState().currentCourseId;
      const tid = useChatStore.getState().activeThreadId.main_tutor;
      if (cid) {
        window.api.invoke(IPC.DB_MESSAGE_CREATE, {
          id: abortedMsg.id, courseId: cid, role: 'assistant', content: abortedMsg.content,
          agent: 'main_tutor', threadId: tid ?? undefined,
        }).catch(() => {/* ignore */});
      }
    }
    useDAGStore.getState().setGenerating(false);
    window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/* ignore */});
  }, []);

  const handleSave = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) return;
    await useDAGStore.getState().saveDAG(cid);
  }, []);

  // ── Thread management ────────────────────────────────────────────────────────

  const handleNewThread = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid || useChatStore.getState().isStreaming) return;
    const res = await window.api.invoke(IPC.DB_THREAD_CREATE, { courseId: cid, agent: 'main_tutor' });
    const r = res as { success: boolean; data?: ChatThread };
    if (!r.success || !r.data) return;
    useChatStore.getState().addThread('main_tutor', r.data);
    useChatStore.getState().setActiveThreadId('main_tutor', r.data.id);
    useChatStore.getState().clearMessages('main_tutor');
  }, []);

  const handleSwitchThread = useCallback(async (threadId: string) => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid || useChatStore.getState().isStreaming) return;
    useChatStore.getState().setActiveThreadId('main_tutor', threadId);
    useChatStore.getState().clearMessages('main_tutor');
    const res = await window.api.invoke(IPC.DB_MESSAGES_GET, cid, 'main_tutor', undefined, threadId);
    const r = res as { success: boolean; data?: ChatMessage[] };
    if (r.success && r.data) {
      const store = useChatStore.getState();
      for (const msg of r.data) store.addMessage('main_tutor', msg);
    }
  }, []);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    const store = useChatStore.getState();
    await window.api.invoke(IPC.DB_THREAD_DELETE, threadId).catch(() => {/* ignore */});
    store.removeThread('main_tutor', threadId);
    // If deleting the active thread, switch to the next one or create new
    if (store.activeThreadId.main_tutor === threadId) {
      const remaining = store.threads.main_tutor.filter((t) => t.id !== threadId);
      if (remaining.length > 0) {
        handleSwitchThread(remaining[0].id);
      } else {
        handleNewThread();
      }
    }
  }, [handleNewThread, handleSwitchThread]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', animation: 'pageFadeIn 150ms ease' }}>
      {!courseId && (
        <div style={{
          padding: '8px 16px',
          backgroundColor: 'var(--amber-s)',
          borderBottom: '1px solid #fcd34d',
          fontSize: 12,
          color: 'var(--amber)',
          fontWeight: 500,
        }}>
          ⚠️ 未选择课程 — 请返回课程列表选择一个课程
        </div>
      )}
      <Allotment defaultSizes={[60, 40]}>
        <Allotment.Pane minSize={300}>
          <DAGCanvas
            onSave={handleSave}
          />
        </Allotment.Pane>

        <Allotment.Pane minSize={280}>
          <ChatPanel
            title={t('dag_page.chat_title')}
            subtitle={t('dag_page.chat_subtitle')}
            presets={mainTutorPresets}
            messages={messages.main_tutor}
            streamingContent={streamingContent}
            progressContent={progressContent}
            isStreaming={isStreaming}
            streamError={streamError}
            onSend={handleChat}
            onAbort={handleAbort}
            onEditAndResendMessage={handleEditAndResend}
            threads={threads}
            activeThreadId={activeThreadId}
            onNewThread={handleNewThread}
            onSwitchThread={handleSwitchThread}
            onDeleteThread={handleDeleteThread}
          />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
};

export default DAGPage;
