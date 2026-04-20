import React, { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import type { ChatThread } from '@shared/types';

interface ChatHistoryPanelProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  1)  return '刚刚';
  if (mins  < 60)  return `${mins}分钟前`;
  if (hours < 24)  return `${hours}小时前`;
  if (days  <  7)  return `${days}天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export const ChatHistoryPanel: React.FC<ChatHistoryPanelProps> = ({
  threads,
  activeThreadId,
  onSelect,
  onDelete,
  onClose,
}) => {
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
      }}
    >
      {threads.length === 0 ? (
        <div style={{
          padding: '20px 16px', textAlign: 'center',
          fontSize: 12, color: 'var(--text3)',
        }}>
          暂无对话记录
        </div>
      ) : (
        threads.map((t) => {
          const isActive = t.id === activeThreadId;
          return (
            <div
              key={t.id}
              onClick={() => { onSelect(t.id); onClose(); }}
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
                  {t.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {relativeTime(t.updatedAt)}
                </div>
              </div>

              <button
                onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                title="删除对话"
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
