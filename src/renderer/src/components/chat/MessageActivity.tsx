import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiagnosticRecord } from '@shared/types';
import { ProgressTraceContent } from './ProgressTrace';
import { DiagnosticsView } from './DiagnosticsView';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { activityItemsToUiTools, diagnosticsToTools, parseToolActivity } from './toolActivity';

/**
 * History composer: renders a completed assistant message's pre-answer blocks in
 * canonical order — thinking → tools → (collapsible "查看思路" diagnostics).
 *
 * Prefers structured `diagnostics` (the unified dev trace) when present, and falls
 * back to parsing the legacy free-form `progress` text for older messages.
 */
export const MessageActivity: React.FC<{
  thinking?: string;
  progress?: string;
  diagnostics?: DiagnosticRecord[];
}> = ({ thinking, progress, diagnostics }) => {
  const { t } = useTranslation();
  const [rawOpen, setRawOpen] = useState(false);

  const hasDiagnostics = Boolean(diagnostics && diagnostics.length > 0);
  const tools = hasDiagnostics
    ? diagnosticsToTools(diagnostics ?? [])
    : progress ? activityItemsToUiTools(parseToolActivity(progress)) : [];
  const hasThinking = Boolean(thinking?.trim());
  const hasTrace = hasDiagnostics || Boolean(progress?.trim());

  if (!hasThinking && !hasTrace) return null;

  return (
    <div style={{ marginTop: 4, marginBottom: 4 }}>
      {hasThinking && <ThinkingBlock content={thinking ?? ''} sealed />}
      {tools.length > 0 && <ToolGroupBlock tools={tools} />}
      {hasTrace && (
        <div>
          <button
            className="ui-pressable"
            onClick={() => setRawOpen((v) => !v)}
            style={{
              background: 'none', border: 'none', padding: '2px 0', fontSize: 11,
              color: 'var(--text3)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 10 }}>{rawOpen ? '▾' : '▸'}</span>
            {t('chat_messages.view_reasoning')}
          </button>
          {rawOpen && (
            <div className="ui-thought-reveal" style={{ marginTop: 4 }}>
              {hasDiagnostics
                ? <DiagnosticsView records={diagnostics ?? []} />
                : <ProgressTraceContent progress={progress ?? ''} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
