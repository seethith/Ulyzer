import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiagnosticRecord } from '@shared/types';
import { toolPhaseLabel } from './toolActivity';

/**
 * Unified developer-diagnostic view ("查看思路"). Renders the structured
 * DiagnosticRecord[] emitted by every agent/workflow/loop in one consistent
 * format — bilingual labels (localized at view time), pre-localized narration
 * `text`, optional verbose tool I/O.
 */

function fmtElapsed(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
}
function fmtTokens(n?: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtCost(c?: number): string {
  return c && c > 0 ? `¥${c.toFixed(4)}` : '';
}
function fmtDur(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const SOURCE_COLOR: Record<string, string> = {
  loop: 'var(--text2)',
  workflow: 'var(--accent, #4c8bf5)',
  agent: '#b8860b',
};

interface RowParts {
  head: string;
  color: string;
  detail?: string;
  io?: { input?: string; result?: string };
}

function describe(record: DiagnosticRecord, isEn: boolean): RowParts {
  const color = record.isError ? 'var(--danger, #d9534f)' : SOURCE_COLOR[record.source ?? 'loop'] ?? 'var(--text2)';
  switch (record.kind) {
    case 'run.start':
      return { head: `▶ ${isEn ? 'Run' : '开始'} · ${record.provider ?? ''}/${record.model ?? ''} · ${isEn ? 'turns' : '轮次'} ${record.maxTurns}/${record.hardMaxTurns}`, color };
    case 'run.done':
      return { head: `■ ${record.runStatus} · ${isEn ? 'total' : '累计'} in ${fmtTokens(record.usageIn)} out ${fmtTokens(record.usageOut)} ${fmtCost(record.costCny)}`, color };
    case 'turn':
      return {
        head: `${isEn ? 'Turn' : '第'} ${(record.turn ?? 0) + 1}${isEn ? '' : ' 轮'} · ${record.stopReason ?? ''} · in ${fmtTokens(record.usageIn)} out ${fmtTokens(record.usageOut)} ${fmtCost(record.costCny)} · ${isEn ? 'msgs' : '消息'} ${record.messageCount ?? 0}`,
        color: 'var(--text2)',
      };
    case 'tool':
      return {
        head: `${record.status === 'failed' ? '✗' : '✓'} ${toolPhaseLabel(record.toolName ?? '', 'done')} (${record.toolName}) · ${fmtDur(record.durationMs)}`,
        color: record.status === 'failed' ? 'var(--danger, #d9534f)' : 'var(--success, #2e9e5b)',
        io: { input: record.inputSummary, result: record.resultSummary },
      };
    case 'decision':
      return { head: `⚑ ${isEn ? 'decision' : '决策'} · ${record.decision}`, color: '#b8860b', detail: record.text };
    case 'compaction':
      return { head: `↯ ${isEn ? 'compaction' : '上下文压缩'} · ${isEn ? 'msgs' : '消息'} ${record.beforeMessages ?? '?'}→${record.afterMessages ?? '?'}`, color: '#b8860b', detail: record.text };
    case 'workflow.phase':
      return { head: `⌁ ${record.workflowId ?? ''} · ${record.phase ?? ''}`, color: SOURCE_COLOR.workflow, detail: record.text };
    case 'error':
      return { head: `✗ ${record.text ?? (isEn ? 'error' : '错误')}`, color: 'var(--danger, #d9534f)' };
    case 'note':
    default:
      return { head: record.text ?? '', color: 'var(--text3)' };
  }
}

const Row: React.FC<{ record: DiagnosticRecord; verbose: boolean }> = ({ record, verbose }) => {
  const { i18n } = useTranslation();
  const isEn = i18n.language?.startsWith('en') ?? false;
  const parts = describe(record, isEn);
  if (!parts.head && !parts.detail) return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--text3)', opacity: 0.6, fontFamily: 'var(--font-mono, monospace)', flexShrink: 0, minWidth: 46, textAlign: 'right' }}>
        {fmtElapsed(record.t)}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: parts.color, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{parts.head}</div>
        {parts.detail && (
          <div style={{ color: 'var(--text3)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 1 }}>{parts.detail}</div>
        )}
        {verbose && parts.io && (parts.io.input || parts.io.result) && (
          <div style={{ marginTop: 2, paddingLeft: 8, borderLeft: '1px solid var(--border)', color: 'var(--text3)', fontFamily: 'var(--font-mono, monospace)', fontSize: 10 }}>
            {parts.io.input && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>in: {parts.io.input}</div>}
            {parts.io.result && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>out: {parts.io.result}</div>}
          </div>
        )}
      </div>
    </div>
  );
};

export const DiagnosticsView: React.FC<{ records: DiagnosticRecord[]; live?: boolean }> = ({ records, live }) => {
  const { t } = useTranslation();
  const [verbose, setVerbose] = useState(false);
  if (records.length === 0) return null;
  return (
    <div style={{
      borderLeft: '2px solid var(--border)',
      borderRadius: '0 6px 6px 0',
      padding: '6px 10px',
      backgroundColor: live ? 'rgba(0,0,0,0.015)' : 'transparent',
      fontSize: 11,
      lineHeight: 1.55,
      maxHeight: live ? undefined : 460,
      overflowY: live ? 'visible' : 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <button
          className="ui-pressable"
          onClick={() => setVerbose((v) => !v)}
          style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 4,
            padding: '1px 7px', fontSize: 10, color: 'var(--text3)', cursor: 'pointer',
          }}
        >
          {verbose ? t('chat_messages.diag_verbose_on') : t('chat_messages.diag_verbose_off')}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {records.map((record, i) => <Row key={i} record={record} verbose={verbose} />)}
      </div>
    </div>
  );
};
