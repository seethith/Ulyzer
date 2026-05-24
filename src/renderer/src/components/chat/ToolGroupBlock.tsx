import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toolPhaseLabel, type UiTool } from './toolActivity';

/**
 * Tool-call group with phase-aware labels (running → "正在生成纲要", done → "已生成纲要").
 * A single tool renders inline; multiple tools collapse behind a summary once done.
 * (Inspired by openhanako's ToolGroupBlock.)
 */
const STATUS_META: Record<UiTool['status'], { icon: string; color: string; spin?: boolean }> = {
  running:   { icon: '◐', color: 'var(--accent, #4c8bf5)', spin: true },
  completed: { icon: '✓', color: 'var(--success, #2e9e5b)' },
  failed:    { icon: '✗', color: 'var(--danger, #d9534f)' },
};

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const ToolLine: React.FC<{ tool: UiTool }> = ({ tool }) => {
  useTranslation(); // subscribe so the label re-localizes on language change
  const meta = STATUS_META[tool.status];
  const label = toolPhaseLabel(tool.name, tool.status === 'running' ? 'running' : 'done');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)' }}>
      <span style={{ color: meta.color, fontWeight: 700, ...(meta.spin ? { animation: 'spin 1.2s linear infinite' } : {}) }}>
        {meta.icon}
      </span>
      <span>{label}</span>
      {label !== tool.name && (
        <span style={{ color: 'var(--text3)', fontSize: 10, fontFamily: 'var(--font-mono, monospace)' }}>{tool.name}</span>
      )}
      {tool.durationMs !== undefined && (
        <span style={{ color: 'var(--text3)', fontSize: 10 }}>{formatDuration(tool.durationMs)}</span>
      )}
    </div>
  );
};

export const ToolGroupBlock: React.FC<{ tools: UiTool[]; defaultCollapsed?: boolean }> = ({ tools, defaultCollapsed = true }) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (tools.length === 0) return null;

  const allDone = tools.every((tl) => tl.status !== 'running');
  const failCount = tools.filter((tl) => tl.status === 'failed').length;
  const isSingle = tools.length === 1;

  // Single tool, or still running: show the lines directly (no collapse).
  if (isSingle || !allDone) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
        {tools.map((tool, i) => <ToolLine key={i} tool={tool} />)}
      </div>
    );
  }

  const summary = failCount > 0
    ? `${t('chat_messages.activity_tools', { count: tools.length })}（${t('chat_messages.activity_failed', { count: failCount })}）`
    : t('chat_messages.activity_tools', { count: tools.length });

  return (
    <div style={{ marginBottom: 6 }}>
      <button
        className="ui-pressable"
        onClick={() => setCollapsed((v) => !v)}
        style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 6,
          padding: '3px 9px', fontSize: 11, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: failCount > 0 ? 'var(--danger, #d9534f)' : 'var(--text3)',
        }}
      >
        <span style={{ color: 'var(--success, #2e9e5b)', fontWeight: 700 }}>✓</span>
        <span>{summary}</span>
        <span style={{ fontSize: 10, marginLeft: 2 }}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="ui-thought-reveal" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
          {tools.map((tool, i) => <ToolLine key={i} tool={tool} />)}
        </div>
      )}
    </div>
  );
};
