import type { FileGeneratedPayload, TokenUsage } from '@shared/types';
import type { AgentRunContext } from '../agent-core/run-context';
import type { DagGeneratedPayload } from '../agent-core/agent-events';
import type { AgentErrorCode } from '../agent-core/agent-errors';
import { AgentError, abortError, normalizeAgentError } from '../agent-core/agent-errors';
import type { WorkflowId, WorkflowRunOptions } from './workflow-types';

export const WORKFLOW_PHASES = [
  'prepare_context',
  'retrieve_sources',
  'generate_content',
  'verify',
  'persist_artifacts',
  'emit_result',
] as const;

export type WorkflowPhase = typeof WORKFLOW_PHASES[number];
export type WorkflowPhaseStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export class WorkflowLifecycleError extends AgentError {
  constructor(
    message: string,
    readonly workflowId: WorkflowId,
    readonly phase?: WorkflowPhase,
    code: AgentErrorCode = 'WORKFLOW_FAILED',
    retryable = false,
    readonly cause?: unknown,
  ) {
    super(code, message, retryable, { workflowId, ...(phase ? { phase } : {}) }, cause);
    this.name = 'WorkflowLifecycleError';
  }
}

export interface WorkflowLifecycleOptions {
  workflowId: WorkflowId;
  context?: AgentRunContext;
}

export class WorkflowLifecycle {
  private readonly phaseStatus = new Map<WorkflowPhase, WorkflowPhaseStatus>(
    WORKFLOW_PHASES.map((phase) => [phase, 'pending']),
  );
  private activePhase: WorkflowPhase | undefined;

  constructor(private readonly options: WorkflowLifecycleOptions) {}

  get workflowId(): WorkflowId {
    return this.options.workflowId;
  }

  get context(): AgentRunContext | undefined {
    return this.options.context;
  }

  getPhaseStatus(phase: WorkflowPhase): WorkflowPhaseStatus {
    return this.phaseStatus.get(phase) ?? 'pending';
  }

  start(phase: WorkflowPhase): void {
    this.throwIfAborted();
    const status = this.getPhaseStatus(phase);
    if (status === 'in_progress' || status === 'completed' || status === 'skipped') return;
    this.activePhase = phase;
    this.phaseStatus.set(phase, 'in_progress');
  }

  complete(phase: WorkflowPhase, _artifactIds: string[] = []): void {
    const status = this.getPhaseStatus(phase);
    if (status === 'completed' || status === 'skipped') return;
    if (status === 'pending') this.start(phase);
    this.phaseStatus.set(phase, 'completed');
    if (this.activePhase === phase) this.activePhase = undefined;
  }

  skip(phase: WorkflowPhase): void {
    const status = this.getPhaseStatus(phase);
    if (status === 'completed' || status === 'skipped') return;
    this.phaseStatus.set(phase, 'skipped');
    if (this.activePhase === phase) this.activePhase = undefined;
  }

  fail(error: unknown, phase: WorkflowPhase | undefined = this.activePhase): WorkflowLifecycleError {
    const normalized = this.toError(error, phase);
    const failedPhase = phase ?? normalized.phase;
    if (failedPhase) {
      if (this.getPhaseStatus(failedPhase) === 'failed') return normalized;
      this.phaseStatus.set(failedPhase, 'failed');
      if (this.activePhase === failedPhase) this.activePhase = undefined;
    }
    return normalized;
  }

  progress(message: string): void {
    this.options.context?.progress(message);
  }

  addUsage(usage: Partial<TokenUsage> | undefined, source?: string): TokenUsage {
    return this.options.context?.addUsage(usage, source) ?? {
      inputTokens: usage?.inputTokens ?? (usage?.inputCacheHitTokens ?? 0) + (usage?.inputCacheMissTokens ?? 0),
      outputTokens: usage?.outputTokens ?? 0,
      costCny: usage?.costCny ?? 0,
      ...(usage?.inputCacheHitTokens ? { inputCacheHitTokens: usage.inputCacheHitTokens } : {}),
      ...(usage?.inputCacheMissTokens ? { inputCacheMissTokens: usage.inputCacheMissTokens } : {}),
      ...(usage?.estimated ? { estimated: true } : {}),
    };
  }

  fileGenerated(payload: Omit<FileGeneratedPayload, 'sessionId' | 'usage'> & { usage?: TokenUsage }): void {
    this.options.context?.fileGenerated(payload);
  }

  dagGenerated(payload: Omit<DagGeneratedPayload, 'sessionId' | 'usage'> & { usage?: TokenUsage }): void {
    this.options.context?.dagGenerated(payload);
  }

  throwIfAborted(): void {
    if (this.options.context?.isAborted) throw this.fail(abortError());
  }

  async runPhase<T>(
    phase: WorkflowPhase,
    fn: () => Promise<T> | T,
    artifactIds: (result: T) => string[] = () => [],
  ): Promise<T> {
    this.start(phase);
    try {
      const result = await fn();
      this.complete(phase, artifactIds(result));
      return result;
    } catch (err) {
      throw this.fail(err, phase);
    }
  }

  private toError(error: unknown, phase?: WorkflowPhase): WorkflowLifecycleError {
    if (error instanceof WorkflowLifecycleError) return error;
    const normalized = normalizeAgentError(error, 'WORKFLOW_FAILED', {
      workflowId: this.workflowId,
      ...(phase ? { phase } : {}),
    });
    return new WorkflowLifecycleError(
      normalized.message,
      this.workflowId,
      phase,
      normalized.code,
      normalized.retryable,
      error,
    );
  }
}

export function createWorkflowLifecycle(
  workflowId: WorkflowId,
  options: WorkflowRunOptions,
): WorkflowLifecycle {
  return new WorkflowLifecycle({
    workflowId,
    context: options.context,
  });
}
