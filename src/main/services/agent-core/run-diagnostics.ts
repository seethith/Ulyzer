import type { DiagnosticRecord } from '@shared/types';

/**
 * RunDiagnostics — collects a single, unified, structured developer-diagnostic
 * trace for one agent run. Every emitter (outer loop, runner decisions, workflow
 * phases, generic notes) routes through here, so the "查看思路" view is consistent
 * across main tutor and node tutor.
 *
 * Records carry language-agnostic fields (the renderer localizes labels) plus
 * pre-localized `text` for narration. The records are streamed live and persisted
 * as JSON on the assistant message.
 */
export type EmitDiagnostic = (record: DiagnosticRecord) => void;

export class RunDiagnostics {
  private readonly startedAt = Date.now();
  private readonly records: DiagnosticRecord[] = [];

  constructor(private readonly emit: EmitDiagnostic) {}

  private push(record: Omit<DiagnosticRecord, 't'>): void {
    const full: DiagnosticRecord = { t: Date.now() - this.startedAt, ...record };
    this.records.push(full);
    try {
      this.emit(full);
    } catch {
      // Diagnostics are a display side-channel; never let emit failures affect the run.
    }
  }

  runStart(input: { model?: string; provider?: string; maxTurns?: number; hardMaxTurns?: number }): void {
    this.push({ kind: 'run.start', source: 'loop', ...input });
  }

  runDone(input: { runStatus: string; turns?: number; usageIn?: number; usageOut?: number; costCny?: number }): void {
    this.push({ kind: 'run.done', source: 'loop', ...input });
  }

  turn(input: {
    turn: number;
    stopReason?: string;
    model?: string;
    usageIn?: number;
    usageOut?: number;
    costCny?: number;
    cacheHitTokens?: number;
    ctxUsed?: number;
    ctxLimit?: number;
    messageCount?: number;
  }): void {
    this.push({ kind: 'turn', source: 'loop', ...input });
  }

  tool(input: {
    toolName: string;
    status: 'running' | 'completed' | 'failed';
    durationMs?: number;
    inputSummary?: string;
    resultSummary?: string;
    isError?: boolean;
  }): void {
    this.push({ kind: 'tool', source: 'loop', ...input });
  }

  decision(input: { decision: string; text?: string }): void {
    this.push({ kind: 'decision', source: 'agent', ...input });
  }

  compaction(input: { beforeMessages?: number; afterMessages?: number; text?: string }): void {
    this.push({ kind: 'compaction', source: 'agent', ...input });
  }

  workflowPhase(input: { workflowId?: string; phase?: string; status?: 'running' | 'completed' | 'failed'; text?: string }): void {
    this.push({ kind: 'workflow.phase', source: 'workflow', ...input });
  }

  /** Generic narration line (e.g. legacy progress() calls from workflows). */
  note(text: string, source: DiagnosticRecord['source'] = 'workflow'): void {
    if (!text.trim()) return;
    this.push({ kind: 'note', source, text });
  }

  error(text: string, source: DiagnosticRecord['source'] = 'loop'): void {
    this.push({ kind: 'error', source, text, isError: true });
  }

  snapshot(): DiagnosticRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
}
