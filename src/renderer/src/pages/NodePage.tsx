import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { FlagTriangleRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import type {
  DagNode,
  StreamChunkPayload,
  StreamEndPayload,
  StreamErrorPayload,
  AgentChatRequest,
  LLMMessage,
  LLMProvider,
  ChatMessage,
  ChatThread,
  FileGeneratedPayload,
  FileAttachment,
} from '@shared/types';
import { useAppStore } from '../stores/app.store';
import { useChatStore } from '../stores/chat.store';
import { useCourseStore } from '../stores/course.store';
import { useEditorStore } from '../stores/editor.store';
import { useSettingsStore } from '../stores/settings.store';
import { FileExplorer } from '../components/workspace/FileExplorer';
import { EditorArea } from '../components/workspace/EditorArea';
import { ChatPanel } from '../components/chat/ChatPanel';
import type { ChatPanelPreset } from '../components/chat/ChatPanel';
import { useDAGStore } from '../stores/dag.store';

// ── Presets ────────────────────────────────────────────────────────────────────
// Built inside component to support i18n

// ── DAG store helper ──────────────────────────────────────────────────────────

function updateDagNodeStatus(updatedNodes: DagNode[]) {
  const dagStore = useDAGStore.getState();
  for (const n of updatedNodes) {
    dagStore.updateNode(n.id, { status: n.status });
  }
}

// ── Completion modal ───────────────────────────────────────────────────────────

interface CompleteModalProps {
  isCompleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const CompleteModal: React.FC<CompleteModalProps> = ({ isCompleting, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  return (
  <div style={{
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  }}>
    <div style={{
      backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '28px 32px', maxWidth: 480, width: '90%',
      boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
    }}>
      <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
        {t('node_page.complete_node_title')}
      </h3>

      {/* Learning flow visual */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, marginBottom: 20, padding: '14px 16px',
        backgroundColor: 'var(--surface2)', borderRadius: 8,
      }}>
        {[
          { icon: '📖', label: t('node_page.complete_step_theory') },
          { icon: '🔬', label: t('node_page.complete_step_practice') },
          { icon: '💭', label: t('node_page.complete_step_review') },
        ].map((step, i, arr) => (
          <React.Fragment key={step.label}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 20 }}>{step.icon}</span>
              <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{step.label}</span>
            </div>
            {i < arr.length - 1 && (
              <span style={{ color: 'var(--text3)', fontSize: 16, marginBottom: 16 }}>→</span>
            )}
          </React.Fragment>
        ))}
      </div>

      <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.8, marginBottom: 24 }}>
        <p style={{ margin: '0 0 10px' }}>{t('node_page.complete_desc')}</p>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>{t('node_page.complete_step_theory')}</strong>：{t('node_page.complete_theory_detail')}</li>
          <li><strong>{t('node_page.complete_step_practice')}</strong>：{t('node_page.complete_practice_detail')}</li>
          <li><strong>{t('node_page.complete_step_review')}</strong>：{t('node_page.complete_review_detail')}</li>
        </ul>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '8px 20px', fontSize: 13, borderRadius: 6,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text2)', cursor: 'pointer',
          }}
        >
          {t('node_page.complete_btn_cancel')}
        </button>
        <button
          onClick={onConfirm}
          disabled={isCompleting}
          style={{
            padding: '8px 20px', fontSize: 13, borderRadius: 6,
            border: 'none', background: 'var(--accent)',
            color: '#fff', cursor: isCompleting ? 'not-allowed' : 'pointer',
            opacity: isCompleting ? 0.7 : 1,
          }}
        >
          {isCompleting ? t('node_page.completing') : t('node_page.complete_btn_confirm')}
        </button>
      </div>
    </div>
  </div>
  );
};

// ── NodePage ───────────────────────────────────────────────────────────────────

const NodePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const setBreadcrumbs = useAppStore((s) => s.setBreadcrumbs);
  const nodeId         = useAppStore((s) => s.currentNodeId);
  const courseId       = useAppStore((s) => s.currentCourseId);
  const courseName     = useCourseStore((s) => s.courses.find((c) => c.id === courseId)?.name ?? t('dag_page.breadcrumb_courses'));

  const isStreaming      = useChatStore((s) => s.isStreaming);
  const messages         = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const progressContent  = useChatStore((s) => s.progressContent);
  const streamError      = useChatStore((s) => s.streamError.sub_tutor);
  const threads          = useChatStore((s) => s.threads.sub_tutor);
  const activeThreadId   = useChatStore((s) => s.activeThreadId.sub_tutor);

  const sessionIdRef = useRef(crypto.randomUUID());
  const [node, setNode] = useState<DagNode | null>(null);

  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  const subTutorPresets: ChatPanelPreset[] = [
    { label: t('node_page.preset_gen_theory'),   prefix: t('node_page.preset_gen_theory_prefix') },
    { label: t('node_page.preset_gen_practice'), prefix: t('node_page.preset_gen_practice_prefix') },
    { label: t('node_page.preset_gen_review'),   prefix: t('node_page.preset_gen_review_prefix') },
    { label: t('node_page.preset_gen_outline'),  prefix: t('node_page.preset_gen_outline_prefix') },
    { label: t('node_page.preset_gen_topic'),    prefix: t('node_page.preset_gen_topic_prefix') },
  ];

  // ── Breadcrumbs + header cleanup ──────────────────────────────────────────────

  useEffect(() => {
    setBreadcrumbs([
      { label: t('node_page.breadcrumb_courses'), path: '/' },
      { label: courseName, path: '/dag' },
      { label: t('node_page.breadcrumb_node'), path: '/node' },
    ]);
    return () => {
      useAppStore.getState().setHeaderAction(null);
      useEditorStore.getState().clearAll();
    };
  }, [setBreadcrumbs]);

  // ── Clean state on mount; abort on unmount ────────────────────────────────────

  useEffect(() => {
    useChatStore.getState().setStreaming(false);
    return () => {
      const sid = sessionIdRef.current;
      sessionIdRef.current = crypto.randomUUID();
      const abortedMsg = useChatStore.getState().finalizeWithAbort();
      if (abortedMsg) {
        const cid = useAppStore.getState().currentCourseId;
        const nid = useAppStore.getState().currentNodeId;
        const tid = useChatStore.getState().activeThreadId.sub_tutor;
        if (cid) {
          window.api.invoke(IPC.DB_MESSAGE_CREATE, {
            id: abortedMsg.id, courseId: cid, nodeId: nid ?? undefined,
            role: 'assistant', content: abortedMsg.content, agent: 'sub_tutor',
            threadId: tid ?? undefined,
          }).catch(() => {/* ignore */});
        }
      }
      window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/* ignore */});
    };
  }, []);  

  // ── Load node + files + history ───────────────────────────────────────────────

  useEffect(() => {
    if (!nodeId || !courseId) return;

    window.api.invoke(IPC.DB_NODE_GET, nodeId)
      .then((res: unknown) => {
        const r = res as { success: boolean; data?: DagNode };
        if (r.success && r.data) {
          setNode(r.data);
          setBreadcrumbs([
            { label: t('node_page.breadcrumb_courses'), path: '/' },
            { label: courseName, path: '/dag' },
            { label: r.data.name, path: '/node' },
          ]);
        }
      })
      .catch(() => {/* ignore */});

    window.api.invoke(IPC.FS_ENSURE_NODE, courseId, nodeId, i18n.language).catch(() => {/* ignore */});
    useEditorStore.getState().loadTree(courseId, nodeId).catch(() => {/* ignore */});

    window.api
      .invoke(IPC.DB_THREAD_LIST, courseId, 'sub_tutor', nodeId)
      .then(async (res: unknown) => {
        const r = res as { success: boolean; data?: ChatThread[] };
        const threads = r.success && r.data ? r.data : [];

        // Clear stale state only once new data is ready to replace it
        useChatStore.getState().clearMessages('sub_tutor');
        useChatStore.getState().setThreads('sub_tutor', []);
        useChatStore.getState().setActiveThreadId('sub_tutor', null);

        let activeThread: ChatThread;
        if (threads.length > 0) {
          activeThread = threads[0];
          useChatStore.getState().setThreads('sub_tutor', threads);
        } else {
          const createRes = await window.api.invoke(IPC.DB_THREAD_CREATE, {
            courseId, agent: 'sub_tutor', nodeId,
          });
          const cr = createRes as { success: boolean; data?: ChatThread };
          if (!cr.success || !cr.data) return;
          activeThread = cr.data;
          useChatStore.getState().setThreads('sub_tutor', [activeThread]);
        }

        useChatStore.getState().setActiveThreadId('sub_tutor', activeThread.id);

        window.api
          .invoke(IPC.DB_MESSAGES_GET, courseId, 'sub_tutor', nodeId, activeThread.id)
          .then((msgRes: unknown) => {
            const mr = msgRes as { success: boolean; data?: ChatMessage[] };
            if (mr.success && mr.data) {
              const store = useChatStore.getState();
              for (const msg of mr.data) store.addMessage('sub_tutor', msg);
            }
          })
          .catch(() => {/* ignore */});
      })
      .catch(() => {/* ignore */});
  }, [nodeId, courseId, setBreadcrumbs]);

  // ── IPC stream listeners ──────────────────────────────────────────────────────

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
      const { streamingContent: content } = useChatStore.getState();
      useChatStore.getState().finalizeStream();
      if (content) {
        const cid = useAppStore.getState().currentCourseId;
        const tid = useChatStore.getState().activeThreadId.sub_tutor;
        if (cid) {
          const msg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: Date.now() };
          window.api.invoke(IPC.DB_MESSAGE_CREATE, {
            id: msg.id, courseId: cid, nodeId: useAppStore.getState().currentNodeId ?? undefined,
            role: 'assistant', content, agent: 'sub_tutor', threadId: tid ?? undefined,
          }).catch(() => {/**/});
        }
      } else {
        // Outline / topic generation produces no chat content — refresh file tree
        const cid = useAppStore.getState().currentCourseId;
        const nid = useAppStore.getState().currentNodeId;
        if (cid && nid) useEditorStore.getState().loadTree(cid, nid).catch(() => {});
      }
      sessionIdRef.current = crypto.randomUUID();
    };

    const onError = (data: unknown) => {
      const { sessionId, error } = data as StreamErrorPayload;
      if (sessionId !== sessionIdRef.current) return;
      useChatStore.getState().setStreamError('sub_tutor', error);
      sessionIdRef.current = crypto.randomUUID();
    };

    const onFileGenerated = (data: unknown) => {
      const { sessionId, filePath, nodeId: nid } = data as FileGeneratedPayload;
      if (sessionId !== sessionIdRef.current) return;
      const cid = useAppStore.getState().currentCourseId;
      if (cid && nid) {
        useEditorStore.getState().loadTree(cid, nid).then(() => {
          useEditorStore.getState().openFile(filePath, filePath.split(/[/\\]/).pop() ?? 'file.md').catch(() => {/* ignore */});
        }).catch(() => {/* ignore */});
      }
      // NOTE: do NOT rotate sessionIdRef here — LLM_STREAM_END arrives after FILE_GENERATED
      // and needs the same session ID to match. Session rotation happens only in onEnd/onError.
    };

    window.api.on(IPC.LLM_STREAM_CHUNK, onChunk);
    window.api.on(IPC.LLM_STREAM_END,   onEnd);
    window.api.on(IPC.LLM_STREAM_ERROR, onError);
    window.api.on(IPC.FILE_GENERATED,   onFileGenerated);
    return () => {
      window.api.off(IPC.LLM_STREAM_CHUNK, onChunk);
      window.api.off(IPC.LLM_STREAM_END,   onEnd);
      window.api.off(IPC.LLM_STREAM_ERROR, onError);
      window.api.off(IPC.FILE_GENERATED,   onFileGenerated);
    };
  }, []); // intentionally empty — handlers use getState()

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const handleChat = useCallback(async (message: string, attachments: FileAttachment[] = [], webSearchEnabled = false) => {
    const nid = useAppStore.getState().currentNodeId;
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) { useChatStore.getState().setStreamError('sub_tutor', '请先选择课程'); return; }
    if (useChatStore.getState().isStreaming) return;

    const settings = useSettingsStore.getState();
    const history: LLMMessage[] = useChatStore.getState().messages.sub_tutor.slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const effectiveMessage = message;

    const sid = crypto.randomUUID();
    sessionIdRef.current = sid;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(), role: 'user', content: message, timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    useChatStore.getState().addMessage('sub_tutor', userMsg);
    useChatStore.getState().setStreaming(true, 'sub_tutor');
    const chatTid = useChatStore.getState().activeThreadId.sub_tutor;
    window.api.invoke(IPC.DB_MESSAGE_CREATE, { id: userMsg.id, courseId: cid, nodeId: nid ?? undefined, role: 'user', content: message, agent: 'sub_tutor', threadId: chatTid ?? undefined }).catch(() => {/**/});
    if (chatTid && useChatStore.getState().messages.sub_tutor.length === 1) {
      const autoTitle = message.slice(0, 30).trim() || '新对话';
      window.api.invoke(IPC.DB_THREAD_UPDATE, chatTid, { title: autoTitle }).catch(() => {/**/});
      useChatStore.getState().updateThread('sub_tutor', chatTid, { title: autoTitle });
    }

    const req: AgentChatRequest = {
      agentType: 'sub_tutor', courseId: cid, nodeId: nid ?? undefined,
      sessionId: sid,
      provider: settings.provider as LLMProvider,
      model:    settings.model,
      userMessage: effectiveMessage, messages: history,
      attachments: attachments.length > 0 ? attachments : undefined,
      webSearchEnabled: webSearchEnabled || undefined,
      language: i18n.language,
    };
    try {
      await window.api.invoke(IPC.AGENT_CHAT, req);
    } catch (err) {
      useChatStore.getState().setStreamError('sub_tutor', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleAbort = useCallback(() => {
    const sid = sessionIdRef.current;
    sessionIdRef.current = crypto.randomUUID();
    const abortedMsg = useChatStore.getState().finalizeWithAbort();
    if (abortedMsg) {
      const cid = useAppStore.getState().currentCourseId;
      const nid = useAppStore.getState().currentNodeId;
      const tid = useChatStore.getState().activeThreadId.sub_tutor;
      if (cid) {
        window.api.invoke(IPC.DB_MESSAGE_CREATE, {
          id: abortedMsg.id, courseId: cid, nodeId: nid ?? undefined,
          role: 'assistant', content: abortedMsg.content, agent: 'sub_tutor',
          threadId: tid ?? undefined,
        }).catch(() => {/**/});
      }
    }
    window.api.invoke(IPC.LLM_ABORT, sid).catch(() => {/**/});
  }, []);

  const handleResendHistory = useCallback(async () => {
    const nid = useAppStore.getState().currentNodeId;
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) return;
    if (useChatStore.getState().isStreaming) return;

    const sid = crypto.randomUUID();
    sessionIdRef.current = sid;
    useChatStore.getState().setStreaming(true, 'sub_tutor');

    const history: LLMMessage[] = useChatStore.getState().messages.sub_tutor.slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const req: AgentChatRequest = {
      agentType: 'sub_tutor', courseId: cid, nodeId: nid ?? undefined,
      sessionId: sid,
      provider: useSettingsStore.getState().provider as LLMProvider,
      model:    useSettingsStore.getState().model,
      userMessage: history[history.length - 1]?.content ?? '',
      messages: history,
      language: i18n.language,
    };
    try {
      await window.api.invoke(IPC.AGENT_CHAT, req);
    } catch (err) {
      useChatStore.getState().setStreamError('sub_tutor', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleEditAndResend = useCallback((id: string, content: string) => {
    useChatStore.getState().updateMessage('sub_tutor', id, content);
    useChatStore.getState().truncateAfterMessage('sub_tutor', id);
    handleResendHistory();
  }, [handleResendHistory]);

  // ── Thread management ─────────────────────────────────────────────────────────

  const handleNewThread = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    const nid = useAppStore.getState().currentNodeId;
    if (!cid || useChatStore.getState().isStreaming) return;
    const res = await window.api.invoke(IPC.DB_THREAD_CREATE, { courseId: cid, agent: 'sub_tutor', nodeId: nid ?? undefined });
    const r = res as { success: boolean; data?: ChatThread };
    if (!r.success || !r.data) return;
    useChatStore.getState().addThread('sub_tutor', r.data);
    useChatStore.getState().setActiveThreadId('sub_tutor', r.data.id);
    useChatStore.getState().clearMessages('sub_tutor');
  }, []);

  const handleSwitchThread = useCallback(async (threadId: string) => {
    const cid = useAppStore.getState().currentCourseId;
    const nid = useAppStore.getState().currentNodeId;
    if (!cid || useChatStore.getState().isStreaming) return;
    useChatStore.getState().setActiveThreadId('sub_tutor', threadId);
    useChatStore.getState().clearMessages('sub_tutor');
    const res = await window.api.invoke(IPC.DB_MESSAGES_GET, cid, 'sub_tutor', nid ?? undefined, threadId);
    const r = res as { success: boolean; data?: ChatMessage[] };
    if (r.success && r.data) {
      const store = useChatStore.getState();
      for (const msg of r.data) store.addMessage('sub_tutor', msg);
    }
  }, []);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    const store = useChatStore.getState();
    await window.api.invoke(IPC.DB_THREAD_DELETE, threadId).catch(() => {/**/});
    store.removeThread('sub_tutor', threadId);
    if (store.activeThreadId.sub_tutor === threadId) {
      const remaining = store.threads.sub_tutor.filter((t) => t.id !== threadId);
      if (remaining.length > 0) {
        handleSwitchThread(remaining[0].id);
      } else {
        handleNewThread();
      }
    }
  }, [handleNewThread, handleSwitchThread]);

  // ── Complete node ─────────────────────────────────────────────────────────────

  const handleCompleteNode = useCallback(async () => {
    const nid = useAppStore.getState().currentNodeId;
    if (!nid) return;
    setIsCompleting(true);
    try {
      const res = await window.api.invoke(IPC.DB_NODE_COMPLETE, nid) as {
        success: boolean;
        data?: { updatedNodes: DagNode[] };
        error?: string;
      };
      if (res.success && res.data) {
        const updated = res.data.updatedNodes.find((n) => n.id === nid);
        if (updated) setNode(updated);
        updateDagNodeStatus(res.data.updatedNodes);
        useCourseStore.getState().loadCourses().catch(() => {/* ignore */});
      }
    } catch {
      // ignore
    } finally {
      setIsCompleting(false);
      setShowCompleteModal(false);
    }
  }, []);

  // ── Sync header action with node status ───────────────────────────────────────

  useEffect(() => {
    if (!node) return;
    if (node.status !== 'done') {
      useAppStore.getState().setHeaderAction({
        label: t('node_page.complete_node'),
        icon: <FlagTriangleRight size={12} />,
        onClick: () => setShowCompleteModal(true),
      });
    } else {
      useAppStore.getState().setHeaderAction(null);
    }
  }, [node]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', animation: 'pageFadeIn 150ms ease' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Allotment defaultSizes={[180, 400, 320]}>
          <Allotment.Pane minSize={150} maxSize={320}>
            <FileExplorer
              courseId={courseId ?? ''}
              nodeId={nodeId ?? ''}
              nodeName={node?.name ?? '节点'}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={280}>
            <EditorArea />
          </Allotment.Pane>
          <Allotment.Pane minSize={280}>
            <ChatPanel
              title={t('node_page.chat_title')}
              subtitle={t('node_page.chat_subtitle')}
              presets={subTutorPresets}
              emptyText={<span style={{ whiteSpace: 'pre-line' }}>{t('node_page.chat_empty')}</span>}
              messages={messages.sub_tutor}
              streamingContent={streamingContent}
              progressContent={progressContent}
              isStreaming={isStreaming}
              streamError={streamError}
              onSend={(msg, atts, wsEnabled) => handleChat(msg, atts, wsEnabled)}
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

      {/* Complete node modal */}
      {showCompleteModal && (
        <CompleteModal
          isCompleting={isCompleting}
          onCancel={() => setShowCompleteModal(false)}
          onConfirm={handleCompleteNode}
        />
      )}
    </div>
  );
};

export default NodePage;
