import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Allotment, type AllotmentHandle } from 'allotment';
import 'allotment/dist/style.css';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import type {
  ChatMessage,
  ChatMessageEditPayload,
  ChatThread,
  IpcResponse,
} from '@shared/types';
import { useAppStore } from '../stores/app.store';
import { useDAGStore } from '../stores/dag.store';
import { useChatStore } from '../stores/chat.store';
import { useCourseStore } from '../stores/course.store';
import { DAGCanvas } from '../components/dag/DAGCanvas';
import { ChatPanel } from '../components/chat/ChatPanel';
import type { ChatPanelPreset } from '../components/chat/ChatPanel';
import { sanitizeAttachmentsForMessage } from '../components/chat/useChatAttachments';
import { useAgentChatRun, type DagGeneratedPayload } from '../hooks/useAgentChatRun';
import {
  animateSplitResize,
  readLayoutBool,
  readLayoutSizes,
  writeLayoutBool,
  writeLayoutSizes,
} from '../utils/split-layout';

// ── Preset commands ────────────────────────────────────────────────────────────
// Defined inside the component so they can use the t() function

// ── DAGPage ────────────────────────────────────────────────────────────────────

const DAG_CHAT_VISIBILITY_KEY = 'ulyzer:layout:dag-chat-visible';
const DAG_CHAT_SIZES_KEY = 'ulyzer:layout:dag-chat-sizes';
const DAG_CHAT_DEFAULT_SIZES = [60, 40];
const SIDE_PANEL_EXIT_MS = 170;

const collapseDagChatSizes = (sizes: number[]) => [sizes[0] + sizes[1], 0];

