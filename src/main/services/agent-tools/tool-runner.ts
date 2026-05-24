import type { AgentTool, AgentToolRegistry, ToolCallBlock, ToolResultBlock, ToolRunOptions } from './types';
import { normalizeAgentError } from '../agent-core/agent-errors';
import { localMsg } from '../agent-i18n/messages';
import { AgentToolEventRepository } from '../db/repositories/agent-tool-event.repo';
import {
  formatToolFailure,
  formatToolFailureProgress,
  formatToolStart,
  formatUnknownTool,
  isReadOnlyTool,
  truncateToolResult,
} from './tool-policy';
import { validateToolInput } from './tool-validation';

const toolEventRepo = new AgentToolEventRepository();
const AUDIT_INPUT_CHARS = 12_000;
const AUDIT_OUTPUT_CHARS = 8_000;

export class ToolRunner<TContext = unknown> {
  constructor(private readonly registry: AgentToolRegistry<TContext>) {}

  async runMany(
    calls: ToolCallBlock[],
    ctx: TContext,
    options: ToolRunOptions = {},
  ): Promise<ToolResultBlock[]> {
    const runOne = (call: ToolCallBlock) => this.runOne(call, ctx, options);
    const executionCalls = orderToolCallsForExecution(calls);

    const results: ToolResultBlock[] = [];
    for (let i = 0; i < executionCalls.length;) {
      const call = executionCalls[i];
      if (!isReadOnlyTool(this.registry.get(call.name))) {
        results.push(await runOne(call));
        i++;
        continue;
      }

      const readOnlyBatch: ToolCallBlock[] = [];
      while (i < executionCalls.length && isReadOnlyTool(this.registry.get(executionCalls[i].name))) {
        readOnlyBatch.push(executionCalls[i]);
        i++;
      }
      results.push(...await Promise.all(readOnlyBatch.map(runOne)));
    }

    const resultById = new Map(results.map((result) => [result.toolCallId, result]));
    return calls.map((call) => resultById.get(call.id) ?? {
      toolCallId: call.id,
      content:    formatUnknownTool(options.language, call.name, this.registry.names()),
      isError:    true,
    });
  }

  async runOne(
    call: ToolCallBlock,
    ctx: TContext,
    options: ToolRunOptions = {},
  ): Promise<ToolResultBlock> {
    const started = Date.now();
    options.onProgress?.(formatToolStart(options.language, call.name));
    options.onToolStart?.(call);

    const tool = this.registry.get(call.name);
    if (!tool) {
      options.onToolFailure?.(call, `unknown tool ${call.name}`, Date.now() - started);
      const result = {
        toolCallId: call.id,
        content:    formatUnknownTool(options.language, call.name, this.registry.names()),
        isError:    true,
      };
      this.audit(call, result, 'failed', Date.now() - started, options, `unknown tool ${call.name}`);
      return result;
    }

    const validation = validateToolInput(tool, call.input, options.language);
    if (!validation.ok) {
      const message = validation.message ?? 'invalid tool input';
      options.onToolFailure?.(call, message, Date.now() - started);
      options.onProgress?.(formatToolFailureProgress(options.language, message));
      const result = {
        toolCallId: call.id,
        content:    formatToolFailure(options.language, message),
        isError:    true,
      };
      this.audit(call, result, 'failed', Date.now() - started, options, message);
      return result;
    }

    try {
      const output = await this.executeWithRetry(tool, call, ctx, options);
      const formatted = tool.formatResult(output);
      const isSemanticError = isSuccessFalseOutput(output);
      const result = {
        toolCallId: call.id,
        content:    truncateToolResult(formatted, tool.maxResultChars, options.language),
        ...(isSemanticError ? { isError: true } : {}),
      };
      if (isSemanticError) {
        options.onToolFailure?.(call, result.content, Date.now() - started);
      } else {
        options.onToolComplete?.(call, result, Date.now() - started);
      }
      this.audit(call, result, isSemanticError ? 'failed' : 'completed', Date.now() - started, options, isSemanticError ? result.content : undefined);
      return result;
    } catch (err) {
      const normalized = normalizeAgentError(err, 'TOOL_FAILED', { toolName: call.name });
      options.onToolError?.(call.name, normalized.message);
      options.onToolFailure?.(call, normalized.message, Date.now() - started);
      options.onProgress?.(formatToolFailureProgress(options.language, normalized.message));
      const result = {
        toolCallId: call.id,
        content:    formatToolFailure(options.language, `${normalized.code}: ${normalized.message}`),
        isError:    true,
      };
      this.audit(call, result, 'failed', Date.now() - started, options, normalized.message);
      return result;
    }
  }

