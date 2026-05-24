import React, { useRef, useCallback, useEffect } from 'react';
import { Paperclip, Globe, ArrowUp, X, Square, Sparkles, BookOpen, SearchX, BrainCircuit, TextQuote } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentType,
  FileAttachment,
  ModelCapabilityInfo,
  SearchMode,
  ThinkingMode,
} from '@shared/types';
import { ModelSelector } from './ModelSelector';
import {
  AttachmentSpinStyle,
  AttachmentStatusIcon,
  attachmentStatusText,
  statusColor,
  useChatAttachments,
} from './useChatAttachments';
import type { ChatDraftQuote } from '../../stores/chat.store';

interface ChatInputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string, attachments: FileAttachment[], searchMode: SearchMode, thinkingMode: ThinkingMode) => boolean | void;
  onAbort?: () => void;
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
  placeholder?: string;
  disabled?: boolean;
  /** Extra content to render above the textarea (e.g. preset commands) */
  headerSlot?: React.ReactNode;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** How the next message should search/use sources. */
  searchMode?: SearchMode;
  /** Called when the user chooses a search/source mode. */
  onSearchModeChange?: (mode: SearchMode) => void;
  /** Current thinking/reasoning mode for the next message. */
  thinkingMode?: ThinkingMode;
  /** Called when the user chooses a thinking/reasoning mode. */
  onThinkingModeChange?: (mode: ThinkingMode) => void;
  /** Whether the current model exposes a thinking/reasoning path. */
  thinkingAvailable?: boolean;
  /** How the current model can be steered when thinking is enabled. */
  thinkingControl?: ModelCapabilityInfo['thinkingControl'];
  /** Error message to show when web search key is not configured */
  webSearchError?: string | null;
  /** Current model capability, used to keep upload affordances aligned with backend routing. */
  attachmentCapability?: ModelCapabilityInfo | null;
  contextStatus?: {
    percent: number;
    inputTokens: number;
    inputBudget: number;
    contextWindow: number;
  } | null;
  contextStatusVisible?: boolean;
  draftQuote?: ChatDraftQuote | null;
  onClearDraftQuote?: () => void;
}

const MIN_HEIGHT = 78;
const MAX_HEIGHT = 160;

// ── Component ──────────────────────────────────────────────────────────────────

