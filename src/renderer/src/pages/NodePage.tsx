import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Allotment, type AllotmentHandle } from 'allotment';
import 'allotment/dist/style.css';
import { FlagTriangleRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import { normalizeLocale } from '@shared/i18n';
import type {
  DagNode,
  ChatMessage,
  ChatMessageEditPayload,
  ChatThread,
  FileGeneratedPayload,
  IpcResponse,
  ActiveNodeFileContext,
} from '@shared/types';
import { useAppStore } from '../stores/app.store';
import { useChatStore } from '../stores/chat.store';
import { useCourseStore } from '../stores/course.store';
import { useEditorStore } from '../stores/editor.store';
import { FileExplorer } from '../components/workspace/FileExplorer';
import { EditorArea } from '../components/workspace/EditorArea';
import { ChatPanel } from '../components/chat/ChatPanel';
import type { ChatPanelPreset } from '../components/chat/ChatPanel';
import { sanitizeAttachmentsForMessage } from '../components/chat/useChatAttachments';
import { useDAGStore } from '../stores/dag.store';
import { useAgentChatRun } from '../hooks/useAgentChatRun';
import {
  animateSplitResize,
  readLayoutBool,
  readLayoutSizes,
  writeLayoutBool,
  writeLayoutSizes,
} from '../utils/split-layout';

// ── Presets ────────────────────────────────────────────────────────────────────
// Built inside component to support i18n

// ── DAG store helper ──────────────────────────────────────────────────────────

function updateDagNodeStatus(updatedNodes: DagNode[]) {
  const dagStore = useDAGStore.getState();
  for (const n of updatedNodes) {
    dagStore.updateNode(n.id, { status: n.status });
  }
}

const ACTIVE_FILE_PREVIEW_CHARS = 2400;
const ACTIVE_FILE_TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml']);
const NODE_EXPLORER_VISIBILITY_KEY = 'ulyzer:layout:node-explorer-visible';
const NODE_CHAT_VISIBILITY_KEY = 'ulyzer:layout:node-chat-visible';
const NODE_SPLIT_SIZES_KEY = 'ulyzer:layout:node-split-sizes';
const NODE_SPLIT_DEFAULT_SIZES = [180, 400, 320];
const SIDE_PANEL_EXIT_MS = 170;

const collapseNodeSplitSizes = (sizes: number[], showExplorer: boolean, showChat: boolean) => {
  const next = [...sizes];
  if (!showExplorer) {
    next[1] += next[0];
    next[0] = 0;
  }
  if (!showChat) {
    next[1] += next[2];
    next[2] = 0;
  }
  return next;
};

function normalizeFsPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function extOf(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx >= 0 ? filePath.slice(idx).toLowerCase() : '';
}

function buildActiveNodeFileContext(): ActiveNodeFileContext | undefined {
  const editor = useEditorStore.getState();
  const activeFile = editor.openedFiles.find((file) => file.id === editor.activeFileId);
  if (!activeFile) return undefined;

  const rootPath = editor.tree?.path ? normalizeFsPath(editor.tree.path) : '';
  const filePath = normalizeFsPath(activeFile.path);
  const relativePath = rootPath && (filePath === rootPath || filePath.startsWith(`${rootPath}/`))
    ? filePath.slice(rootPath.length).replace(/^\/+/, '')
    : undefined;
  const ext = extOf(activeFile.path);
  const isMarkdown = ext === '.md' || ext === '.markdown';
  const isText = ACTIVE_FILE_TEXT_EXTS.has(ext);
  const previewSource = isText ? activeFile.content : '';
  const contentPreview = previewSource
    ? previewSource.slice(0, ACTIVE_FILE_PREVIEW_CHARS) + (previewSource.length > ACTIVE_FILE_PREVIEW_CHARS ? '\n…' : '')
    : undefined;

  return {
    path: activeFile.path,
    relativePath: relativePath || undefined,
    name: activeFile.name,
    isMarkdown,
    contentPreview,
  };
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
  <div className="ui-animated-backdrop" style={{
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  }}>
    <div className="ui-animated-modal" style={{
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
          { icon: '🗺️', label: t('node_page.complete_step_outline') },
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
          <li><strong>{t('node_page.complete_step_outline')}</strong>：{t('node_page.complete_outline_detail')}</li>
          <li><strong>{t('node_page.complete_step_theory')}</strong>：{t('node_page.complete_theory_detail')}</li>
          <li><strong>{t('node_page.complete_step_practice')}</strong>：{t('node_page.complete_practice_detail')}</li>
          <li><strong>{t('node_page.complete_step_review')}</strong>：{t('node_page.complete_review_detail')}</li>
        </ul>
        <div style={{
          marginTop: 14, padding: '10px 12px', borderRadius: 8,
          background: 'var(--app-workspace-accent-bg, var(--accent-s))',
          border: '1px solid var(--accent-b)', color: 'var(--text)',
          display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.7,
        }}>
          <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
          <span>{t('node_page.complete_personalize')}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button
          className="ui-pressable"
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
          className="ui-pressable"
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
  const setTopbarLeftAction = useAppStore((s) => s.setTopbarLeftAction);
  const setTopbarRightAction = useAppStore((s) => s.setTopbarRightAction);
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
  const openedFiles      = useEditorStore((s) => s.openedFiles);
  const activeFileId     = useEditorStore((s) => s.activeFileId);
  const editorTreePath   = useEditorStore((s) => s.tree?.path ?? '');
  const activeFileContext = useMemo(
    () => buildActiveNodeFileContext(),
    [openedFiles, activeFileId, editorTreePath],
  );

  const [node, setNode] = useState<DagNode | null>(null);

  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(() => readLayoutBool(NODE_EXPLORER_VISIBILITY_KEY, true));
  const [chatVisible, setChatVisible] = useState(() => readLayoutBool(NODE_CHAT_VISIBILITY_KEY, true));
  const nodeSplitDefaultSizesRef = useRef(readLayoutSizes(NODE_SPLIT_SIZES_KEY, NODE_SPLIT_DEFAULT_SIZES, 3));
  const nodeSplitRef = useRef<AllotmentHandle>(null);
  const nodeSplitSizesRef = useRef(
    collapseNodeSplitSizes(nodeSplitDefaultSizesRef.current, explorerVisible, chatVisible),
  );
  const stableNodeSplitSizesRef = useRef(nodeSplitDefaultSizesRef.current);
  const cancelNodeSplitAnimationRef = useRef<(() => void) | null>(null);
  const [explorerPaneVisible, setExplorerPaneVisible] = useState(explorerVisible);
  const [explorerPaneClosing, setExplorerPaneClosing] = useState(false);
  const [explorerPaneTransitioning, setExplorerPaneTransitioning] = useState(false);
  const [chatPaneVisible, setChatPaneVisible] = useState(chatVisible);
  const [chatPaneClosing, setChatPaneClosing] = useState(false);
  const [chatPaneTransitioning, setChatPaneTransitioning] = useState(false);

  const subTutorPresets: ChatPanelPreset[] = [
    { label: t('node_page.preset_gen_outline'),  prefix: t('node_page.preset_gen_outline_prefix'),  description: t('node_page.preset_gen_outline_desc'),  group: t('node_page.preset_group_core') },
    { label: t('node_page.preset_gen_topic'),    prefix: t('node_page.preset_gen_topic_prefix'),    description: t('node_page.preset_gen_topic_desc'),    group: t('node_page.preset_group_core') },
    { label: t('node_page.preset_gen_theory'),   prefix: t('node_page.preset_gen_theory_prefix'),   description: t('node_page.preset_gen_theory_desc'),   group: t('node_page.preset_group_core') },
    { label: t('node_page.preset_gen_practice'), prefix: t('node_page.preset_gen_practice_prefix'), description: t('node_page.preset_gen_practice_desc'), group: t('node_page.preset_group_core') },
    { label: t('node_page.preset_gen_review'),   prefix: t('node_page.preset_gen_review_prefix'),   description: t('node_page.preset_gen_review_desc'),   group: t('node_page.preset_group_core') },
    { label: t('node_page.preset_external_reference_index'), prefix: t('node_page.preset_external_reference_index_prefix'), description: t('node_page.preset_external_reference_index_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_concept_cards'), prefix: t('node_page.preset_artifact_concept_cards_prefix'), description: t('node_page.preset_artifact_concept_cards_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_case_study'), prefix: t('node_page.preset_artifact_case_study_prefix'), description: t('node_page.preset_artifact_case_study_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_examples'), prefix: t('node_page.preset_artifact_examples_prefix'), description: t('node_page.preset_artifact_examples_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_decision_tree'), prefix: t('node_page.preset_artifact_decision_tree_prefix'), description: t('node_page.preset_artifact_decision_tree_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_derivation'), prefix: t('node_page.preset_artifact_derivation_prefix'), description: t('node_page.preset_artifact_derivation_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_checklist'), prefix: t('node_page.preset_artifact_checklist_prefix'), description: t('node_page.preset_artifact_checklist_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_code_lab'), prefix: t('node_page.preset_artifact_code_lab_prefix'), description: t('node_page.preset_artifact_code_lab_desc'), group: t('node_page.preset_group_artifacts') },
    { label: t('node_page.preset_artifact_csv_table'), prefix: t('node_page.preset_artifact_csv_table_prefix'), description: t('node_page.preset_artifact_csv_table_desc'), group: t('node_page.preset_group_artifacts') },
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
	      useAppStore.getState().setTopbarLeftAction(null);
	      useAppStore.getState().setTopbarRightAction(null);
	      useEditorStore.getState().clearAll();
	    };
	  }, [setBreadcrumbs]);

  const persistNodeSplitSizes = useCallback((sizes: number[], showExplorer: boolean, showChat: boolean) => {
    if (sizes.length !== 3 || (!showExplorer && !showChat)) return;

    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (!Number.isFinite(total) || total <= 0) return;

    const previous = stableNodeSplitSizesRef.current;
    const explorerSize = showExplorer && sizes[0] > 1 ? sizes[0] : previous[0];
    const chatSize = showChat && sizes[2] > 1 ? sizes[2] : previous[2];
    const editorSize = Math.max(0, total - explorerSize - chatSize);
    const nextSizes = [explorerSize, editorSize, chatSize];

    stableNodeSplitSizesRef.current = nextSizes;
    writeLayoutSizes(NODE_SPLIT_SIZES_KEY, nextSizes);
  }, []);

  const handleNodeSplitChange = useCallback((sizes: number[]) => {
    nodeSplitSizesRef.current = sizes;
  }, []);

  const handleNodeSplitDragEnd = useCallback((sizes: number[]) => {
    persistNodeSplitSizes(sizes, explorerVisible, chatVisible);
  }, [chatVisible, explorerVisible, persistNodeSplitSizes]);

  const toggleExplorerPane = useCallback(() => {
    cancelNodeSplitAnimationRef.current?.();
    cancelNodeSplitAnimationRef.current = null;

    if (explorerVisible) {
      const currentSizes = nodeSplitSizesRef.current[0] > 1
        ? nodeSplitSizesRef.current
        : stableNodeSplitSizesRef.current;
      persistNodeSplitSizes(currentSizes, true, chatVisible);
      const collapsedSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, false, chatVisible);
      setExplorerVisible(false);
      writeLayoutBool(NODE_EXPLORER_VISIBILITY_KEY, false);
      setExplorerPaneClosing(true);
      setExplorerPaneTransitioning(true);
      cancelNodeSplitAnimationRef.current = animateSplitResize(
        nodeSplitRef,
        currentSizes,
        collapsedSizes,
        SIDE_PANEL_EXIT_MS,
        (sizes) => { nodeSplitSizesRef.current = sizes; },
        () => {
          nodeSplitSizesRef.current = collapsedSizes;
          setExplorerPaneVisible(false);
          setExplorerPaneClosing(false);
          setExplorerPaneTransitioning(false);
          cancelNodeSplitAnimationRef.current = null;
        },
      );
      return;
    }

    const targetSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, true, chatVisible);
    const startSizes = nodeSplitSizesRef.current[0] <= 1
      ? nodeSplitSizesRef.current
      : collapseNodeSplitSizes(stableNodeSplitSizesRef.current, false, chatVisible);
    setExplorerPaneVisible(true);
    setExplorerPaneClosing(false);
    setExplorerPaneTransitioning(true);
    setExplorerVisible(true);
    writeLayoutBool(NODE_EXPLORER_VISIBILITY_KEY, true);
    cancelNodeSplitAnimationRef.current = animateSplitResize(
      nodeSplitRef,
      startSizes,
      targetSizes,
      SIDE_PANEL_EXIT_MS,
      (sizes) => { nodeSplitSizesRef.current = sizes; },
      () => {
        nodeSplitSizesRef.current = targetSizes;
        setExplorerPaneTransitioning(false);
        cancelNodeSplitAnimationRef.current = null;
      },
    );
  }, [chatVisible, explorerVisible, persistNodeSplitSizes]);

  const toggleChatPane = useCallback(() => {
    cancelNodeSplitAnimationRef.current?.();
    cancelNodeSplitAnimationRef.current = null;

    if (chatVisible) {
      const currentSizes = nodeSplitSizesRef.current[2] > 1
        ? nodeSplitSizesRef.current
        : stableNodeSplitSizesRef.current;
      persistNodeSplitSizes(currentSizes, explorerVisible, true);
      const collapsedSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, explorerVisible, false);
      setChatVisible(false);
      writeLayoutBool(NODE_CHAT_VISIBILITY_KEY, false);
      setChatPaneClosing(true);
      setChatPaneTransitioning(true);
      cancelNodeSplitAnimationRef.current = animateSplitResize(
        nodeSplitRef,
        currentSizes,
        collapsedSizes,
        SIDE_PANEL_EXIT_MS,
        (sizes) => { nodeSplitSizesRef.current = sizes; },
        () => {
          nodeSplitSizesRef.current = collapsedSizes;
          setChatPaneVisible(false);
          setChatPaneClosing(false);
          setChatPaneTransitioning(false);
          cancelNodeSplitAnimationRef.current = null;
        },
      );
      return;
    }

    const targetSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, explorerVisible, true);
    const startSizes = nodeSplitSizesRef.current[2] <= 1
      ? nodeSplitSizesRef.current
      : collapseNodeSplitSizes(stableNodeSplitSizesRef.current, explorerVisible, false);
    setChatPaneVisible(true);
    setChatPaneClosing(false);
    setChatPaneTransitioning(true);
    setChatVisible(true);
    writeLayoutBool(NODE_CHAT_VISIBILITY_KEY, true);
    cancelNodeSplitAnimationRef.current = animateSplitResize(
      nodeSplitRef,
      startSizes,
      targetSizes,
      SIDE_PANEL_EXIT_MS,
      (sizes) => { nodeSplitSizesRef.current = sizes; },
      () => {
        nodeSplitSizesRef.current = targetSizes;
        setChatPaneTransitioning(false);
        cancelNodeSplitAnimationRef.current = null;
      },
    );
  }, [chatVisible, explorerVisible, persistNodeSplitSizes]);

  useEffect(() => {
    if (!explorerPaneVisible && !explorerVisible) {
      const collapsedSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, false, chatVisible);
      nodeSplitSizesRef.current = collapsedSizes;
      window.requestAnimationFrame(() => nodeSplitRef.current?.resize(collapsedSizes));
    }
  }, [chatVisible, explorerPaneVisible, explorerVisible]);

  useEffect(() => {
    if (!chatPaneVisible && !chatVisible) {
      const collapsedSizes = collapseNodeSplitSizes(stableNodeSplitSizesRef.current, explorerVisible, false);
      nodeSplitSizesRef.current = collapsedSizes;
      window.requestAnimationFrame(() => nodeSplitRef.current?.resize(collapsedSizes));
    }
  }, [chatPaneVisible, chatVisible, explorerVisible]);

  useEffect(() => {
    setTopbarLeftAction({
      label: explorerVisible ? t('layout.hide_resources_panel') : t('layout.show_resources_panel'),
      icon: explorerVisible ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />,
      onClick: toggleExplorerPane,
    });
    return () => setTopbarLeftAction(null);
  }, [explorerVisible, setTopbarLeftAction, t, toggleExplorerPane]);

  useEffect(() => {
    setTopbarRightAction({
      label: chatVisible ? t('layout.hide_ai_panel') : t('layout.show_ai_panel'),
      icon: chatVisible ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />,
      onClick: toggleChatPane,
    });
    return () => setTopbarRightAction(null);
  }, [chatVisible, setTopbarRightAction, t, toggleChatPane]);

  useEffect(() => () => {
    cancelNodeSplitAnimationRef.current?.();
  }, []);

  // ── Load node + files + history ───────────────────────────────────────────────

  useEffect(() => {
    setNode(null);
    useChatStore.getState().clearMessages('sub_tutor');
    useChatStore.getState().setThreads('sub_tutor', []);
    useChatStore.getState().setActiveThreadId('sub_tutor', null);
    if (!nodeId || !courseId) return;

    let cancelled = false;

    window.api.invoke(IPC.DB_NODE_GET, nodeId)
      .then((res: unknown) => {
        if (cancelled || useAppStore.getState().currentNodeId !== nodeId || useAppStore.getState().currentCourseId !== courseId) return;
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

    window.api.invoke(IPC.FS_ENSURE_NODE, courseId, nodeId, normalizeLocale(i18n.language)).catch(() => {/* ignore */});
    useEditorStore.getState().loadTree(courseId, nodeId).catch(() => {/* ignore */});

    window.api
      .invoke(IPC.DB_THREAD_LIST, courseId, 'sub_tutor', nodeId)
      .then(async (res: unknown) => {
        if (cancelled || useAppStore.getState().currentNodeId !== nodeId || useAppStore.getState().currentCourseId !== courseId) return;
        const r = res as { success: boolean; data?: ChatThread[] };
        const threads = r.success && r.data ? r.data : [];

        let activeThread: ChatThread;
        if (threads.length > 0) {
          activeThread = threads[0];
          useChatStore.getState().setThreads('sub_tutor', threads);
        } else {
          const createRes = await window.api.invoke(IPC.DB_THREAD_CREATE, {
            courseId, agent: 'sub_tutor', nodeId, title: t('common.new_chat'),
          });
          const cr = createRes as { success: boolean; data?: ChatThread };
          if (!cr.success || !cr.data) return;
          if (cancelled || useAppStore.getState().currentNodeId !== nodeId || useAppStore.getState().currentCourseId !== courseId) return;
          activeThread = cr.data;
          useChatStore.getState().setThreads('sub_tutor', [activeThread]);
        }

        useChatStore.getState().setActiveThreadId('sub_tutor', activeThread.id);

        const msgRes = await window.api.invoke(IPC.DB_MESSAGES_GET, courseId, 'sub_tutor', nodeId, activeThread.id);
        if (cancelled || useAppStore.getState().currentNodeId !== nodeId || useAppStore.getState().currentCourseId !== courseId) return;
        const mr = msgRes as { success: boolean; data?: ChatMessage[] };
        if (mr.success && mr.data) {
          const store = useChatStore.getState();
          for (const msg of mr.data) store.addMessage('sub_tutor', msg);
        }
      })
      .catch(() => {/* ignore */});
    return () => { cancelled = true; };
  }, [nodeId, courseId, setBreadcrumbs, t]);

  // ── Chat run harness ─────────────────────────────────────────────────────────

  const { handleChat, handleAbort, handleResendHistory } = useAgentChatRun({
    agentType: 'sub_tutor',
    getCourseId: () => useAppStore.getState().currentCourseId,
    getNodeId: () => useAppStore.getState().currentNodeId,
    getActiveFile: () => buildActiveNodeFileContext(),
    onEmptyAssistantEnd: () => {
      const cid = useAppStore.getState().currentCourseId;
      const nid = useAppStore.getState().currentNodeId;
      if (cid && nid) useEditorStore.getState().loadTree(cid, nid).catch(() => {});
    },
    onFileGenerated: ({ filePath, nodeId: generatedNodeId }: FileGeneratedPayload) => {
      const cid = useAppStore.getState().currentCourseId;
      if (cid && generatedNodeId) {
        useEditorStore.getState().loadTree(cid, generatedNodeId).then(() => {
          useEditorStore.getState().refreshFileFromDisk(
            filePath,
            filePath.split(/[/\\]/).pop() ?? 'file.md',
          ).catch(() => {/* ignore */});
        }).catch(() => {/* ignore */});
      }
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const handleEditAndResend = useCallback(async (id: string, payload: ChatMessageEditPayload) => {
    if (useChatStore.getState().isStreaming || editBusy) return;
    const { content } = payload;
    const nextAttachments = sanitizeAttachmentsForMessage(payload.attachments ?? []);
    const msgs = useChatStore.getState().messages.sub_tutor;
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

      useChatStore.getState().updateMessage('sub_tutor', id, content, nextAttachments);
      useChatStore.getState().truncateAfterMessage('sub_tutor', id);
      shouldResend = true;
    } catch (err) {
      useChatStore.getState().setStreamError('sub_tutor', err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }

    if (shouldResend) void handleResendHistory(nextAttachments);
  }, [editBusy, handleResendHistory]);

  // ── Thread management ─────────────────────────────────────────────────────────

  const handleNewThread = useCallback(async () => {
    const cid = useAppStore.getState().currentCourseId;
    const nid = useAppStore.getState().currentNodeId;
    if (!cid || useChatStore.getState().isStreaming) return;
    const res = await window.api.invoke(IPC.DB_THREAD_CREATE, { courseId: cid, agent: 'sub_tutor', nodeId: nid ?? undefined, title: t('common.new_chat') });
    const r = res as { success: boolean; data?: ChatThread };
    if (!r.success || !r.data) return;
    useChatStore.getState().addThread('sub_tutor', r.data);
    useChatStore.getState().setActiveThreadId('sub_tutor', r.data.id);
    useChatStore.getState().clearMessages('sub_tutor');
  }, [t]);

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
    <div className="ui-page-enter ui-workspace-page-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
	        <Allotment
	          ref={nodeSplitRef}
	          className={`node-delivery-split ${explorerPaneVisible ? '' : 'node-explorer-hidden'} ${chatPaneVisible ? '' : 'node-chat-hidden'}`}
	          defaultSizes={nodeSplitDefaultSizesRef.current}
	          onChange={handleNodeSplitChange}
	          onDragEnd={handleNodeSplitDragEnd}
        >
          <Allotment.Pane
            minSize={explorerPaneTransitioning || !explorerPaneVisible ? 0 : 150}
            maxSize={320}
            visible={explorerPaneVisible}
          >
            <div
              style={{
                height: '100%',
                animation: explorerPaneClosing
                  ? 'sidebarSlideLeftOut 170ms cubic-bezier(0.4, 0, 1, 1) both'
                  : 'sidebarSlideLeftIn 190ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
              }}
            >
              <FileExplorer
                courseId={courseId ?? ''}
                nodeId={nodeId ?? ''}
                nodeName={node?.name ?? t('node_page.node_fallback')}
              />
            </div>
          </Allotment.Pane>
          <Allotment.Pane minSize={280}>
            <EditorArea />
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
	                agentType="sub_tutor"
	                courseId={courseId ?? ''}
	                nodeId={nodeId ?? undefined}
	                title={t('node_page.chat_title')}
	                subtitle={t('node_page.chat_subtitle')}
	                presets={subTutorPresets}
	                emptyText={<span style={{ whiteSpace: 'pre-line' }}>{t('node_page.chat_empty')}</span>}
	                messages={messages.sub_tutor}
	                streamingContent={streamingContent}
	                progressContent={progressContent}
	                isStreaming={isStreaming}
	                streamError={streamError}
	                activeFileContext={activeFileContext}
	                onSend={(msg, atts, searchMode, thinkingMode) => handleChat(msg, atts, searchMode, thinkingMode)}
	                onAbort={handleAbort}
	                onEditAndResendMessage={handleEditAndResend}
	                editBusy={editBusy}
	                onOpenArtifact={(artifact) => {
	                  const name = artifact.filePath.split(/[/\\]/).pop() ?? 'file.md';
	                  useEditorStore.getState().openFile(artifact.filePath, name).catch(() => {/* ignore */});
	                }}
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
