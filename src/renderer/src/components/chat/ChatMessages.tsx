import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentType, ChatMessage, ChatMessageEditPayload, DiagnosticRecord, MessageArtifact, ModelCapabilityInfo } from '@shared/types';
import { useChatStore } from '../../stores/chat.store';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { closeDanglingMarkdown } from '../../utils/markdown-stream';
import { StreamingMessage } from './StreamingMessage';
import { ArtifactCards } from './ArtifactCards';
import { DiagnosticsView } from './DiagnosticsView';
import { MessageActivity } from './MessageActivity';
import { LiveActivity } from './LiveActivity';

interface ChatMessageEditContext {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
  attachmentCapability?: ModelCapabilityInfo | null;
  disabled?: boolean;
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  streamingContent: string;
  /** Live tool/thinking progress text; committed into the final assistant message when available. */
  progressContent?: string;
  isStreaming: boolean;
  streamError: string | null;
  onEditAndResendMessage?: (id: string, payload: ChatMessageEditPayload) => void;
  editContext?: ChatMessageEditContext;
  emptyText?: React.ReactNode;
  /** Opens a generated-file artifact card in the workspace. */
  onOpenArtifact?: (artifact: MessageArtifact) => void;
}

/** Live diagnostics toggle — the dev-facing "查看思路" during an active run, collapsed by default. */
const LiveReasoningToggle: React.FC<{ diagnostics: DiagnosticRecord[] }> = ({ diagnostics }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 6 }}>
      <button
        className="ui-pressable"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 6,
          padding: '3px 9px', fontSize: 11, color: 'var(--text3)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        {t('chat_messages.view_reasoning')}
      </button>
      {open && (
        <div className="ui-thought-reveal" style={{ marginTop: 4 }}>
          <DiagnosticsView records={diagnostics} live />
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
  editContext,
  emptyText,
  onOpenArtifact,
}) => {
  const { t } = useTranslation();
  const currentPhase = useChatStore((s) => s.currentPhase);
  const liveDiagnostics = useChatStore((s) => s.liveDiagnostics);
  const liveArtifacts = useChatStore((s) => s.liveArtifacts);
  const hasLiveActivity = useChatStore((s) =>
    Boolean(s.thinkingContent.trim()) || s.liveToolEvents.length > 0 || s.liveDiagnostics.length > 0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMsgCountRef = useRef(messages.length);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Throttle + stabilize the live answer so it reads "line by line" instead of
  // re-parsing per token (which thrashes the CPU and flashes partial markdown).
  const throttledStreaming = useThrottledValue(streamingContent, 50);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior });
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  };

  // New message added. A just-sent question scrolls to the top so the answer
  // streams below it (reading from the top); a completed answer only keeps the
  // bottom pinned if the user was already there.
  useEffect(() => {
    if (messages.length <= prevMsgCountRef.current) {
      prevMsgCountRef.current = messages.length;
      return;
    }
    prevMsgCountRef.current = messages.length;
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      // Pin the question near the top so the answer streams below it. Mark
      // "not at bottom" up front so the streaming-chunk effect doesn't fight
      // the smooth scroll before it registers as a scroll event.
      isAtBottomRef.current = false;
      requestAnimationFrame(() =>
        lastUserRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } else if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [messages.length]);

  // Streaming chunks → only scroll if user is already near the bottom
  useEffect(() => {
    if (throttledStreaming && isAtBottomRef.current) scrollToBottom();
  }, [throttledStreaming]);

  useEffect(() => {
    if (progressContent && isAtBottomRef.current) scrollToBottom();
  }, [progressContent]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
      {messages.map((msg, index) => {
        const isLastUser = msg.role === 'user' && index === messages.length - 1;
        return (
          <div key={msg.id} ref={isLastUser ? lastUserRef : undefined} style={{ scrollMarginTop: 16 }}>
            {msg.role === 'assistant' && (msg.thinking || msg.progress || msg.diagnostics) && (
              <MessageActivity thinking={msg.thinking} progress={msg.progress} diagnostics={msg.diagnostics} />
            )}
            <StreamingMessage
              content={msg.content}
              role={msg.role}
              attachments={msg.attachments}
              onEditAndResend={msg.role === 'user' && onEditAndResendMessage
                ? (payload) => onEditAndResendMessage(msg.id, payload)
                : undefined}
              editContext={editContext}
            />
            {msg.role === 'assistant' && msg.artifacts && msg.artifacts.length > 0 && (
              <ArtifactCards artifacts={msg.artifacts} onOpen={onOpenArtifact} />
            )}
          </div>
        );
      })}

      {/* Clean user-facing current-phase hint (separate from the dev diagnostics). */}
      {isStreaming && currentPhase && (
        <div
          aria-live="polite"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginBottom: 8,
            padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)',
            background: 'var(--app-workspace-muted-bg, var(--surface2))', fontSize: 12, color: 'var(--text2)',
          }}
        >
          <span className="ui-soft-pulse" style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--accent)', flexShrink: 0 }} />
          <span>{currentPhase}</span>
        </div>
      )}

      {/* Live pre-answer blocks: thinking (open) → tool group, in canonical order. */}
      {isStreaming && <LiveActivity />}

      {/* Live diagnostics ("查看思路"), collapsed by default to keep the answer forward. */}
      {isStreaming && liveDiagnostics.length > 0 && (
        <LiveReasoningToggle diagnostics={liveDiagnostics} />
      )}

      {/* Live streaming content (throttled + stabilized for a calm line-by-line render) */}
      {isStreaming && streamingContent && (
        <StreamingMessage
          content={closeDanglingMarkdown(throttledStreaming)}
          role="assistant"
          isStreaming
        />
      )}

      {/* Live artifact cards for files generated during the active run */}
      {isStreaming && liveArtifacts.length > 0 && (
        <ArtifactCards artifacts={liveArtifacts} onOpen={onOpenArtifact} />
      )}

      {/* Streaming placeholder (before any thinking/tools/answer appears) */}
      {isStreaming && !streamingContent && !hasLiveActivity && (
        <div className="ui-message-in" style={{
          marginBottom: 12,
          display: 'inline-flex',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 8,
          padding: '7px 10px',
          borderRadius: 'var(--r2)',
          border: '1px solid var(--border)',
          backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
          color: 'var(--text2)',
          fontSize: 12,
        }}>
          <span
            className="ui-soft-pulse"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: 'var(--accent)',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span>{t('chat_messages.generating')}</span>
          <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent)',
                  opacity: 0.6,
                  display: 'inline-block',
                  animation: `cursor-blink 1.2s steps(1) ${i * 0.2}s infinite`,
                }}
              />
            ))}
          </span>
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
          whiteSpace: 'pre-wrap',
        }}>
          {streamError}
        </div>
      )}

      <div ref={bottomRef} />
    </div>

      {/* Back-to-bottom button (shown when scrolled up away from the latest content) */}
      {showScrollBtn && (
        <button
          className="ui-pressable"
          onClick={() => scrollToBottom()}
          title={t('chat_messages.scroll_to_bottom')}
          aria-label={t('chat_messages.scroll_to_bottom')}
          style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: '50%',
            border: '1px solid var(--border)',
            background: 'var(--app-workspace-card-bg-strong, var(--surface))',
            color: 'var(--text2)', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
};
