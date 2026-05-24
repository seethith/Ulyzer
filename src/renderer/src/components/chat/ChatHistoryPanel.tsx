import React, { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ChatThread } from '@shared/types';

interface ChatHistoryPanelProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onClose: () => void;
}

function relativeTime(iso: string, t: TFunction, language: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  1)  return t('chat_panel.time_just_now');
  if (mins  < 60)  return t('chat_panel.time_minutes_ago', { count: mins });
  if (hours < 24)  return t('chat_panel.time_hours_ago', { count: hours });
  if (days  <  7)  return t('chat_panel.time_days_ago', { count: days });
  return new Date(iso).toLocaleDateString(language.startsWith('en') ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' });
}

export const ChatHistoryPanel: React.FC<ChatHistoryPanelProps> = ({
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      className="ui-menu-pop"
      ref={ref}
      style={{
        position: 'absolute',
        top: 'calc(100% + 2px)',
        right: 0,
        left: 0,
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        zIndex: 300,
        maxHeight: 320,
        overflowY: 'auto',
        padding: '4px 0',
        transformOrigin: 'top right',
      }}
    >
      {threads.length === 0 ? (
        <div style={{
          padding: '20px 16px', textAlign: 'center',
          fontSize: 12, color: 'var(--text3)',
        }}>
          {t('chat_panel.history_empty')}
        </div>
      ) : (
        threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          return (
            <div
              className="ui-pressable"
              key={thread.id}
              onClick={() => { onSelect(thread.id); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px',
                backgroundColor: isActive ? 'var(--accent-s)' : 'transparent',
                cursor: 'pointer',
                transition: 'background-color 0.1s',
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--surface2)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = isActive ? 'var(--accent-s)' : 'transparent';
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  color: isActive ? 'var(--accent)' : 'var(--text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: isActive ? 600 : 400,
                }}>
                  {thread.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {relativeTime(thread.updatedAt, t, i18n.language)}
                </div>
              </div>

              <button
                className="ui-pressable"
                onClick={(e) => { e.stopPropagation(); onDelete(thread.id); }}
                title={t('chat_panel.delete_thread')}
                style={{
                  flexShrink: 0, width: 24, height: 24,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text3)', borderRadius: 'var(--r)',
                  transition: 'background-color 0.1s, color 0.1s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--red-s, #fee2e2)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--red, #ef4444)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)';
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })
      )}
    </div>
  );
};
