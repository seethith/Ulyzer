import React from 'react';

/**
 * Renders a raw progress/reasoning trace (the "查看思路" content). Behavior is
 * intentionally unchanged from the original inline implementation — this is the
 * dev-facing full execution view and must stay faithful to the raw text.
 */
export const ProgressTraceContent: React.FC<{ progress: string; live?: boolean }> = ({ progress, live }) => {
  const lines = progress.split('\n');
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      fontSize: 11,
      color: 'var(--text3)',
      lineHeight: 1.55,
      maxHeight: live ? undefined : 440,
      overflowY: live ? 'visible' : 'auto',
      padding: live ? '6px 10px' : '8px 10px',
      borderLeft: '2px solid var(--border)',
      borderRadius: '0 6px 6px 0',
      backgroundColor: live ? 'rgba(0,0,0,0.015)' : 'transparent',
    }}>
      {lines.map((raw, index) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={index} style={{ height: 3 }} />;
        if (/^#{2,4}\s+/.test(line)) {
          return (
            <div
              key={index}
              style={{
                marginTop: index === 0 ? 0 : 8,
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--text2)',
                fontStyle: 'normal',
              }}
            >
              {line.replace(/^#{2,4}\s+/, '')}
            </div>
          );
        }
        if (/^\s*-\s+/.test(line)) {
          const depth = raw.startsWith('  ') ? 1 : 0;
          return (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns: '12px 1fr',
                columnGap: 4,
                marginLeft: depth * 12,
                fontStyle: 'normal',
                overflowWrap: 'anywhere',
              }}
            >
              <span>•</span>
              <span>{line.replace(/^\s*-\s+/, '')}</span>
            </div>
          );
        }
        if (/^\d+\.\s+/.test(line) || /^\s+\d+\.\s+/.test(raw)) {
          return (
            <div key={index} style={{ marginLeft: raw.startsWith('  ') ? 16 : 0, fontStyle: 'normal', overflowWrap: 'anywhere' }}>
              {line}
            </div>
          );
        }
        return (
          <div
            key={index}
            style={{
              whiteSpace: 'pre-wrap',
              fontStyle: 'normal',
              overflowWrap: 'anywhere',
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};
