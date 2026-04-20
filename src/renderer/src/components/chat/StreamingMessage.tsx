import React, { useMemo, useState, useRef, useEffect } from 'react';
import { marked } from 'marked';
import { Copy, Pencil, Check, X } from 'lucide-react';
import type { FileAttachment } from '@shared/types';

interface StreamingMessageProps {
  content: string;
  isStreaming?: boolean;
  role?: 'user' | 'assistant';
  attachments?: FileAttachment[];
  /** User message edit: saves and triggers AI resend */
  onEditAndResend?: (newContent: string) => void;
}

marked.setOptions({ breaks: true, gfm: true });

// ── Icon-only action button ────────────────────────────────────────────────────

const ActionBtn: React.FC<{
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}> = ({ onClick, title, children }) => (
  <button
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 24, height: 24, borderRadius: 5,
      border: '1px solid var(--border)',
      background: 'var(--surface)', color: 'var(--text3)',
      cursor: 'pointer', padding: 0,
    }}
    title={title}
    onClick={onClick}
    onMouseEnter={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.color = 'var(--text2)';
      el.style.background = 'var(--surface2)';
    }}
    onMouseLeave={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.color = 'var(--text3)';
      el.style.background = 'var(--surface)';
      el.style.borderColor = 'var(--border)';
    }}
  >
    {children}
  </button>
);

// ── Assistant message actions (copy, always visible) ──────────────────────────

const AssistantActions: React.FC<{ content: string }> = ({ content }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
      <ActionBtn onClick={handleCopy} title={copied ? '已复制' : '复制'}>
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </ActionBtn>
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
  onEditAndResend?: (newContent: string) => void;
}> = ({ content, attachments, onEditAndResend }) => {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(content);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== content) {
      onEditAndResend?.(trimmed);
    }
    setEditing(false);
  };

  const startEdit = () => {
    setEditText(content);
    setEditing(true);
  };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: 14 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Attachment badges */}
      {attachments && attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, maxWidth: '82%' }}>
          {attachments.map((att) => (
            <div key={att.id} style={{
              display: 'flex', alignItems: 'center', gap: 3,
              padding: '2px 8px',
              backgroundColor: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 20, fontSize: 11, color: 'var(--text2)',
              maxWidth: 180,
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {att.name}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{
        maxWidth: '82%',
        backgroundColor: 'var(--accent-s)',
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
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{
              width: '100%', minHeight: 60,
              fontSize: 13, fontFamily: 'var(--sans)', lineHeight: 1.6,
              border: 'none', outline: 'none', resize: 'vertical',
              background: 'transparent', color: 'var(--text)', padding: 0,
            }}
          />
        ) : renderCommandContent(content)}
      </div>

      {/* Editing confirm/cancel row */}
      {editing && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <ActionBtn onClick={() => setEditing(false)} title="取消">
            <X size={11} />
          </ActionBtn>
          <ActionBtn onClick={handleSaveEdit} title="保存并重新生成">
            <Check size={11} />
          </ActionBtn>
        </div>
      )}

      {/* Hover actions (copy / edit) */}
      {!editing && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }}>
          <ActionBtn onClick={handleCopy} title={copied ? '已复制' : '复制'}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </ActionBtn>
          {onEditAndResend && (
            <ActionBtn onClick={startEdit} title="编辑并重新生成">
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
}) => {
  const html = useMemo(() => {
    if (!content || role === 'user') return '';
    return marked.parse(content) as string;
  }, [content, role]);

  if (role === 'user') {
    return (
      <UserMessage
        content={content}
        attachments={attachments}
        onEditAndResend={onEditAndResend}
      />
    );
  }

  // Assistant message
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        backgroundColor: 'var(--surface2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        padding: '10px 14px',
        wordBreak: 'break-word',
      }}>
        <div
          className="md-content"
          dangerouslySetInnerHTML={{ __html: html }}
          style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.75 }}
        />
        {isStreaming && (
          <span style={{
            display: 'inline-block', width: 6, height: 13,
            backgroundColor: 'var(--accent)', borderRadius: 1, marginLeft: 2,
            animation: 'cursor-blink 0.9s steps(1) infinite', verticalAlign: 'text-bottom',
          }} />
        )}
      </div>
      {!isStreaming && (
        <AssistantActions content={content} />
      )}
    </div>
  );
};