export const ChatInputBox: React.FC<ChatInputBoxProps> = ({
  value,
  onChange,
  onSend,
  onAbort,
  agentType,
  courseId,
  nodeId,
  threadId,
  placeholder,
  disabled = false,
  headerSlot,
  textareaRef: externalRef,
  searchMode = 'auto',
  onSearchModeChange,
  thinkingMode = 'off',
  onThinkingModeChange,
  thinkingAvailable = false,
  thinkingControl = 'none',
  webSearchError,
  attachmentCapability,
  contextStatus,
  contextStatusVisible = false,
  draftQuote = null,
  onClearDraftQuote,
}) => {
  const { t, i18n } = useTranslation();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const composingRef = useRef(false);

  const {
    attachments,
    attachmentsReady,
    attachmentInfo,
    uploadError,
    processFiles,
    pickLocalFiles,
    processInternalDrop,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments({
    agentType,
    courseId,
    nodeId,
    threadId,
    attachmentCapability,
    deleteSourceOnRemove: true,
  });
  const [focused, setFocused] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [searchMenuOpen, setSearchMenuOpen] = React.useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = React.useState(false);
  const searchMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${MIN_HEIGHT}px`;
    const scrollH = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(scrollH, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [textareaRef]);

  useEffect(() => { resizeTextarea(); }, [value, resizeTextarea]);

  useEffect(() => {
    if (!searchMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!searchMenuRef.current?.contains(event.target as Node)) setSearchMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [searchMenuOpen]);

  useEffect(() => {
    if (!thinkingMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!thinkingMenuRef.current?.contains(event.target as Node)) setThinkingMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [thinkingMenuOpen]);

  const canSend = (value.trim().length > 0 || attachments.length > 0 || Boolean(draftQuote)) && !disabled && attachmentsReady;

  const handleSend = () => {
    if (!canSend) return;
    const sent = onSend(value.trim(), attachments, searchMode, thinkingMode);
    if (sent === false) return;
    onChange('');
    onClearDraftQuote?.();
    clearAttachments(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as KeyboardEvent;
    const isComposing = composingRef.current || native.isComposing || native.keyCode === 229;
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only trigger if leaving the container (not a child)
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    // Check for internal FileExplorer drag first
    const internal = e.dataTransfer.getData('application/ulyzer-file');
    if (internal) {
      processInternalDrop(internal).catch(() => {});
      return;
    }

    // OS-level file drop
    processFiles(Array.from(e.dataTransfer.files)).catch(() => {});
  };

  const borderColor = isDragging
    ? 'var(--accent)'
    : focused
      ? 'var(--accent-b)'
      : 'var(--border)';

  const boxShadow = isDragging || focused
    ? '0 0 0 3px var(--accent-s)'
    : 'var(--shadow)';

  return (
    <div
      className="chat-input-box"
      style={{
        backgroundColor: 'var(--app-workspace-card-bg-strong, var(--surface))',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--r2)',
        boxShadow,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        position: 'relative',
        containerType: 'inline-size',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {headerSlot && (
        <div style={{ padding: '8px 12px 0' }}>{headerSlot}</div>
      )}

      {draftQuote && (
        <div className="chat-input-draft-quote" title={draftQuoteTitle(draftQuote)}>
          <TextQuote size={14} />
          <div className="chat-input-draft-quote-body">
            <div className="chat-input-draft-quote-source">
              引用 {draftQuote.sourceName || draftQuote.relativePath || '选中文本'}
              {formatQuoteLineRange(draftQuote)}
            </div>
            <div className="chat-input-draft-quote-preview">
              {compactQuotePreview(draftQuote.text)}
            </div>
          </div>
          <button
            type="button"
            className="chat-input-draft-quote-clear ui-pressable"
            onClick={onClearDraftQuote}
            title="移除引用"
            aria-label="移除引用"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Drag overlay hint */}
      {isDragging && (
        <div style={{
          padding: '6px 12px', fontSize: 12,
          color: 'var(--accent)', backgroundColor: 'var(--accent-s)',
          borderBottom: '1px solid var(--accent-b)',
          textAlign: 'center',
        }}>
          {t('chat_input.drop_to_add')}
        </div>
      )}

      {/* Upload error banner */}
      {uploadError && (
        <div style={{
          padding: '5px 12px', fontSize: 11,
          color: '#b91c1c', backgroundColor: '#fef2f2',
          borderBottom: '1px solid #fecaca',
        }}>
          {uploadError}
        </div>
      )}

      {/* Attachment routing hint */}
      {attachmentInfo && (
        <div style={{
          padding: '5px 12px', fontSize: 11,
          color: 'var(--text2)', backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
          borderBottom: '1px solid var(--border)',
        }}>
          {attachmentInfo}
        </div>
      )}

      {/* Web search error banner */}
      {webSearchError && (
        <div style={{
          padding: '5px 12px', fontSize: 11,
          color: '#92400e', backgroundColor: '#fffbeb',
          borderBottom: '1px solid #fde68a',
        }}>
          {webSearchError}
        </div>
      )}

      {/* Attachment badges */}
      {attachments.length > 0 && (
        <>
        <AttachmentSpinStyle />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px 0' }}>
          {attachments.map((att) => (
            <div
              key={att.id}
              className={`ui-attachment-badge ui-attachment-badge-${attachmentBadgeTone(att.status)}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 8px',
                fontSize: 12, maxWidth: 200,
              }}
              title={att.message || att.processingError || att.name}
            >
              <AttachmentStatusIcon status={att.status ?? 'ready'} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {att.name}
                </span>
                <span style={{ fontSize: 10, color: statusColor(att.status ?? 'ready'), lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {attachmentStatusText(att)}
                </span>
              </span>
              <button className="ui-pressable" onClick={() => removeAttachment(att.id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text3)', padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0,
                borderRadius: 4,
              }}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        </>
      )}

      <textarea
        className="chat-input-textarea"
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={isDragging ? '' : placeholder}
        disabled={disabled}
        rows={1}
        style={{
          display: 'block', width: '100%',
          minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT,
          padding: '12px 14px', fontSize: 13,
          color: 'var(--text)', backgroundColor: 'transparent',
          border: 'none', outline: 'none', resize: 'none',
          fontFamily: 'var(--sans)', lineHeight: 1.6, overflowY: 'auto',
        }}
      />

      <div className="chat-input-toolbar" style={{
        display: 'flex', alignItems: 'center',
        padding: '4px 7px', borderTop: '1px solid rgba(0,0,0,0.05)', gap: 2,
        minWidth: 0,
        overflow: 'visible',
      }}>
        <ToolButton onClick={() => pickLocalFiles().catch(() => {})} title={t('chat_input.upload_attachment')} disabled={disabled}>
          <Paperclip size={14} />
        </ToolButton>

        <div className="chat-input-optional-control" ref={searchMenuRef} style={{ position: 'relative', flex: '0 1 24px', minWidth: 20, maxWidth: 24 }}>
          <ToolButton
            onClick={() => setSearchMenuOpen((v) => !v)}
            title={searchModeTitle(searchMode, i18n.language)}
            active={searchMode !== 'auto'}
            disabled={!onSearchModeChange}
            compressible
          >
            <SearchModeIcon mode={searchMode} size={14} />
          </ToolButton>
          {searchMenuOpen && (
            <SearchModeMenu
              value={searchMode}
              language={i18n.language}
              onSelect={(mode) => {
                onSearchModeChange?.(mode);
                setSearchMenuOpen(false);
              }}
            />
          )}
        </div>

        <div className="chat-input-optional-control" ref={thinkingMenuRef} style={{ position: 'relative', flex: '0 1 24px', minWidth: 20, maxWidth: 24 }}>
          <ToolButton
            onClick={() => setThinkingMenuOpen((v) => !v)}
            title={thinkingModeTitle(thinkingMode, thinkingAvailable, i18n.language)}
            active={thinkingMode !== 'off' && thinkingAvailable}
            disabled={!onThinkingModeChange || !thinkingAvailable || disabled}
            compressible
          >
            <ThinkingModeIcon mode={thinkingMode} size={14} />
          </ToolButton>
          {thinkingMenuOpen && thinkingAvailable && (
            <ThinkingModeMenu
              value={thinkingMode}
              control={thinkingControl}
              maxOutputTokens={attachmentCapability?.maxOutputTokens}
              language={i18n.language}
              onSelect={(mode) => {
                onThinkingModeChange?.(mode);
                setThinkingMenuOpen(false);
              }}
            />
          )}
        </div>

        <div className="chat-input-optional-separator" style={{ width: 1, height: 14, backgroundColor: 'var(--border)', margin: '0 2px', flex: '0 1 1px' }} />
        <ModelSelector />

        <div style={{ flex: '1 1 0', minWidth: 0 }} />

        {contextStatusVisible && (
          <div className="chat-input-context-indicator" style={{ flex: '0 1 18px', minWidth: 0, overflow: 'visible' }}>
            <ContextWindowIndicator status={contextStatus ?? null} />
          </div>
        )}

        {disabled && onAbort ? (
          <button className="ui-pressable" onClick={onAbort} title={t('chat_input.stop_generating')} style={{
            width: 26, height: 26, borderRadius: 'var(--r)',
            border: 'none', cursor: 'pointer',
            backgroundColor: 'var(--red, #ef4444)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.15s', flex: '0 0 26px',
          }}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="ui-pressable" onClick={handleSend} disabled={!canSend} title={canSend ? '发送 (Enter)' : attachmentsReady ? '' : '附件解析完成后可发送'} style={{
            width: 26, height: 26, borderRadius: 'var(--r)',
            border: 'none', cursor: canSend ? 'pointer' : 'not-allowed',
            backgroundColor: canSend ? 'var(--accent)' : 'var(--border)',
            color: canSend ? '#fff' : 'var(--text3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.15s', flex: '0 0 26px',
          }}>
            <ArrowUp size={13} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};

function attachmentBadgeTone(status?: FileAttachment['status']): 'ready' | 'busy' | 'failed' {
  if (status === 'failed') return 'failed';
  if (status && status !== 'ready') return 'busy';
  return 'ready';
}

function compactQuotePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}...` : compact;
}

function formatQuoteLineRange(quote: ChatDraftQuote): string {
  if (!quote.lineFrom) return '';
  if (!quote.lineTo || quote.lineTo === quote.lineFrom) return ` · 第 ${quote.lineFrom} 行`;
  return ` · 第 ${quote.lineFrom}-${quote.lineTo} 行`;
}

function draftQuoteTitle(quote: ChatDraftQuote): string {
  const source = quote.relativePath || quote.sourceName || quote.sourcePath || '选中文本';
  return `${source}${formatQuoteLineRange(quote)}\n\n${quote.text}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SEARCH_MODE_LABELS: Record<SearchMode, { zh: string; en: string; descZh: string; descEn: string }> = {
  auto: {
    zh: '自动',
    en: 'Auto',
    descZh: 'AI 判断是否检索',
    descEn: 'AI decides when to search',
  },
  web: {
    zh: '联网',
    en: 'Web',
    descZh: '只检索网络',
    descEn: 'Use web search only',
  },
  library: {
    zh: '参考库',
    en: 'Library',
    descZh: '只用已保存参考资料',
    descEn: 'Use saved sources only',
  },
  off: {
    zh: '关闭',
    en: 'Off',
    descZh: '不联网也不查参考库',
    descEn: 'Do not search web or library',
  },
};

