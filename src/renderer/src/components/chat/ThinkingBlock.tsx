import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Collapsible thinking/analysis block — the model's reasoning about the user's
 * request and its plan. Streams live ("思考中…") and seals to "已思考" when done.
 * (Inspired by openhanako's ThinkingBlock.)
 */
export const ThinkingBlock: React.FC<{ content: string; sealed: boolean; defaultOpen?: boolean }> = ({
  content,
  sealed,
  defaultOpen = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const trimmed = content.trim();
  // While streaming, show the block even before text arrives (so "思考中…" appears).
  if (sealed && !trimmed) return null;

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
        <span role="img" aria-hidden style={{ fontSize: 11 }}>💭</span>
        {sealed ? (
          t('chat_messages.thinking_done')
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {t('chat_messages.thinking_active')}
            <span style={{ display: 'inline-flex', gap: 2 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 3, height: 3, borderRadius: '50%', backgroundColor: 'var(--accent)',
                    display: 'inline-block', opacity: 0.6,
                    animation: `cursor-blink 1.2s steps(1) ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </span>
          </span>
        )}
      </button>
      {open && trimmed && (
        <div
          className="ui-thought-reveal"
          style={{
            marginTop: 4,
            padding: '6px 10px',
            borderLeft: '2px solid var(--border)',
            borderRadius: '0 6px 6px 0',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text2)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            backgroundColor: 'rgba(0,0,0,0.015)',
          }}
        >
          {trimmed}
        </div>
      )}
    </div>
  );
};
