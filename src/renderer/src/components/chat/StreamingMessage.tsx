import React, { useState, useRef, useEffect } from 'react';
import { Copy, Pencil, Check, X, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentType, ChatMessageEditPayload, FileAttachment, ModelCapabilityInfo } from '@shared/types';
import { MarkdownPreview } from '../file/MarkdownPreview';
import { showToast } from '../ui/ToastViewport';
import {
  AttachmentSpinStyle,
  AttachmentStatusIcon,
  attachmentStatusText,
  sanitizeAttachmentsForMessage,
  statusColor,
  useChatAttachments,
} from './useChatAttachments';

interface UserMessageEditContext {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
  attachmentCapability?: ModelCapabilityInfo | null;
  disabled?: boolean;
}

interface StreamingMessageProps {
  content: string;
  isStreaming?: boolean;
  role?: 'user' | 'assistant';
  attachments?: FileAttachment[];
  /** User message edit: saves and triggers AI resend */
  onEditAndResend?: (payload: ChatMessageEditPayload) => void;
  editContext?: UserMessageEditContext;
}

// ── Icon-only action button ────────────────────────────────────────────────────

const ActionBtn: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled = false, children }) => (
  <button
    className="ui-pressable"
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 24, height: 24, borderRadius: 5,
      border: '1px solid var(--border)',
      background: 'var(--app-workspace-card-bg-strong, var(--surface))', color: disabled ? 'var(--border2)' : 'var(--text3)',
      cursor: disabled ? 'not-allowed' : 'pointer', padding: 0,
    }}
    title={title}
    disabled={disabled}
    onClick={() => { if (!disabled) onClick(); }}
    onMouseEnter={(e) => {
      if (disabled) return;
      const el = e.currentTarget as HTMLButtonElement;
      el.style.color = 'var(--text2)';
      el.style.background = 'var(--app-workspace-muted-bg, var(--surface2))';
    }}
    onMouseLeave={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.color = disabled ? 'var(--border2)' : 'var(--text3)';
      el.style.background = 'var(--app-workspace-card-bg-strong, var(--surface))';
      el.style.borderColor = 'var(--border)';
    }}
  >
    {children}
  </button>
);

const AssistantActions: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      showToast({ kind: 'success', text: t('chat_messages.copied') });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ kind: 'error', text: t('chat_messages.copy_failed') });
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <ActionBtn onClick={handleCopy} title={copied ? t('chat_messages.copied') : t('chat_messages.copy')}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </ActionBtn>
      </div>
    </div>
  );
};

// ── Command content renderer ───────────────────────────────────────────────────

function renderCommandContent(content: string): React.ReactNode {
  if (!content.startsWith('/')) return content;
  const spaceIdx = content.indexOf(' ');
  if (spaceIdx === -1) {
    return <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{content}</span>;
  }
  return (
    <>
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{content.slice(0, spaceIdx)}</span>
      {content.slice(spaceIdx)}
    </>
  );
}

// ── User message (bubble + inline edit) ───────────────────────────────────────