function isEn(language: string): boolean {
  return language.toLowerCase().startsWith('en');
}

function searchModeTitle(mode: SearchMode, language: string): string {
  const labels = SEARCH_MODE_LABELS[mode];
  return isEn(language) ? `Search: ${labels.en}` : `AI 搜索模式：${labels.zh}`;
}

function SearchModeIcon({ mode, size = 14 }: { mode: SearchMode; size?: number }) {
  if (mode === 'web') return <Globe size={size} />;
  if (mode === 'library') return <BookOpen size={size} />;
  if (mode === 'off') return <SearchX size={size} />;
  return <Sparkles size={size} />;
}

const THINKING_MODE_LABELS: Record<ThinkingMode, { zh: string; en: string }> = {
  off:    { zh: '关闭', en: 'Off' },
  low:    { zh: '低',   en: 'Low' },
  medium: { zh: '中',   en: 'Medium' },
  high:   { zh: '高',   en: 'High' },
};

/** Per-model meaning of a thinking level, shown as the menu option's sub-label. */
function thinkingLevelMeaning(
  mode: ThinkingMode,
  control: ModelCapabilityInfo['thinkingControl'],
  maxOutputTokens: number | undefined,
  language: string,
): string {
  const en = isEn(language);
  if (mode === 'off') return en ? 'No reasoning' : '不请求思考';
  if (control === 'model') return en ? 'Model decides how much to think' : '模型自行决定思考量';
  if (control === 'effort') {
    const level = mode === 'high' ? (en ? 'high' : '高') : mode === 'medium' ? (en ? 'medium' : '中') : (en ? 'low' : '低');
    return en ? `reasoning_effort = ${level}` : `努力等级 = ${level}`;
  }
  // budget: mirror the backend tiers (low 2k / medium 8k / high 16k), clamped.
  const tier = mode === 'high' ? 16384 : mode === 'medium' ? 8192 : 2048;
  const budget = maxOutputTokens ? Math.min(tier, Math.max(1024, maxOutputTokens - 1024)) : tier;
  const k = budget >= 1000 ? `${Math.round(budget / 1000)}k` : `${budget}`;
  return en ? `~${k} thinking budget` : `≈${k} 思考预算`;
}