  /**
   * Execute a tool, retrying once with a short backoff for read-only tools that
   * throw a transient (non-abort) error. Read-only tools have no side effects, so
   * a retry is safe; write tools never retry to preserve idempotency. Semantic
   * failures (success:false) are returned by execute, not thrown, so they are
   * never retried here.
   */
  private async executeWithRetry(
    tool: AgentTool<TContext>,
    call: ToolCallBlock,
    ctx: TContext,
    options: ToolRunOptions,
  ): Promise<unknown> {
    const maxAttempts = tool.isReadOnly ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await tool.execute(call.input, ctx, call);
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts || isLikelyAbortError(err)) throw err;
        options.onProgress?.(formatToolRetry(options.language, call.name, attempt, maxAttempts));
        await delay(250 * attempt);
      }
    }
    throw lastError;
  }

  private audit(
    call: ToolCallBlock,
    result: ToolResultBlock,
    status: 'completed' | 'failed',
    durationMs: number,
    options: ToolRunOptions,
    errorMessage?: string,
  ): void {
    const audit = options.auditContext;
    if (!audit) return;
    try {
      toolEventRepo.create({
        sessionId: audit.sessionId,
        courseId: audit.courseId,
        nodeId: audit.nodeId,
        threadId: audit.threadId,
        agent: audit.agent,
        toolName: call.name,
        toolCallId: call.id,
        inputJson: safeJson(call.input, AUDIT_INPUT_CHARS),
        outputText: truncateAuditText(result.content, AUDIT_OUTPUT_CHARS),
        status,
        errorMessage,
        durationMs,
      });
    } catch {
      // Audit logging must never break tool execution.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError' || /\babort/i.test(err.message);
  return false;
}

function formatToolRetry(language: string | undefined, name: string, attempt: number, max: number): string {
  return localMsg(
    language,
    `\n[工具重试] ${name} 第 ${attempt}/${max - 1} 次失败，正在退避后重试…\n`,
    `\n[Tool retry] ${name} attempt ${attempt}/${max - 1} failed; backing off and retrying…\n`,
  );
}

function isSuccessFalseOutput(output: unknown): boolean {
  return Boolean(
    output
    && typeof output === 'object'
    && 'success' in output
    && (output as { success?: unknown }).success === false,
  );
}

export function orderToolCallsForExecution(calls: ToolCallBlock[]): ToolCallBlock[] {
  return [...calls].sort((a, b) => toolExecutionPriority(a.name) - toolExecutionPriority(b.name));
}

function toolExecutionPriority(name: string): number {
  if (name === 'update_profile') return 0;
  if (name === 'generate_dag') return 10;
  return 5;
}

function truncateAuditText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[...audit text truncated: ${text.length - maxChars} chars omitted...]\n\n${text.slice(-half)}`;
}

function sanitizeForAudit(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateAuditText(value, AUDIT_INPUT_CHARS);
  }
  if (Array.isArray(value)) return value.map(sanitizeForAudit);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeForAudit(item);
    return out;
  }
  return value;
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    return truncateAuditText(JSON.stringify(sanitizeForAudit(value), null, 2), maxChars);
  } catch {
    return truncateAuditText(String(value), maxChars);
  }
}