const UserMessage: React.FC<{
  content: string;
  attachments?: FileAttachment[];
  onEditAndResend?: (payload: ChatMessageEditPayload) => void;
  editContext?: UserMessageEditContext;
}> = ({ content, attachments, onEditAndResend, editContext }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(content);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const initialAttachments = attachments ?? [];
  const {
    attachments: draftAttachments,
    setAttachments: setDraftAttachments,
    attachmentsReady,
    attachmentInfo,
    uploadError,
    pickLocalFiles,
    removeAttachment,
  } = useChatAttachments({
    agentType: editContext?.agentType ?? 'main_tutor',
    courseId: editContext?.courseId ?? '',
    nodeId: editContext?.nodeId,
    threadId: editContext?.threadId,
    attachmentCapability: editContext?.attachmentCapability,
    initialAttachments,
    deleteSourceOnRemove: false,
  });
  const visibleAttachments = editing ? draftAttachments : initialAttachments;
  const editDisabled = Boolean(editContext?.disabled);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      showToast({ kind: 'success', text: t('chat_messages.copied') });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ kind: 'error', text: t('chat_messages.copy_failed') });
    }
  };

  const canSaveEdit = !editDisabled && attachmentsReady && (editText.trim().length > 0 || draftAttachments.length > 0);

  const handleSaveEdit = () => {
    if (!canSaveEdit) return;
    const trimmed = editText.trim();
    const nextAttachments = sanitizeAttachmentsForMessage(draftAttachments);
    const changed = trimmed !== content || attachmentSignature(nextAttachments) !== attachmentSignature(initialAttachments);
    if ((trimmed || nextAttachments.length > 0) && changed) {
      onEditAndResend?.({ content: trimmed, attachments: nextAttachments });
    }
    setEditing(false);
  };

  const startEdit = () => {
    if (editDisabled) return;
    setEditText(content);
    setDraftAttachments(initialAttachments);
    setEditing(true);
  };

  const cleanupNewDraftSources = () => {
    const originalSourceIds = new Set(initialAttachments.map((att) => att.sourceId).filter(Boolean));
    for (const att of draftAttachments) {
      if (!att.sourceId || !originalSourceIds.has(att.sourceId)) {
        removeAttachment(att.id, true);
      }
    }
  };

  const cancelEdit = () => {
    cleanupNewDraftSources();
    setEditText(content);
    setDraftAttachments(initialAttachments);
    setEditing(false);
  };

  const removeDraftAttachment = (att: FileAttachment) => {
    const originalSourceIds = new Set(initialAttachments.map((item) => item.sourceId).filter(Boolean));
    removeAttachment(att.id, !att.sourceId || !originalSourceIds.has(att.sourceId));
  };

  return (
    <div
      className="ui-message-in"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: 14 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {visibleAttachments.length > 0 && <AttachmentSpinStyle />}
      {editing && uploadError && (
        <div style={{
          maxWidth: '82%', marginBottom: 4, padding: '4px 8px',
          color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 5, fontSize: 11,
        }}>
          {uploadError}
        </div>
      )}
      {editing && attachmentInfo && (
        <div style={{
          maxWidth: '82%', marginBottom: 4, padding: '4px 8px',
          color: 'var(--text3)', background: 'var(--app-workspace-muted-bg, var(--surface2))', border: '1px solid var(--border)',
          borderRadius: 5, fontSize: 11,
        }}>
          {attachmentInfo}
        </div>
      )}
      {/* Attachment badges */}
      {(visibleAttachments.length > 0 || editing) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, maxWidth: '82%' }}>
          {visibleAttachments.map((att) => (
            <div
              key={att.id}
              className={`ui-attachment-badge${editing ? ` ui-attachment-badge-${attachmentBadgeTone(att.status)}` : ''}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '2px 8px',
                fontSize: 11,
                maxWidth: 180,
              }}
              title={att.message || att.processingError || att.name}
            >
              {editing && <AttachmentStatusIcon status={att.status ?? 'ready'} />}
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {att.name}
                </span>
                {editing && (
                  <span style={{
                    fontSize: 10,
                    color: statusColor(att.status ?? 'ready'),
                    lineHeight: 1.1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {attachmentStatusText(att)}
                  </span>
                )}
              </span>
              {editing && (
                <button
                  className="ui-pressable"
                  onClick={() => removeDraftAttachment(att)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text3)',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    borderRadius: 4,
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
          {editing && (
            <button
              className="ui-pressable"
              onClick={() => pickLocalFiles(editDisabled).catch(() => {})}
              disabled={editDisabled}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                border: '1px solid var(--border)',
                borderRadius: 20,
                background: 'var(--app-workspace-card-bg-strong, var(--surface))',
                color: editDisabled ? 'var(--border2)' : 'var(--text2)',
                cursor: editDisabled ? 'not-allowed' : 'pointer',
                fontSize: 11,
                fontFamily: 'var(--sans)',
              }}
            >
              <Paperclip size={11} />
              {t('chat_messages.add_attachment')}
            </button>
          )}
        </div>
      )}

      <div style={{
        maxWidth: '82%',
        backgroundColor: 'var(--app-workspace-accent-bg, var(--accent-s))',
        border: '1px solid var(--accent-b)',
        borderRadius: 'var(--r2)',
        padding: editing ? '6px 8px' : '8px 12px',
        fontSize: 13, color: 'var(--text)', lineHeight: 1.6,
        whiteSpace: editing ? undefined : 'pre-wrap',
        wordBreak: 'break-word',
        width: editing ? '82%' : undefined,
      }}>
        {editing ? (
          <textarea
            className="ui-focus-ring"
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              const native = e.nativeEvent as KeyboardEvent;
              const isComposing = composingRef.current || native.isComposing || native.keyCode === 229;
              if (e.key === 'Enter' && !e.shiftKey) {
                if (isComposing) return;
                e.preventDefault();
                handleSaveEdit();
              }
              if (e.key === 'Escape') cancelEdit();
            }}
            disabled={editDisabled}
            style={{
              width: '100%', minHeight: 60,
              fontSize: 13, fontFamily: 'var(--sans)', lineHeight: 1.6,
              border: 'none', outline: 'none', resize: 'vertical',
              background: 'transparent', color: editDisabled ? 'var(--text3)' : 'var(--text)', padding: 0,
            }}
          />
        ) : renderCommandContent(content)}
      </div>

      {/* Editing confirm/cancel row */}
      {editing && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <ActionBtn onClick={cancelEdit} title={t('common.cancel')}>
            <X size={11} />
          </ActionBtn>
          <ActionBtn onClick={handleSaveEdit} title={editDisabled ? t('chat_messages.save_disabled_generating') : attachmentsReady ? t('chat_messages.save_regenerate') : t('chat_messages.save_wait_attachments')} disabled={!canSaveEdit}>
            <Check size={11} />
          </ActionBtn>
        </div>
      )}

      {/* Hover actions (copy / edit) */}
      {!editing && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
          <ActionBtn onClick={handleCopy} title={copied ? t('chat_messages.copied') : t('chat_messages.copy')}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </ActionBtn>
          {onEditAndResend && (
            <ActionBtn onClick={startEdit} title={editDisabled ? t('chat_messages.edit_disabled_generating') : t('chat_messages.edit_regenerate')} disabled={editDisabled}>
              <Pencil size={11} />
            </ActionBtn>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────

export const StreamingMessage: React.FC<StreamingMessageProps> = ({
  content,
  isStreaming = false,
  role = 'assistant',
  attachments,
  onEditAndResend,
  editContext,
}) => {
  if (role === 'user') {
    return (
      <UserMessage
        content={content}
        attachments={attachments}
        onEditAndResend={onEditAndResend}
        editContext={editContext}
      />
    );
  }

  // Assistant message — borderless full-width prose (no bubble). The user bubble
  // on the right is what distinguishes turns; the answer reads as plain document
  // text with a comfortable reading column on wide screens.
  return (
    <div className="ui-message-in" style={{ marginBottom: 16, maxWidth: 'min(72ch, 100%)', wordBreak: 'break-word' }}>
      <MarkdownPreview content={content} className="md-content" />
      {isStreaming && (
        <span style={{
          display: 'inline-block', width: 6, height: 13,
          backgroundColor: 'var(--accent)', borderRadius: 1, marginLeft: 2,
          animation: 'cursor-blink 0.9s steps(1) infinite', verticalAlign: 'text-bottom',
        }} />
      )}
      {!isStreaming && (
        <AssistantActions content={content} />
      )}
    </div>
  );
};

function attachmentBadgeTone(status?: FileAttachment['status']): 'ready' | 'busy' | 'failed' {
  if (status === 'failed') return 'failed';
  if (status && status !== 'ready') return 'busy';
  return 'ready';
}

function attachmentSignature(attachments: FileAttachment[]): string {
  return attachments
    .map((att) => `${att.sourceId ?? att.id}:${att.name}:${att.status ?? ''}`)
    .sort()
    .join('|');
}
