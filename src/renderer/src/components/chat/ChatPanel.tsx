import React, { useEffect, useMemo, useState, useRef } from 'react';
import { SquarePen, Clock, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ActiveNodeFileContext, AgentContextStatus, AgentType, ChatMessage, ChatMessageEditPayload, ChatThread, FileAttachment, IpcResponse, MessageArtifact, ModelCapabilityInfo, SearchMode, ThinkingMode } from '@shared/types';
import { IPC } from '@shared/ipc-channels';
import { normalizeLocale } from '@shared/i18n';
import { PresetCommands } from './PresetCommands';
import { ChatMessages } from './ChatMessages';
import { ChatInputBox } from './ChatInputBox';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { useSettingsStore } from '../../stores/settings.store';
import { useChatStore, type ChatDraftQuote } from '../../stores/chat.store';
import { RefLibraryModal } from './SourceLibraryModal';
import { selectedModelIsAvailable } from '../../utils/model-selection';

export interface ChatPanelPreset {
  label: string;
  /** Text inserted into the input box when preset is clicked, e.g. "/创建路线 " */
  prefix: string;
  warn?: boolean;
  description?: string;
  group?: string;
}

interface ChatPanelProps {
  title: string;
  subtitle?: string;
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  presets?: ChatPanelPreset[];
  messages: ChatMessage[];
  streamingContent: string;
  progressContent?: string;
  isStreaming: boolean;
  streamError?: string | null;
  /** Regular chat message */
  onSend: (message: string, attachments: FileAttachment[], searchMode: SearchMode, thinkingMode: ThinkingMode) => void;
  /** Stop the current stream */
  onAbort?: () => void;
  onEditAndResendMessage?: (id: string, payload: ChatMessageEditPayload) => void;
  editBusy?: boolean;
  emptyText?: React.ReactNode;
  activeFileContext?: ActiveNodeFileContext;
  /** Opens a generated-file artifact card in the workspace. */
  onOpenArtifact?: (artifact: MessageArtifact) => void;
  // ── Thread props ──────────────────────────────────────────────────────────────
  threads?: ChatThread[];
  activeThreadId?: string | null;
  onNewThread?: () => void;
  onSwitchThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  title,
  subtitle,
  agentType,
  courseId,
  nodeId,
  presets = [],
  messages,
  streamingContent,
  progressContent,
  isStreaming,
  streamError,
  onSend,
  onAbort,
  onEditAndResendMessage,
  editBusy = false,
  emptyText,
  activeFileContext,
  onOpenArtifact,
  threads = [],
  activeThreadId,
  onNewThread,
  onSwitchThread,
  onDeleteThread,
}) => {
  const { t, i18n } = useTranslation();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchMode = useChatStore((s) => s.searchMode[agentType]);
  const setSearchMode = useChatStore((s) => s.setSearchMode);
  const thinkingMode = useChatStore((s) => s.thinkingMode[agentType]);
  const setThinkingMode = useChatStore((s) => s.setThinkingMode);
  const draftQuote = useChatStore((s) => s.draftQuote[agentType]);
  const clearDraftQuote = useChatStore((s) => s.clearDraftQuote);
  const [webSearchError, setWebSearchError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const getApiKey = useSettingsStore((s) => s.getApiKey);
  const selectedProvider = useSettingsStore((s) => s.provider);
  const selectedModel = useSettingsStore((s) => s.model);
  const [attachmentCapability, setAttachmentCapability] = useState<ModelCapabilityInfo | null>(null);
  const [contextStatus, setContextStatus] = useState<{ key: string; status: AgentContextStatus } | null>(null);
  const webSearchErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextStatusKeyRef = useRef('');
  const contextStatusScopeKey = [
    selectedProvider ?? '',
    selectedModel ?? '',
    activeThreadId ?? '',
    agentType,
    courseId,
    nodeId ?? '',
    searchMode,
    thinkingMode,
    i18n.language,
    activeFileContext?.relativePath ?? activeFileContext?.path ?? '',
    draftQuote?.id ?? '',
  ].join('\u0000');
  const scopedContextStatus = contextStatus?.key === contextStatusScopeKey ? contextStatus.status : null;
  // During a run, drive the ring from the loop's real per-turn input tokens
  // (diagnostics `turn.usageIn`) over the known input budget — so it tracks the
  // live "grow → compact → grow" of a long task instead of staying frozen.
  const liveDiagnostics = useChatStore((s) => s.liveDiagnostics);
  const effectiveContextStatus = useMemo<AgentContextStatus | null>(() => {
    const base = scopedContextStatus;
    if (!isStreaming || !base || base.inputBudget <= 0) return base;
    let liveInput: number | undefined;
    for (let i = liveDiagnostics.length - 1; i >= 0; i--) {
      const rec = liveDiagnostics[i];
      if (rec.kind === 'turn' && typeof rec.usageIn === 'number' && rec.usageIn > 0) { liveInput = rec.usageIn; break; }
    }
    if (liveInput === undefined) return base;
    const percent = Math.max(0, Math.min(100, Number((liveInput / base.inputBudget * 100).toFixed(1))));
    return { percent, inputTokens: liveInput, inputBudget: base.inputBudget, contextWindow: base.contextWindow };
  }, [scopedContextStatus, isStreaming, liveDiagnostics]);
  const currentUserMessageWithQuote = composeMessageWithDraftQuote(inputText, draftQuote, t);

  useEffect(() => {
    if (!selectedProvider || !selectedModel) {
      setAttachmentCapability(null);
      return;
    }
    let cancelled = false;
    window.api
      .invoke(IPC.MODEL_CAPABILITY_GET, selectedProvider, selectedModel)
      .then((res) => {
        const response = res as IpcResponse<ModelCapabilityInfo>;
        if (!cancelled) setAttachmentCapability(response.success ? response.data ?? null : null);
      })
      .catch(() => { if (!cancelled) setAttachmentCapability(null); });
    return () => { cancelled = true; };
  }, [selectedProvider, selectedModel]);

  useEffect(() => {
    if (attachmentCapability && !attachmentCapability.supportsReasoning && thinkingMode !== 'off') {
      setThinkingMode(agentType, 'off');
    }
  }, [agentType, attachmentCapability, setThinkingMode, thinkingMode]);

  useEffect(() => {
    if (!selectedProvider || !selectedModel || !activeThreadId) {
      setContextStatus(null);
      contextStatusKeyRef.current = '';
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const targetChanged = contextStatusKeyRef.current !== contextStatusScopeKey;
    contextStatusKeyRef.current = contextStatusScopeKey;
    if (targetChanged) setContextStatus(null);

    const loadContextStatus = () => {
      window.api
        .invoke(IPC.AGENT_CONTEXT_STATUS, {
          agentType,
          courseId,
          nodeId,
          threadId: activeThreadId,
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            progress: message.progress,
          })),
          provider: selectedProvider,
          model: selectedModel,
          currentUserMessage: currentUserMessageWithQuote,
          searchMode,
          thinkingMode,
          language: normalizeLocale(i18n.language),
          activeFile: activeFileContext,
        })
        .then((res) => {
          const response = res as IpcResponse<AgentContextStatus>;
          if (!cancelled) {
            setContextStatus(response.success && response.data
              ? { key: contextStatusScopeKey, status: response.data }
              : null);
          }
        })
        .catch(() => { if (!cancelled) setContextStatus(null); });
    };

    if (targetChanged) loadContextStatus();
    else timer = setTimeout(loadContextStatus, 350);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeThreadId,
    activeFileContext,
    agentType,
    courseId,
    contextStatusScopeKey,
    currentUserMessageWithQuote,
    inputText,
    i18n.language,
    messages,
    nodeId,
    selectedModel,
    selectedProvider,
    searchMode,
    thinkingMode,
  ]);

  const showPanelError = (message: string) => {
    setWebSearchError(message);
    if (webSearchErrorTimerRef.current) clearTimeout(webSearchErrorTimerRef.current);
    webSearchErrorTimerRef.current = setTimeout(() => setWebSearchError(null), 6000);
  };

  const handleSearchModeChange = async (mode: SearchMode) => {
    if (mode === 'web') {
      const [tavilyKey, exaKey] = await Promise.all([getApiKey('tavily'), getApiKey('exa')]);
      if (!tavilyKey && !exaKey) {
        showPanelError(t('chat_panel.web_search_no_key'));
        return;
      }
    }
    setSearchMode(agentType, mode);
    setWebSearchError(null);
  };

  const handleThinkingModeChange = (mode: ThinkingMode) => {
    if (mode !== 'off' && attachmentCapability && !attachmentCapability.supportsReasoning) {
      showPanelError(t('chat_panel.thinking_not_supported'));
      return;
    }
    setThinkingMode(agentType, mode);
    setWebSearchError(null);
  };

  // Presets are only prompt starters; sending always goes through the normal chat path.
  const handlePresetClick = (prefix: string) => {
    setInputText(prefix);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  };

  useEffect(() => {
    if (!draftQuote) return;
    const timer = window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftQuote?.id]);

  const handleSend = (
    text: string,
    attachments: FileAttachment[],
    selectedSearchMode: SearchMode,
    selectedThinkingMode: ThinkingMode,
  ): boolean | void => {
    const settings = useSettingsStore.getState();
    if (!selectedModelIsAvailable(settings.provider, settings.model, settings.models, settings.providers)) {
      showPanelError(t('common.configure_model_first'));
      return false;
    }
    onSend(composeMessageWithDraftQuote(text, draftQuote, t), attachments, selectedSearchMode, selectedThinkingMode);
    if (draftQuote) clearDraftQuote(agentType);
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      backgroundColor: 'var(--app-workspace-bg, var(--bg))',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px', backgroundColor: 'var(--app-workspace-panel-bg, var(--panel))', flexShrink: 0,
        position: 'relative',
      }}>
        {/* Left: new chat button */}
        <HeaderIconButton onClick={onNewThread} title={t('chat_panel.new_chat')} disabled={!onNewThread}>
          <SquarePen size={14} />
        </HeaderIconButton>

        {/* Center: title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
          {subtitle && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {subtitle}</span>}
        </div>

        {/* Right: history button */}
        <HeaderIconButton
          onClick={() => setHistoryOpen((v) => !v)}
          title={t('chat_panel.chat_history')}
          active={historyOpen}
          disabled={!onSwitchThread}
        >
          <Clock size={14} />
        </HeaderIconButton>

        {/* History dropdown */}
        {historyOpen && onSwitchThread && (
          <ChatHistoryPanel
            threads={threads}
            activeThreadId={activeThreadId ?? null}
            onSelect={(id) => { onSwitchThread(id); }}
            onDelete={(id) => { onDeleteThread?.(id); }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {/* Messages */}
      <ChatMessages
        messages={messages}
        streamingContent={streamingContent}
        progressContent={progressContent}
        isStreaming={isStreaming}
        streamError={streamError ?? null}
        onEditAndResendMessage={onEditAndResendMessage}
        editContext={{
          agentType,
          courseId,
          nodeId,
          threadId: activeThreadId ?? null,
          attachmentCapability,
          disabled: isStreaming || editBusy,
        }}
        emptyText={emptyText}
        onOpenArtifact={onOpenArtifact}
      />

      {/* Input area */}
      <div style={{ padding: '8px 12px 12px', flexShrink: 0 }}>
        {editBusy && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 4px 6px',
            fontSize: 11,
            color: 'var(--text3)',
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: 'var(--accent)',
              display: 'inline-block',
              animation: 'uiSoftPulse 1.4s ease-in-out infinite',
            }} />
            {t('chat_panel.editing_history')}
          </div>
        )}
        <ChatInputBox
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onAbort={onAbort}
          agentType={agentType}
          courseId={courseId}
          nodeId={nodeId}
          threadId={activeThreadId ?? null}
          placeholder={t('chat_input.placeholder')}
          disabled={isStreaming}
          textareaRef={textareaRef}
          searchMode={searchMode}
          onSearchModeChange={handleSearchModeChange}
          thinkingMode={thinkingMode}
          onThinkingModeChange={handleThinkingModeChange}
          thinkingAvailable={attachmentCapability?.supportsReasoning ?? false}
          thinkingControl={attachmentCapability?.thinkingControl ?? 'none'}
          webSearchError={webSearchError}
          attachmentCapability={attachmentCapability}
          contextStatusVisible={Boolean(selectedProvider && selectedModel && activeThreadId)}
          contextStatus={effectiveContextStatus}
          draftQuote={draftQuote}
          onClearDraftQuote={() => clearDraftQuote(agentType)}
          headerSlot={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {presets.length > 0 && (
                <PresetCommands
                  commands={presets.map((p) => ({
                    label: p.label,
                    value: p.prefix,
                    warn: p.warn,
                    description: p.description,
                    group: p.group,
                  }))}
                  onSelect={handlePresetClick}
                  disabled={isStreaming}
                />
              )}
              <QuickActionButton
                onClick={() => setLibraryOpen(true)}
                disabled={isStreaming}
                label={agentType === 'main_tutor' ? t('chat_panel.course_library') : t('chat_panel.node_library')}
              >
                <BookOpen size={12} />
              </QuickActionButton>
            </div>
          }
        />
      </div>

      <RefLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        courseId={courseId}
        nodeId={nodeId}
        agentType={agentType}
      />
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const HeaderIconButton: React.FC<{
  onClick?: () => void; title?: string; disabled?: boolean; active?: boolean; children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    className="ui-pressable"
    onClick={onClick}
    title={title}
    disabled={disabled}
    style={{
      width: 28, height: 28, borderRadius: 'var(--r)',
      border: active ? '1px solid var(--accent-b)' : 'none',
      cursor: disabled ? 'default' : 'pointer',
      backgroundColor: active ? 'var(--accent-s)' : 'transparent',
      color: disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, transition: 'transform 0.12s ease, background-color 0.1s, color 0.1s',
    }}
    onMouseEnter={(e) => {
      if (!disabled) {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-b)' : 'var(--app-workspace-muted-bg, var(--surface2))';
        (e.currentTarget as HTMLButtonElement).style.color = active ? 'var(--accent)' : 'var(--text2)';
      }
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-s)' : 'transparent';
      (e.currentTarget as HTMLButtonElement).style.color = disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)';
    }}
  >
    {children}
  </button>
);

