import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@shared/types';
import { StreamingMessage } from './StreamingMessage';

interface ChatMessagesProps {
  messages: ChatMessage[];
  streamingContent: string;
  /** Tool-execution progress text — shown with lighter italic styling, not saved to history */
  progressContent?: string;
  isStreaming: boolean;
  streamError: string | null;
  onEditAndResendMessage?: (id: string, content: string) => void;
  emptyText?: React.ReactNode;
}

const ProgressToggle: React.FC<{ progress: string }> = ({ progress }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4, marginBottom: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 4,
          padding: '2px 8px', fontSize: 11, color: 'var(--text3)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        {t('chat_messages.view_reasoning')}
      </button>
      {open && (
        <div style={{
          marginTop: 4, fontSize: 11, fontStyle: 'italic', color: 'var(--text3)',
          lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: '6px 10px',
          borderLeft: '2px solid var(--border)', borderRadius: '0 4px 4px 0',
          backgroundColor: 'var(--surface2)', maxHeight: 320, overflowY: 'auto',
        }}>
          {progress}
        </div>
      )}
    </div>
  );
};

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  streamingContent,
  progressContent,
  isStreaming,
  streamError,
  onEditAndResendMessage,
  emptyText,
}) => {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMsgCountRef = useRef(messages.length);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // New message added → always scroll to bottom (user sent message or response completed)
  useEffect(() => {
    if (messages.length !== prevMsgCountRef.current) {
      prevMsgCountRef.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // Streaming chunks → only scroll if user is already near the bottom
  useEffect(() => {
    if (streamingContent && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingContent]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 16px 8px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Empty state */}
      {messages.length === 0 && !isStreaming && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 8,
          color: 'var(--text3)',
          fontSize: 13,
          textAlign: 'center',
          padding: '0 20px',
        }}>
          <span style={{ fontSize: 28 }}>✦</span>
          {emptyText ?? <span style={{ whiteSpace: 'pre-line' }}>{t('chat_messages.empty_default')}</span>}
        </div>
      )}

      {/* Historical messages */}
      {messages.map((msg) => (
        <React.Fragment key={msg.id}>
          <StreamingMessage
            content={msg.content}
            role={msg.role}
            attachments={msg.attachments}
            onEditAndResend={msg.role === 'user' && onEditAndResendMessage
              ? (c) => onEditAndResendMessage(msg.id, c)
              : undefined}
          />
          {msg.role === 'assistant' && msg.progress && (
            <ProgressToggle progress={msg.progress} />
          )}
        </React.Fragment>
      ))}

      {/* Tool-execution progress messages (italic, lighter color, not saved to history) */}
      {isStreaming && progressContent && (
        <div style={{
          fontSize: 11,
          fontStyle: 'italic',
          color: 'var(--text3)',
          marginBottom: 4,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          padding: '4px 8px',
          borderLeft: '2px solid var(--border)',
        }}>
          {progressContent}
        </div>
      )}

      {/* Live streaming content */}
      {isStreaming && streamingContent && (
        <StreamingMessage
          content={streamingContent}
          role="assistant"
          isStreaming
        />
      )}

      {/* Streaming placeholder (before first chunk) */}
      {isStreaming && !streamingContent && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: 'var(--accent)',
                opacity: 0.6,
                display: 'inline-block',
                animation: `cursor-blink 1.2s steps(1) ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      )}

      {/* Error state */}
      {streamError && (
        <div style={{
          padding: '8px 12px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 'var(--r)',
          fontSize: 12,
          color: '#b91c1c',
          marginBottom: 8,
        }}>
          {streamError}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};