const DAGPage: React.FC = () => {
  const { t } = useTranslation();
  const setBreadcrumbs = useAppStore((s) => s.setBreadcrumbs);
  const setTopbarRightAction = useAppStore((s) => s.setTopbarRightAction);
  const courseId       = useAppStore((s) => s.currentCourseId);
  const courseName     = useCourseStore((s) => s.courses.find((c) => c.id === courseId)?.name ?? t('dag_page.breadcrumb_courses'));

  const isStreaming      = useChatStore((s) => s.isStreaming);
  const messages         = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const progressContent  = useChatStore((s) => s.progressContent);
  const streamError      = useChatStore((s) => s.streamError.main_tutor);
  const threads          = useChatStore((s) => s.threads.main_tutor);
  const activeThreadId   = useChatStore((s) => s.activeThreadId.main_tutor);
  const [editBusy, setEditBusy] = useState(false);
  const [chatVisible, setChatVisible] = useState(() => readLayoutBool(DAG_CHAT_VISIBILITY_KEY, true));
  const dagSplitDefaultSizesRef = useRef(readLayoutSizes(DAG_CHAT_SIZES_KEY, DAG_CHAT_DEFAULT_SIZES, 2));
  const dagSplitRef = useRef<AllotmentHandle>(null);
  const dagSplitSizesRef = useRef(
    chatVisible ? dagSplitDefaultSizesRef.current : collapseDagChatSizes(dagSplitDefaultSizesRef.current),
  );
  const stableDagSplitSizesRef = useRef(dagSplitDefaultSizesRef.current);
  const cancelDagSplitAnimationRef = useRef<(() => void) | null>(null);
  const [chatPaneVisible, setChatPaneVisible] = useState(chatVisible);
  const [chatPaneClosing, setChatPaneClosing] = useState(false);
  const [chatPaneTransitioning, setChatPaneTransitioning] = useState(false);

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

  const persistDagSplitSizes = useCallback((sizes: number[]) => {
    if (sizes.length !== 2 || sizes[1] < 40) return;
    stableDagSplitSizesRef.current = sizes;
    writeLayoutSizes(DAG_CHAT_SIZES_KEY, sizes);
  }, []);

  const handleDagSplitChange = useCallback((sizes: number[]) => {
    dagSplitSizesRef.current = sizes;
  }, []);

  const handleDagSplitDragEnd = useCallback((sizes: number[]) => {
    if (chatVisible) persistDagSplitSizes(sizes);
  }, [chatVisible, persistDagSplitSizes]);

  const toggleChatPane = useCallback(() => {
    cancelDagSplitAnimationRef.current?.();
    cancelDagSplitAnimationRef.current = null;

    if (chatVisible) {
      const currentSizes = dagSplitSizesRef.current[1] > 1
        ? dagSplitSizesRef.current
        : stableDagSplitSizesRef.current;
      const collapsedSizes = collapseDagChatSizes(currentSizes);
      persistDagSplitSizes(currentSizes);
      setChatVisible(false);
      writeLayoutBool(DAG_CHAT_VISIBILITY_KEY, false);
      setChatPaneClosing(true);
      setChatPaneTransitioning(true);
      cancelDagSplitAnimationRef.current = animateSplitResize(
        dagSplitRef,
        currentSizes,
        collapsedSizes,
        SIDE_PANEL_EXIT_MS,
        (sizes) => { dagSplitSizesRef.current = sizes; },
        () => {
          dagSplitSizesRef.current = collapsedSizes;
          setChatPaneVisible(false);
          setChatPaneClosing(false);
          setChatPaneTransitioning(false);
          cancelDagSplitAnimationRef.current = null;
        },
      );
      return;
    }

    const targetSizes = stableDagSplitSizesRef.current;
    const startSizes = dagSplitSizesRef.current[1] <= 1
      ? dagSplitSizesRef.current
      : collapseDagChatSizes(targetSizes);
    setChatPaneVisible(true);
    setChatPaneClosing(false);
    setChatPaneTransitioning(true);
    setChatVisible(true);
    writeLayoutBool(DAG_CHAT_VISIBILITY_KEY, true);
    cancelDagSplitAnimationRef.current = animateSplitResize(
      dagSplitRef,
      startSizes,
      targetSizes,
      SIDE_PANEL_EXIT_MS,
      (sizes) => { dagSplitSizesRef.current = sizes; },
      () => {
        dagSplitSizesRef.current = targetSizes;
        setChatPaneTransitioning(false);
        writeLayoutSizes(DAG_CHAT_SIZES_KEY, targetSizes);
        cancelDagSplitAnimationRef.current = null;
      },
    );
  }, [chatVisible, persistDagSplitSizes]);

  useEffect(() => {
    if (!chatPaneVisible && !chatVisible) {
      const collapsedSizes = collapseDagChatSizes(stableDagSplitSizesRef.current);
      dagSplitSizesRef.current = collapsedSizes;
      window.requestAnimationFrame(() => dagSplitRef.current?.resize(collapsedSizes));
    }
  }, [chatPaneVisible, chatVisible]);

  useEffect(() => () => {
    cancelDagSplitAnimationRef.current?.();
  }, []);

  useEffect(() => {
    setTopbarRightAction({
      label: chatVisible ? t('layout.hide_ai_panel') : t('layout.show_ai_panel'),
      icon: chatVisible ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />,
      onClick: toggleChatPane,
    });
    return () => setTopbarRightAction(null);
  }, [chatVisible, setTopbarRightAction, t, toggleChatPane]);

  // ── Ensure clean page-specific state on mount ───────────────────────────────

  useEffect(() => {
    useDAGStore.getState().setGenerating(false);
  }, []);

  // ── Load DAG and thread/message history ─────────────────────────────────────

  useEffect(() => {
    useChatStore.getState().clearMessages('main_tutor');
    useChatStore.getState().setThreads('main_tutor', []);
    useChatStore.getState().setActiveThreadId('main_tutor', null);
    if (!courseId) return;

    let cancelled = false;

    useDAGStore.getState().loadDAG(courseId);

    window.api
      .invoke(IPC.DB_THREAD_LIST, courseId, 'main_tutor')
      .then(async (res: unknown) => {
        if (cancelled || useAppStore.getState().currentCourseId !== courseId) return;
        const r = res as { success: boolean; data?: ChatThread[] };
        const threads = r.success && r.data ? r.data : [];

        let activeThread: ChatThread;
        if (threads.length > 0) {
          activeThread = threads[0];
          useChatStore.getState().setThreads('main_tutor', threads);
        } else {
          // No threads yet — create one
          const createRes = await window.api.invoke(IPC.DB_THREAD_CREATE, {
            courseId, agent: 'main_tutor', title: t('common.new_chat'),
          });
          const cr = createRes as { success: boolean; data?: ChatThread };
          if (!cr.success || !cr.data) return;
          if (cancelled || useAppStore.getState().currentCourseId !== courseId) return;
          activeThread = cr.data;
          useChatStore.getState().setThreads('main_tutor', [activeThread]);
        }

        useChatStore.getState().setActiveThreadId('main_tutor', activeThread.id);

        // Load messages for active thread
        const msgRes = await window.api.invoke(IPC.DB_MESSAGES_GET, courseId, 'main_tutor', undefined, activeThread.id);
        if (cancelled || useAppStore.getState().currentCourseId !== courseId) return;
        const mr = msgRes as { success: boolean; data?: ChatMessage[] };
        if (mr.success && mr.data) {
          const store = useChatStore.getState();
          for (const msg of mr.data) store.addMessage('main_tutor', msg);
        }
      })
      .catch(() => {/* ignore */});
    return () => { cancelled = true; };
  }, [courseId, t]);

  // ── Chat run harness ─────────────────────────────────────────────────────────

  const { handleChat, handleResendHistory, handleAbort } = useAgentChatRun({
    agentType: 'main_tutor',
    getCourseId: () => useAppStore.getState().currentCourseId,
    onAbortRun: () => useDAGStore.getState().setGenerating(false),
    onStreamError: () => useDAGStore.getState().setGenerating(false),
    onDagGenerated: ({ nodes, edges, summary }: DagGeneratedPayload) => {
      useDAGStore.getState().setDAG(nodes, edges);
      useDAGStore.getState().setGenerating(false);
      useCourseStore.getState().loadCourses().catch(() => {/* ignore */});
      if (!summary) return false;

      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        timestamp: Date.now(),
        progress: useChatStore.getState().progressContent || undefined,
      };
      useChatStore.getState().addMessage('main_tutor', msg);
      useChatStore.getState().setStreaming(false, 'main_tutor');
      return true;
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleEditAndResend = useCallback(async (id: string, payload: ChatMessageEditPayload) => {
    if (useChatStore.getState().isStreaming || editBusy) return;
    const { content } = payload;
    const nextAttachments = sanitizeAttachmentsForMessage(payload.attachments ?? []);
    const msgs = useChatStore.getState().messages.main_tutor;
    const idx = msgs.findIndex((m) => m.id === id);
    if (idx === -1) return;

    setEditBusy(true);
    let shouldResend = false;
    try {
      const res = await window.api.invoke(IPC.DB_MESSAGE_EDIT_AND_TRUNCATE, {
        id,
        content,
        attachments: nextAttachments,
        truncateMessageIds: msgs.slice(idx + 1).map((msg) => msg.id),
      }) as IpcResponse<void>;
      if (!res.success) throw new Error(res.error ?? t('errors.edit_message_failed'));

      useChatStore.getState().updateMessage('main_tutor', id, content, nextAttachments);
      useChatStore.getState().truncateAfterMessage('main_tutor', id);
      shouldResend = true;
    } catch (err) {
      useChatStore.getState().setStreamError('main_tutor', err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }

    if (shouldResend) void handleResendHistory(nextAttachments);
  }, [editBusy, handleResendHistory]);

  const handleSave = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid) return;
    await useDAGStore.getState().saveDAG(cid);
  }, []);

  // ── Thread management ────────────────────────────────────────────────────────

  const handleNewThread = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    if (!cid || useChatStore.getState().isStreaming) return;
    const res = await window.api.invoke(IPC.DB_THREAD_CREATE, { courseId: cid, agent: 'main_tutor', title: t('common.new_chat') });
    const r = res as { success: boolean; data?: ChatThread };
    if (!r.success || !r.data) return;
    useChatStore.getState().addThread('main_tutor', r.data);
    useChatStore.getState().setActiveThreadId('main_tutor', r.data.id);
    useChatStore.getState().clearMessages('main_tutor');
  }, [t]);

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
    <div className="ui-page-enter ui-workspace-page-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {!courseId && (
        <div style={{
          padding: '8px 16px',
          backgroundColor: 'var(--amber-s)',
          borderBottom: '1px solid #fcd34d',
          fontSize: 12,
          color: 'var(--amber)',
          fontWeight: 500,
        }}>
          {t('dag_page.no_course_selected')}
        </div>
      )}
      <Allotment
        ref={dagSplitRef}
        className={`dag-page-split ${chatPaneVisible ? '' : 'dag-chat-hidden'}`}
        defaultSizes={dagSplitDefaultSizesRef.current}
        onChange={handleDagSplitChange}
        onDragEnd={handleDagSplitDragEnd}
      >
        <Allotment.Pane minSize={300}>
          <DAGCanvas
            key={courseId ?? ''}
            courseId={courseId ?? ''}
            onSave={handleSave}
          />
        </Allotment.Pane>

        <Allotment.Pane
          minSize={chatPaneTransitioning || !chatPaneVisible ? 0 : 280}
          visible={chatPaneVisible}
        >
          <div
            style={{
              height: '100%',
              animation: chatPaneClosing
                ? 'sidebarSlideOut 170ms cubic-bezier(0.4, 0, 1, 1) both'
                : 'sidebarSlideIn 190ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
            }}
          >
            <ChatPanel
              agentType="main_tutor"
              courseId={courseId ?? ''}
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
              editBusy={editBusy}
              threads={threads}
              activeThreadId={activeThreadId}
              onNewThread={handleNewThread}
              onSwitchThread={handleSwitchThread}
              onDeleteThread={handleDeleteThread}
            />
          </div>
        </Allotment.Pane>
      </Allotment>
    </div>
  );
};

export default DAGPage;