function thinkingModeTitle(
  mode: ThinkingMode,
  available: boolean,
  language: string,
): string {
  if (!available) return isEn(language) ? 'Reasoning not supported by this model' : '当前模型不支持思考模式';
  const labels = THINKING_MODE_LABELS[mode];
  return isEn(language) ? `Reasoning: ${labels.en}` : `思考：${labels.zh}`;
}

const THINKING_INTENSITY: Record<ThinkingMode, number> = { off: 0, low: 1, medium: 2, high: 3 };

function ThinkingModeIcon({ mode, size = 14 }: { mode: ThinkingMode; size?: number }) {
  const intensity = THINKING_INTENSITY[mode];
  return (
    <BrainCircuit
      size={size}
      strokeWidth={intensity >= 3 ? 2.6 : intensity === 2 ? 2.2 : 2}
      style={{ opacity: mode === 'off' ? 0.7 : 1 }}
    />
  );
}

const SearchModeMenu: React.FC<{
  value: SearchMode;
  language: string;
  onSelect: (mode: SearchMode) => void;
}> = ({ value, language, onSelect }) => (
  <div className="ui-menu-pop" style={{
    position: 'absolute',
    left: 0,
    bottom: 34,
    width: 168,
    padding: 4,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r)',
    background: 'linear-gradient(var(--app-workspace-card-bg-strong, var(--surface)), var(--app-workspace-card-bg-strong, var(--surface))), var(--surface)',
    boxShadow: 'var(--shadow)',
    zIndex: 30,
    transformOrigin: 'bottom left',
  }}>
    {(['auto', 'web', 'library', 'off'] as SearchMode[]).map((mode) => {
      const label = SEARCH_MODE_LABELS[mode];
      const active = value === mode;
      return (
        <button
          className="ui-pressable"
          key={mode}
          type="button"
          onClick={() => onSelect(mode)}
          style={{
            width: '100%',
            border: 'none',
            borderRadius: 4,
            background: active ? 'var(--accent-s)' : 'transparent',
            color: active ? 'var(--accent)' : 'var(--text2)',
            padding: '6px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            fontFamily: 'var(--sans)',
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: active ? 'var(--accent-b)' : 'var(--app-workspace-muted-bg, var(--surface2))',
              color: active ? 'var(--accent)' : 'var(--text3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <SearchModeIcon mode={mode} size={12} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{isEn(language) ? label.en : label.zh}</span>
              <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {isEn(language) ? label.descEn : label.descZh}
              </span>
            </span>
          </span>
          {active && <span style={{ fontSize: 11 }}>✓</span>}
        </button>
      );
    })}
  </div>
);

const ThinkingModeMenu: React.FC<{
  value: ThinkingMode;
  control: ModelCapabilityInfo['thinkingControl'];
  maxOutputTokens?: number;
  language: string;
  onSelect: (mode: ThinkingMode) => void;
}> = ({ value, control, maxOutputTokens, language, onSelect }) => {
  const en = isEn(language);
  // Reasoner models can't be tuned → only Off / On (On maps to 'high'). Effort and
  // budget models expose the full Off / Low / Medium / High intensity scale.
  const options: ThinkingMode[] = control === 'model' ? ['off', 'high'] : ['off', 'low', 'medium', 'high'];
  return (
    <div className="ui-menu-pop" style={{
      position: 'absolute',
      left: 0,
      bottom: 34,
      width: 196,
      padding: 4,
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      background: 'linear-gradient(var(--app-workspace-card-bg-strong, var(--surface)), var(--app-workspace-card-bg-strong, var(--surface))), var(--surface)',
      boxShadow: 'var(--shadow)',
      zIndex: 30,
      transformOrigin: 'bottom left',
    }}>
      {options.map((mode) => {
        // On a reasoner model any non-off level counts as the single "On" option.
        const active = control === 'model' && mode !== 'off' ? value !== 'off' : value === mode;
        const title = control === 'model' && mode !== 'off'
          ? (en ? 'On' : '开启')
          : (en ? THINKING_MODE_LABELS[mode].en : THINKING_MODE_LABELS[mode].zh);
        const desc = thinkingLevelMeaning(mode, control, maxOutputTokens, language);
        return (
          <button
            className="ui-pressable"
            key={mode}
            type="button"
            onClick={() => onSelect(mode)}
            style={{
              width: '100%',
              border: 'none',
              borderRadius: 4,
              background: active ? 'var(--accent-s)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text2)',
              padding: '6px 8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              fontFamily: 'var(--sans)',
              textAlign: 'left',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                background: active ? 'var(--accent-b)' : 'var(--app-workspace-muted-bg, var(--surface2))',
                color: active ? 'var(--accent)' : 'var(--text3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <ThinkingModeIcon mode={mode} size={12} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
                <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {desc}
                </span>
              </span>
            </span>
            {active && <span style={{ fontSize: 11 }}>✓</span>}
          </button>
        );
      })}
      {control === 'effort' && (
        <div style={{ fontSize: 10, color: 'var(--text3)', padding: '4px 8px 2px', lineHeight: 1.4 }}>
          {en ? 'This model reasons internally but does not return its thinking text.' : '该模型会内部思考,但不返回思考过程文本。'}
        </div>
      )}
    </div>
  );
};

const ContextWindowIndicator: React.FC<{
  status: { percent: number; inputTokens: number; inputBudget: number; contextWindow: number } | null;
}> = ({ status }) => {
  const [hovered, setHovered] = React.useState(false);
  const pct = status ? Math.max(0, Math.min(100, status.percent)) : 0;
  const pctLabel = formatPercent(pct);
  // Thresholds align with the compaction ladder: amber ≈ compressAt (78%), red ≈ collapseAt (90%).
  const color = !status
    ? 'var(--border2)'
    : pct >= 90
      ? '#ef4444'
      : pct >= 78
        ? '#f59e0b'
        : 'var(--accent)';
  const label = status
    ? `${pctLabel} · ${formatTokenCount(status.inputTokens)} / ${formatTokenCount(status.inputBudget)} tokens（窗口 ${formatTokenCount(status.contextWindow)}）`
    : '计算中...';
  // SVG ring with a round line-cap → the arc band has curved ends instead of
  // the conic-gradient's square 90° corners.
  const SIZE = 18;
  const STROKE = 2.4;
  const radius = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = status ? circumference * (1 - pct / 100) : circumference;
  return (
    <div
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 18,
        height: 18,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 2,
        flexShrink: 0,
      }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={!status ? 'ui-soft-pulse' : undefined}
        style={{ display: 'block', opacity: status ? 1 : 0.72, cursor: 'default' }}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--text3) 26%, transparent)"
          strokeWidth={STROKE}
        />
        {status && pct > 0 && (
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: 'stroke-dashoffset 0.35s ease, stroke 0.2s ease' }}
          />
        )}
      </svg>
      {hovered && (
        <div className="ui-menu-pop" style={{
          position: 'absolute',
          right: -2,
          bottom: 30,
          zIndex: 50,
          padding: '4px 7px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'linear-gradient(var(--app-workspace-card-bg-strong, var(--surface)), var(--app-workspace-card-bg-strong, var(--surface))), var(--surface)',
          color: 'var(--text2)',
          boxShadow: 'var(--shadow)',
          fontSize: 11,
          lineHeight: 1.2,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          transformOrigin: 'bottom right',
        }}>
          {label}
        </div>
      )}
    </div>
  );
};

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

const ToolButton: React.FC<{
  onClick: () => void; title?: string; disabled?: boolean; active?: boolean; compressible?: boolean; children: React.ReactNode;
}> = ({ onClick, title, disabled, active, compressible, children }) => (
  <button className="ui-pressable" onClick={onClick} title={title} disabled={disabled} style={{
    width: compressible ? '100%' : 24,
    minWidth: compressible ? 20 : 24,
    height: 24, borderRadius: 'var(--r)',
    border: active ? '1px solid var(--accent-b)' : 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    backgroundColor: active ? 'var(--accent-s)' : 'transparent',
    color: disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'transform 0.12s ease, background-color 0.1s, color 0.1s', flexShrink: 0,
  }}
    onMouseEnter={(e) => { if (!disabled) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-b)' : 'var(--app-workspace-muted-bg, var(--surface2))'; (e.currentTarget as HTMLButtonElement).style.color = active ? 'var(--accent)' : 'var(--text2)'; } }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-s)' : 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)'; }}
  >
    {children}
  </button>
);