function composeMessageWithDraftQuote(text: string, quote: ChatDraftQuote | null, t: TFunction): string {
  const trimmed = text.trim();
  if (!quote) return trimmed;

  const source = quote.relativePath || quote.sourceName || quote.sourcePath;
  const range = quote.lineFrom
    ? quote.lineTo && quote.lineTo !== quote.lineFrom
      ? t('chat_panel.quote_line_range', { from: quote.lineFrom, to: quote.lineTo })
      : t('chat_panel.quote_line_single', { line: quote.lineFrom })
    : '';
  const sourceLabel = source ? t('chat_panel.quote_source_label', { source, range }) : t('chat_panel.quote_selection');
  const quoted = quote.text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const question = trimmed || t('chat_panel.quote_default_question');

  return t('chat_panel.quote_template', { source: sourceLabel, quoted, question });
}

const QuickActionButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, label, children }) => (
  <button
    className="ui-pressable"
    onClick={onClick}
    disabled={disabled}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 10px',
      fontSize: 12,
      color: 'var(--text2)',
      backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
      border: '1px solid var(--border)',
      borderRadius: 20,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--sans)',
      opacity: disabled ? 0.5 : 1,
      marginBottom: 6,
    }}
  >
    {children}
    <span>{label}</span>
  </button>
);
