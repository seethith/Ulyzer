import type { LLMProvider, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import type { ImageAttachment, PdfAttachment, ToolCallBlock, ToolResultBlock, ToolStreamResponse, ToolTurnMessage } from '../llm/adapter';
import { ToolRunner } from '../agent-tools/tool-runner';
import type { AgentToolRegistry, ToolRunOptions } from '../agent-tools/types';
import type { AgentRunContext } from './run-context';
import type { RunDiagnostics } from './run-diagnostics';
import { normalizeAgentError } from './agent-errors';
import { localMsg, message } from '../agent-i18n/messages';

export interface ToolChatLoopResult {
  completed: boolean;
  messages: ToolTurnMessage[];
  usage: TokenUsage;
}

export type ToolChatLoopControl = 'continue' | 'complete' | 'fail';

export interface ToolChatLoopRunContext {
  readonly usage: TokenUsage;
  readonly isAborted: boolean;
  addUsage(usage: Partial<TokenUsage> | undefined, source?: string): TokenUsage;
  chunk(chunk: string): void;
  fail(error: unknown): void;
  complete(usage?: Partial<TokenUsage>): void;
}

export interface ToolChatLoopOptions<TContext> {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  messages: ToolTurnMessage[];
  toolRegistry: AgentToolRegistry<TContext>;
  toolContext: TContext;
  runContext: ToolChatLoopRunContext | AgentRunContext;
  maxTurns: number;
  /** Absolute turn ceiling (defaults to maxTurns). The completion gate may push past maxTurns up to here. */
  hardMaxTurns?: number;
  maxTokens: number;
  /** Default max_tokens continuation attempts for plain chat loops without a custom handler. */
  maxOutputContinuations?: number;
  signal?: AbortSignal;
  language?: string;
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  thinkingBudget?: number;
  emitTerminalEvent?: boolean;
  onChunk?: (chunk: string) => void;
  onTurnStart?: (turn: number, messages: ToolTurnMessage[]) => void | Promise<void>;
  beforeTurn?: (
    turn: number,
    messages: ToolTurnMessage[],
  ) => Promise<ToolTurnMessage[] | void> | ToolTurnMessage[] | void;
  afterLlmResponse?: (
    turn: number,
    response: ToolStreamResponse,
    messages: ToolTurnMessage[],
  ) => Promise<ToolTurnMessage[] | void> | ToolTurnMessage[] | void;
  onMaxTokens?: (
    turn: number,
    response: ToolStreamResponse,
    messages: ToolTurnMessage[],
  ) => Promise<ToolChatLoopControl | void> | ToolChatLoopControl | void;
  onEndTurn?: (
    turn: number,
    response: ToolStreamResponse,
    messages: ToolTurnMessage[],
  ) => Promise<ToolChatLoopControl | void> | ToolChatLoopControl | void;
  /**
   * Completion gate: consulted when the model emits `end_turn` and no `onEndTurn`
   * decision forced termination. Return a nudge string to inject (as a role-valid
   * user message after the assistant turn) and force one more turn; return
   * undefined to let the loop finish. Used to keep working while tasks are open.
   */
  shouldContinueAtEndTurn?: (turn: number) => { nudge: string } | undefined;
  /** Per-turn checkpoint hook fired after tool results / assistant turn settle. */
  onCheckpoint?: (
    turn: number,
    messages: ToolTurnMessage[],
  ) => void | Promise<void>;
  beforeToolExecution?: (
    turn: number,
    response: ToolStreamResponse,
    messages: ToolTurnMessage[],
  ) => Promise<ToolChatLoopControl | void> | ToolChatLoopControl | void;
  afterToolResults?: (
    turn: number,
    response: ToolStreamResponse,
    toolResults: ToolResultBlock[],
    messages: ToolTurnMessage[],
  ) => Promise<ToolChatLoopControl | void> | ToolChatLoopControl | void;
  onLlmError?: (
    error: unknown,
    turn: number,
    messages: ToolTurnMessage[],
  ) => Promise<ToolChatLoopControl | void> | ToolChatLoopControl | void;
  onMaxTurns?: (messages: ToolTurnMessage[]) => void | Promise<void>;
  onLlmFailure?: (error: Error) => void;
  toolRunOptions?: Omit<ToolRunOptions, 'language'>;
  onThinkingChunk?: (chunk: string) => void;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function toolCallSignature(call: ToolCallBlock): string {
  return `${call.name}:${stableStringify(call.input)}`;
}

function emitProgress(runContext: ToolChatLoopRunContext | AgentRunContext, message: string): void {
  const progress = (runContext as { progress?: (chunk: string) => void }).progress;
  if (typeof progress === 'function') progress.call(runContext, message);
}

function formatRepeatedToolFailureGuard(language: string | undefined, call: ToolCallBlock): string {
  return localMsg(
    language,
    `已阻止重复失败的工具调用：${call.name}。同一参数已经失败 2 次，请不要继续用同样参数重试；请改用工具结果中已有的信息、换一个有效路径，或向用户说明当前限制。`,
    `Blocked repeated failing tool call: ${call.name}. The same arguments already failed twice; do not retry them again. Use the available tool results, try a valid path, or explain the limitation to the user.`,
  );
}

function continuationInstruction(language?: string): string {
  return localMsg(
    language,
    '请从上一条助手消息中断的地方继续，不要重复已经写过的内容。保持相同语言、结构和意图。',
    'Please continue exactly from where the previous assistant message stopped. Do not repeat content already written. Keep the same language, structure, and intent.',
  );
}

/**
 * Shared outer chat/tool loop for tutor agents.
 *
 * Agent-specific code prepares prompts, initial messages and tool context; this
 * loop owns the repeated streamWithTools -> execute tools -> append results
 * cycle, plus usage and terminal stream events.
 */
export async function runToolChatLoop<TContext>(
  options: ToolChatLoopOptions<TContext>,
): Promise<ToolChatLoopResult> {
  let messages = options.messages;
  const tools = options.toolRegistry.buildToolDefs(options.language);
  const toolRunner = new ToolRunner(options.toolRegistry);
  const emitTerminal = options.emitTerminalEvent !== false;
  const maxOutputContinuations = Math.max(0, options.maxOutputContinuations ?? 6);
  let outputContinuationCount = 0;
  const hardMaxTurns = Math.max(options.maxTurns, options.hardMaxTurns ?? options.maxTurns);
  const failedToolSignatures = new Map<string, number>();
  const baseOnChunk = options.onChunk ?? ((chunk: string) => options.runContext.chunk(chunk));
  // Structured diagnostics live on AgentRunContext; the material inner loop has none (no-op).
  const diag = (options.runContext as { diagnostics?: RunDiagnostics }).diagnostics;
  const finish = (completed: boolean): ToolChatLoopResult => {
    if (completed && emitTerminal) options.runContext.complete();
    return { completed, messages, usage: options.runContext.usage };
  };

  for (let turn = 0; turn < hardMaxTurns + outputContinuationCount; turn++) {
    if (options.runContext.isAborted) {
      return { completed: false, messages, usage: options.runContext.usage };
    }

    await options.onTurnStart?.(turn, messages);

    const preparedMessages = await options.beforeTurn?.(turn, messages);
    if (preparedMessages) messages = preparedMessages;

    // Accumulate this turn's streamed text so an abort mid-stream can persist the
    // partial assistant message into the checkpoint (opencode keeps partial parts).
    let currentTurnText = '';

    let response: ToolStreamResponse;
    try {
      response = await LLMAdapter.streamWithTools({
        provider:     options.provider,
        model:        options.model,
        systemPrompt: options.systemPrompt,
        messages,
        tools,
        maxTokens:    options.maxTokens,
        signal:       options.signal,
        imageAttachments: turn === 0 ? options.imageAttachments : undefined,
        pdfAttachments:   turn === 0 ? options.pdfAttachments : undefined,
        thinkingBudget: options.thinkingBudget,
        onChunk:      (chunk) => { currentTurnText += chunk; baseOnChunk(chunk); },
        onThinkingChunk: options.onThinkingChunk ?? ((chunk) => {
          if ('thinking' in options.runContext && typeof options.runContext.thinking === 'function') {
            options.runContext.thinking(chunk);
          }
        }),
      });
    } catch (err) {
      const decision = await options.onLlmError?.(err, turn, messages);
      if (decision === 'continue') continue;
      if (decision === 'complete') return finish(true);
      // Aborted mid-stream: preserve any partial text and checkpoint so a resume
      // picks up from here, then return without a terminal failure event.
      if (options.runContext.isAborted) {
        if (currentTurnText.trim()) {
          messages.push({ role: 'assistant', text: currentTurnText, toolCalls: [] });
        }
        await options.onCheckpoint?.(turn, messages);
        return { completed: false, messages, usage: options.runContext.usage };
      }
      const normalized = normalizeAgentError(err, 'LLM_FAILED');
      if (emitTerminal) options.runContext.fail(normalized);
      options.onLlmFailure?.(normalized);
      return { completed: false, messages, usage: options.runContext.usage };
    }

    options.runContext.addUsage(response.usage);
    messages.push(response.assistantTurn);
    diag?.turn({
      turn,
      stopReason: response.stopReason,
      model: options.model,
      usageIn: response.usage?.inputTokens,
      usageOut: response.usage?.outputTokens,
      costCny: response.usage?.costCny,
      cacheHitTokens: response.usage?.inputCacheHitTokens,
      messageCount: messages.length,
    });

    const afterMessages = await options.afterLlmResponse?.(turn, response, messages);
    if (afterMessages) messages = afterMessages;

    if (response.stopReason === 'max_tokens') {
      const decision = await options.onMaxTokens?.(turn, response, messages);
      if (decision === 'continue') continue;
      if (decision === 'complete') return finish(true);
      if (decision === 'fail') return { completed: false, messages, usage: options.runContext.usage };
      if (options.onMaxTokens) break;

      if (outputContinuationCount < maxOutputContinuations) {
        outputContinuationCount += 1;
        emitProgress(
          options.runContext,
          message('outputContinuation', options.language, {
            attempt: outputContinuationCount,
            max: maxOutputContinuations,
          }),
        );
        messages.push({ role: 'user', content: continuationInstruction(options.language) });
        continue;
      }

      emitProgress(options.runContext, message('outputContinuationLimit', options.language));
      return finish(true);
    }

    if (response.stopReason === 'end_turn') {
      const decision = await options.onEndTurn?.(turn, response, messages);
      if (decision === 'continue') continue;
      if (decision === 'fail') return { completed: false, messages, usage: options.runContext.usage };
      if (!decision) {
        // Completion gate: keep working while tasks remain open (within hardMaxTurns).
        const cont = options.shouldContinueAtEndTurn?.(turn);
        if (cont && turn + 1 < hardMaxTurns + outputContinuationCount) {
          diag?.decision({ decision: 'completion_gate_continue', text: cont.nudge });
          messages.push({ role: 'user', content: cont.nudge });
          await options.onCheckpoint?.(turn, messages);
          continue;
        }
      }
      await options.onCheckpoint?.(turn, messages);
      return finish(true);
    }

    if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) return finish(true);

    const beforeToolDecision = await options.beforeToolExecution?.(turn, response, messages);
    if (beforeToolDecision === 'continue') continue;
    if (beforeToolDecision === 'complete') return finish(true);
    if (beforeToolDecision === 'fail') return { completed: false, messages, usage: options.runContext.usage };

    const guardResults = new Map<string, ToolResultBlock>();
    const runnableCalls: ToolCallBlock[] = [];
    for (const call of response.toolCalls) {
      const signature = toolCallSignature(call);
      const failedCount = failedToolSignatures.get(signature) ?? 0;
      if (failedCount >= 2) {
        guardResults.set(call.id, {
          toolCallId: call.id,
          content: formatRepeatedToolFailureGuard(options.language, call),
          isError: true,
        });
        continue;
      }
      runnableCalls.push(call);
    }

    const executedResults = await toolRunner.runMany(runnableCalls, options.toolContext, {
      language: options.language,
      ...options.toolRunOptions,
    });
    const executedResultById = new Map(executedResults.map((result) => [result.toolCallId, result]));
    const toolResults = response.toolCalls.map((call) =>
      guardResults.get(call.id)
      ?? executedResultById.get(call.id)
      ?? {
        toolCallId: call.id,
        content: formatRepeatedToolFailureGuard(options.language, call),
        isError: true,
      });
    for (const call of response.toolCalls) {
      const result = toolResults.find((candidate) => candidate.toolCallId === call.id);
      if (!result) continue;
      const signature = toolCallSignature(call);
      if (result.isError) {
        failedToolSignatures.set(signature, (failedToolSignatures.get(signature) ?? 0) + 1);
      } else {
        failedToolSignatures.delete(signature);
      }
    }
    messages.push({ role: 'tool_results', results: toolResults });

    const decision = await options.afterToolResults?.(turn, response, toolResults, messages);
    if (decision === 'complete') return finish(true);
    if (decision === 'fail') return { completed: false, messages, usage: options.runContext.usage };
    // The default tool-use path continues to the next LLM turn.
    await options.onCheckpoint?.(turn, messages);
  }

  const maxTurnsMessage = message('maxTurnsExceeded', options.language);
  emitProgress(options.runContext, `\n⚠️ ${maxTurnsMessage}\n`);
  if (!options.onMaxTurns && emitTerminal) options.runContext.chunk(`\n\n${maxTurnsMessage}`);
  await options.onMaxTurns?.(messages);
  if (options.onMaxTurns) return { completed: false, messages, usage: options.runContext.usage };
  return finish(true);
}
