/**
 * Parse a persisted progress trace into a compact tool-activity summary.
 *
 * The backend writes outer-loop tool traces as `[Tool Call] <name>` and
 * `[Tool Result] <name> completed|failed` (see tool-chat-loop's progress
 * formatters). For history messages only the raw progress text is kept, so we
 * recover the structured summary by parsing it — best-effort, while the full raw
 * trace stays available under "查看思路".
 */
import i18n from '../../i18n';

export interface ToolActivityItem {
  name: string;
  status: 'completed' | 'failed';
}

export function parseToolActivity(progress: string | undefined): ToolActivityItem[] {
  if (!progress) return [];
  const items: ToolActivityItem[] = [];
  const resultRe = /\[Tool Result\]\s+(\S+)\s+(completed|failed)/g;
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(progress)) !== null) {
    items.push({ name: match[1], status: match[2] === 'failed' ? 'failed' : 'completed' });
  }
  if (items.length === 0) {
    // Fall back to tool-call lines when results weren't captured (e.g. aborted mid-tool).
    const callRe = /\[Tool Call\]\s+(\S+)/g;
    while ((match = callRe.exec(progress)) !== null) {
      items.push({ name: match[1], status: 'completed' });
    }
  }
  return items;
}

// ── Friendly tool labels ────────────────────────────────────────────────────────
// Labels live in the i18n catalog under `tools.*`; unknown tools fall back to the
// raw name. Phase wrapping ("正在…/已…" vs "…ing…/…") uses `tools_phase.*`.

/** A normalized tool item for the tool-group block (works for both live and history). */
export interface UiTool {
  name: string;
  status: 'running' | 'completed' | 'failed';
  durationMs?: number;
}

/** History items (parsed from progress) → UiTool. */
export function activityItemsToUiTools(items: ToolActivityItem[]): UiTool[] {
  return items.map((item) => ({ name: item.name, status: item.status }));
}

/** Structured diagnostic tool records → UiTool (preferred over progress-text parsing). */
export function diagnosticsToTools(records: import('@shared/types').DiagnosticRecord[]): UiTool[] {
  return records
    .filter((r) => r.kind === 'tool' && r.toolName)
    .map((r) => ({
      name: r.toolName as string,
      status: r.status === 'failed' ? 'failed' : 'completed',
      durationMs: r.durationMs,
    }));
}

/**
 * Phase-aware label: "生成纲要" → 运行时"正在生成纲要"、完成"已生成纲要"
 * (English: "Generate outline" → "Generating outline…" / "Generate outline").
 * Unknown tools fall back to the raw name.
 */
export function toolPhaseLabel(name: string, phase: 'running' | 'done'): string {
  const label = i18n.t(`tools.${name}`, { defaultValue: '' });
  if (!label) return name;
  return i18n.t(phase === 'running' ? 'tools_phase.running' : 'tools_phase.done', { label });
}
