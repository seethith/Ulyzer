import type { AgentLoopConfig } from './run-state';
import type { AgentRequest } from './orchestrator';
import type { AgentRunContext } from './run-context';
import { ContextWindowManager } from '../agent-context/context-window-manager';
import { compressToolHistory } from '../agent-context/compactor';
import { runGraduatedCompaction, truncateHeadTail } from '../agent-context/compaction-ladder';
import { isCommand, resolveCommand, type CommandContext } from '../commands/registry';
import type { ToolDef, ToolTurnMessage } from '../llm/adapter';
import type { AgentToolRegistry } from '../agent-tools/types';
import { runToolChatLoop, type ToolChatLoopOptions, type ToolChatLoopResult } from './tool-chat-loop';
import { resolveModelCapability, resolveThinkingBudget } from '../llm/model-capabilities';
import { ChatThreadContextRepository } from '../db/repositories/chat-thread-context.repo';
import { AgentRunStateRepository } from '../db/repositories/agent-run-state.repo';
import type { TaskListSnapshot } from './task-list';
import {
  resolveContextWindowBudget,
  type ContextTaskKind,
  type ContextWindowBudget,
} from '../agent-context/context-window-budget';
import { tokenMeter } from '../agent-context/token-meter';
import { classifyError } from '../llm/errors';
import { localMsg, message } from '../agent-i18n/messages';

export interface ChatAgentRunSpec<TContext> {
  systemPrompt: string;
  initialMessages: ToolTurnMessage[];
  toolRegistry: AgentToolRegistry<TContext>;
  toolContext: TContext;
  loopConfig: AgentLoopConfig;
  contextTaskKind?: ContextTaskKind;
  toolRunOptions?: ToolChatLoopOptions<TContext>['toolRunOptions'];
  beforeTurn?: ToolChatLoopOptions<TContext>['beforeTurn'];
  afterLlmResponse?: ToolChatLoopOptions<TContext>['afterLlmResponse'];
  onEndTurn?: ToolChatLoopOptions<TContext>['onEndTurn'];
  onChunk?: ToolChatLoopOptions<TContext>['onChunk'];
  beforeToolExecution?: ToolChatLoopOptions<TContext>['beforeToolExecution'];
  afterToolResults?: ToolChatLoopOptions<TContext>['afterToolResults'];
}

export interface RunChatAgentOptions<TContext> {
  req: AgentRequest;
  runContext: AgentRunContext;
  commandContext: CommandContext;
  buildRunSpec: (req: AgentRequest) => Promise<ChatAgentRunSpec<TContext>> | ChatAgentRunSpec<TContext>;
}

const contextWindowManager = new ContextWindowManager();
const threadContextRepo = new ChatThreadContextRepository();
const runStateRepo = new AgentRunStateRepository();

/** Max backoff-retries for transient LLM errors (rate limit / network) per run. */
const MAX_TRANSIENT_LLM_RETRIES = 3;

const TASK_REMINDER_OPEN = '\n\n<!--task-list-reminder-->\n';
const TASK_REMINDER_CLOSE = '\n<!--/task-list-reminder-->';
const TASK_REMINDER_RE = /\n\n<!--task-list-reminder-->[\s\S]*?<!--\/task-list-reminder-->/g;

function stripTaskReminder(text: string): string {
  return text.includes('<!--task-list-reminder-->') ? text.replace(TASK_REMINDER_RE, '') : text;
}

/**
 * Keep at most one live task-list reminder in the message history, attached to the
 * latest user-side message so the model sees it right before it responds.
 *
 * Why attach rather than push a fresh message: providers (e.g. Anthropic) reject
 * two consecutive user-role messages, and the loop's last message at this point is
 * usually a `tool_results` turn (user-role). So we strip any prior reminder, then
 * append the current one to the last tool_results/user message in place. The
 * end_turn completion gate handles its own nudge after an assistant turn, where a
 * standalone user message is role-valid.
 */
function injectTaskListReminder(
  messages: ToolTurnMessage[],
  render: string,
  hasOpenItems: boolean,
  language?: string,
): void {
  // Always strip stale reminders first so nothing accumulates.
  for (const msg of messages) {
    if (msg.role === 'user') {
      msg.content = stripTaskReminder(msg.content);
    } else if (msg.role === 'tool_results') {
      for (const result of msg.results) result.content = stripTaskReminder(result.content);
    }
  }
  if (!render) return;

  const nudge = hasOpenItems
    ? localMsg(
        language,
        '\n（任务清单仍有未完成项：请继续推进，不要在未完成前结束本轮；完成或放弃某项时调用 write_todos 更新状态。）',
        '\n(The task list still has open items: keep going and do not end this turn before they are done; call write_todos to update statuses as items complete or are dropped.)',
      )
    : '';
  const block = `${TASK_REMINDER_OPEN}${render}${nudge}${TASK_REMINDER_CLOSE}`;

  const last = messages.at(-1);
  if (!last) return;
  if (last.role === 'tool_results' && last.results.length > 0) {
    const lastResult = last.results[last.results.length - 1];
    lastResult.content = `${lastResult.content}${block}`;
  } else if (last.role === 'user') {
    last.content = `${last.content}${block}`;
  } else {
    // Last is an assistant turn (e.g. turn 0 ack); a fresh user message is role-valid here.
    messages.push({ role: 'user', content: block.trimStart() });
  }
}

/** Append user-authored text without ever creating two consecutive user-role messages. */
function appendUserText(messages: ToolTurnMessage[], text: string): void {
  if (!text) return;
  const last = messages.at(-1);
  if (!last || last.role === 'assistant') {
    messages.push({ role: 'user', content: text });
    return;
  }
  if (last.role === 'user') {
    last.content = `${last.content}\n\n${text}`;
    return;
  }
  // tool_results — attach to the final result block to stay role-valid.
  const result = last.results[last.results.length - 1];
  if (result) result.content = `${result.content}\n\n${text}`;
  else messages.push({ role: 'user', content: text });
}

/** Parse a `/resume [extra instruction]` runtime command. */
function parseResumeCommand(userMessage: string): { extra: string } | null {
  const match = /^\/resume\b\s*([\s\S]*)$/i.exec(userMessage.trim());
  return match ? { extra: match[1].trim() } : null;
}

/**
 * Implicit auto-resume only fires for recent interruptions, so a normal follow-up
 * message doesn't drag the user back into a task they abandoned long ago. Explicit
 * `/resume` bypasses this window.
 */
const RESUME_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function isCheckpointFresh(updatedAt: string): boolean {
  const parsed = Date.parse(`${updatedAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return true; // unparseable timestamp shouldn't block resume
  return Date.now() - parsed <= RESUME_FRESHNESS_MS;
}

function parseSnapshotMessages(json: string): ToolTurnMessage[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as ToolTurnMessage[]) : [];
  } catch {
    return [];
  }
}

function parseSnapshotTaskList(json: string): TaskListSnapshot | null {
  try {
    return JSON.parse(json) as TaskListSnapshot;
  } catch {
    return null;
  }
}

/** Mark the run-state row terminal once the loop settles (best-effort, thread-scoped). */
function finalizeRunState(
  threadId: string | undefined,
  sessionId: string,
  isAborted: boolean,
  result: ToolChatLoopResult,
): void {
  if (!threadId) return;
  try {
    if (result.completed) {
      // A clean finish clears the thread's resumable state, so a later normal
      // message starts fresh instead of auto-resuming a task that's already done.
      runStateRepo.deleteByThread(threadId);
    } else {
      // Interrupted/failed: keep this run as the thread's single resumable checkpoint.
      runStateRepo.markTerminal(sessionId, isAborted ? 'aborted' : 'failed');
    }
  } catch {
    // Checkpoint bookkeeping is best-effort; never fail a run over it.
  }
}

/** Compact a tool input/output value to a short string for the diagnostics trace. */
function diagSummary(value: unknown, max: number): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else { try { text = JSON.stringify(value); } catch { text = String(value); } }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingCurrentMessage(messages: AgentRequest['messages'], currentUserMessage: string): AgentRequest['messages'] {
  const list = [...(messages ?? [])];
  const last = list.at(-1);
  if (last?.role === 'user' && last.content.trim() === currentUserMessage.trim()) list.pop();
  return list;
}

function hydrateRequestMessages(req: AgentRequest): AgentRequest {
  if (!req.threadId) {
    return { ...req, messages: trimTrailingCurrentMessage(req.messages, req.userMessage) };
  }
  try {
    const rows = threadContextRepo.listMessages(req.threadId);
    if (rows.at(-1)?.role === 'user' && rows.at(-1)?.content.trim() === req.userMessage.trim()) rows.pop();
    return {
      ...req,
      messages: rows.slice(-80).map((row) => ({ role: row.role, content: row.content })),
    };
  } catch {
    return { ...req, messages: trimTrailingCurrentMessage(req.messages, req.userMessage) };
  }
}

async function buildManagedToolMessages<TContext>(
  req: AgentRequest,
  spec: ChatAgentRunSpec<TContext>,
  runContext: AgentRunContext,
): Promise<ToolTurnMessage[]> {
  const prepared = await contextWindowManager.prepareMessages({
    modelProvider: req.provider,
    model: req.model,
    courseId: req.courseId,
    nodeId: req.nodeId,
    threadId: req.threadId,
    agent: req.type,
    language: req.language,
    thinkingMode: req.thinkingMode,
    taskKind: spec.contextTaskKind ?? 'chat',
    systemPrompt: spec.systemPrompt,
    initialMessages: spec.initialMessages,
    tools: spec.toolRegistry.buildToolDefs(req.language),
    fallbackMessages: req.messages,
    currentUserMessage: req.userMessage,
    imageAttachments: req.imageAttachments,
    pdfAttachments: req.pdfAttachments,
    sessionId: req.sessionId,
    signal: req.signal,
    onProgress: (msg) => runContext.progress(`${msg}\n`),
    onUsage: (usage) => { runContext.addUsage(usage); },
  });
  return prepared.messages;
}

const CHAT_MIN_OUTPUT_TOKENS = 16_000;
const CHAT_TARGET_OUTPUT_TOKENS = 32_000;

function resolveChatOutputTokens(provider: string, model: string, configuredMax: number): number {
  const capability = resolveModelCapability(provider, model);
  const desired = Math.max(configuredMax, CHAT_MIN_OUTPUT_TOKENS);
  return Math.max(1024, Math.min(Math.max(desired, Math.min(CHAT_TARGET_OUTPUT_TOKENS, capability.maxOutputTokens)), capability.maxOutputTokens));
}

/**
 * Wrap an agent's own `beforeTurn` with a proactive context-window safety net.
 *
 * The agent's beforeTurn runs first (e.g. sub-tutor's count-based collapse). Then,
 * before each LLM turn after the first, we estimate the live input tokens and — if
 * still at/over the budget's `collapseAt` threshold (~90% of the input budget) —
 * compact earlier history in memory. This avoids the round-trip of hitting a
 * provider `context_too_long` error first; the reactive recovery in onLlmError
 * remains as a backstop. Also gives MainTutor (which has no beforeTurn) mid-loop
 * compaction it previously lacked.
 */
function makeProactiveCompactionBeforeTurn<TContext>(
  req: AgentRequest,
  spec: ChatAgentRunSpec<TContext>,
  runContext: AgentRunContext,
  budget: ContextWindowBudget,
  toolDefs: ToolDef[],
): ToolChatLoopOptions<TContext>['beforeTurn'] {
  const estimateTokens = (msgs: ToolTurnMessage[]): number =>
    tokenMeter.measureToolMessages({
      provider: req.provider,
      model: req.model,
      messages: msgs,
      tools: toolDefs,
      systemPrompt: spec.systemPrompt,
      budget,
    }).estimatedInputTokens;

  return async (turn, messages) => {
    let current = messages;
    const specResult = await spec.beforeTurn?.(turn, current);
    if (specResult) current = specResult;

    // Graduated proactive compaction via the shared ladder (cheapest tier first;
    // escalates to an LLM summary only if the free pass doesn't free enough room).
    // Skips turn 0 so the freshly-prepared initial context is untouched.
    if (turn > 0) {
      const { messages: compacted } = await runGraduatedCompaction(current, {
        estimate: estimateTokens,
        compressAt: budget.compressAt,
        collapseAt: budget.collapseAt,
        provider: req.provider,
        model: req.model,
        signal: req.signal,
        language: req.language,
        onProgress: (msg) => runContext.progress(`${msg}\n`),
        onUsage: (usage) => runContext.addUsage(usage),
      });
      current = compacted;
    }

    // Keep the live task checklist visible right before each LLM turn so the model
    // retains a sense of the whole goal. Mutates `current` in place (strip + append).
    injectTaskListReminder(
      current,
      runContext.taskList.render(req.language),
      runContext.taskList.hasOpenItems(),
      req.language,
    );

    // Injection mutates in place; always hand the (same) array back to the loop.
    return current;
  };
}

function applySlashCommand(req: AgentRequest, runContext: AgentRunContext, commandContext: CommandContext): AgentRequest | null {
  if (!isCommand(req.userMessage)) return req;

  const resolved = resolveCommand(req.userMessage);
  if (!resolved) return req;

  const { command, args } = resolved;
  if (command.type === 'local') {
    const result = command.handler(args, commandContext);
    runContext.chunk(result);
    runContext.complete();
    return null;
  }

  const prefix = command.handler(args, commandContext);
  return {
    ...req,
    userMessage: prefix + (args ? `\n\n${args}` : ''),
  };
}

async function handleRuntimeSlashCommand(req: AgentRequest, runContext: AgentRunContext): Promise<boolean> {
  const text = req.userMessage.trim();
  const compactMatch = text.match(/^\/compact(?:\s+([\s\S]+))?\s*$/i);
  const forceSnipMatch = text.match(/^\/(?:force-snip|snip)\s*$/i);
  const contextMatch = text.match(/^\/context\s*$/i);
  if (!compactMatch && !forceSnipMatch && !contextMatch) return false;

  if (!req.threadId) {
    runContext.chunk(localMsg(
      req.language,
      '没有找到当前对话线程，暂时没有可压缩的持久上下文。',
      'No active chat thread was found, so there is no persisted context to compact.',
    ));
    runContext.complete();
    return true;
  }

  if (contextMatch) {
    const result = contextWindowManager.describeThread({
      modelProvider: req.provider,
      model: req.model,
      courseId: req.courseId,
      nodeId: req.nodeId,
      threadId: req.threadId,
      agent: req.type,
      language: req.language,
      thinkingMode: req.thinkingMode,
      taskKind: 'chat',
      fallbackMessages: req.messages,
      currentUserMessage: '',
      imageAttachments: req.imageAttachments,
      pdfAttachments: req.pdfAttachments,
      sessionId: req.sessionId,
    });
    runContext.chunk(result);
    runContext.complete();
    return true;
  }

  const compactArg = compactMatch?.[1]?.trim();
  const keepRecent = compactArg && /^\d+$/.test(compactArg)
    ? Math.max(0, Math.min(Number(compactArg) || 0, 40))
    : undefined;
  const instruction = compactArg && !/^\d+$/.test(compactArg) ? compactArg : undefined;
  const result = await contextWindowManager.compactThread({
    modelProvider: req.provider,
    model: req.model,
    courseId: req.courseId,
    nodeId: req.nodeId,
    threadId: req.threadId,
    agent: req.type,
    language: req.language,
    signal: req.signal,
    currentUserMessage: req.userMessage,
    keepRecent,
    instruction,
    forceSnip: Boolean(forceSnipMatch),
    kind: forceSnipMatch ? 'emergency' : 'manual',
    onProgress: (msg) => runContext.progress(`${msg}\n`),
    onUsage: (usage) => { runContext.addUsage(usage); },
  });

  const reply = result.compacted
    ? localMsg(
        req.language,
        `上下文已${forceSnipMatch ? '强制折叠' : '压缩'}：已把 ${result.summarizedMessages} 条较早消息折叠进 checkpoint，并保留 ${result.retainedMessages} 条最近完整消息。当前摘要约 ${result.summaryTokenCount} tokens。`,
        `Context ${forceSnipMatch ? 'force-snipped' : 'compacted'}. Folded ${result.summarizedMessages} older messages into a checkpoint and kept ${result.retainedMessages} recent full messages live. Current summary is about ${result.summaryTokenCount} tokens.`,
      )
    : localMsg(
        req.language,
        `上下文目前已经足够紧凑：上次摘要之后还有 ${result.retainedMessages} 条最近消息。`,
        `Context is already compact. ${result.retainedMessages} recent messages remain after the last saved summary.`,
      );

  runContext.chunk(reply);
  runContext.complete();
  return true;
}

export async function runChatAgent<TContext>(
  options: RunChatAgentOptions<TContext>,
): Promise<ToolChatLoopResult | null> {
  const hydratedReq = hydrateRequestMessages(options.req);
  if (await handleRuntimeSlashCommand(hydratedReq, options.runContext)) return null;
  const req = applySlashCommand(hydratedReq, options.runContext, options.commandContext);
  if (!req) return null;

  const spec = await options.buildRunSpec(req);
  const specToolRunOptions = spec.toolRunOptions;

  // Continuation, opencode-style: the persisted live run state is the source of
  // truth. When a thread has an interrupted (non-completed) checkpoint, we rebuild
  // from it so the model picks up from the exact prior tool state — no special
  // command needed. `/resume` is the explicit form (bypasses the freshness window);
  // a normal follow-up message auto-resumes only a *recent* interruption.
  const resume = parseResumeCommand(req.userMessage);
  const snapshot = req.threadId ? runStateRepo.findResumable(req.threadId) : null;
  const restored = snapshot ? parseSnapshotMessages(snapshot.messages_json) : [];
  const snapshotUsable = snapshot !== null && restored.length > 0;
  const wantResume = snapshotUsable && (resume !== null || isCheckpointFresh(snapshot.updated_at));

  let managedMessages: ToolTurnMessage[];
  if (resume && !snapshotUsable) {
    // Explicit /resume but nothing resumable.
    options.runContext.chunk(localMsg(
      req.language,
      '没有找到可恢复的运行：当前线程没有未完成的中断任务。',
      'Nothing to resume: this thread has no interrupted in-flight task.',
    ));
    options.runContext.complete();
    return null;
  }

  if (wantResume && snapshot) {
    managedMessages = restored;
    options.runContext.taskList.loadFrom(parseSnapshotTaskList(snapshot.task_list_json));
    // Consume the old snapshot so it can't be resumed twice; this run re-checkpoints
    // under its own session id and becomes the new resumable state if it stops early.
    try { runStateRepo.delete(snapshot.session_id); } catch { /* best-effort */ }
    // Explicit /resume uses its optional extra (or a default nudge); an implicit
    // continuation uses the user's actual message as the next instruction.
    const continuation = resume
      ? (resume.extra || localMsg(
          req.language,
          '请从上次中断处继续，完成任务清单中仍未完成的项；无法完成的请用 write_todos 标记为 cancelled 并说明原因。',
          'Resume from where you were interrupted and finish the still-open items on the task list; mark anything you cannot complete as cancelled via write_todos and explain why.',
        ))
      : req.userMessage;
    appendUserText(managedMessages, continuation);
    options.runContext.progress(localMsg(
      req.language,
      `\n[恢复] 已从上次中断处继续（第 ${snapshot.turn} 轮，未完成 ${options.runContext.taskList.openCount()} 项）。\n`,
      `\n[Resume] Continuing from where the previous run was interrupted (turn ${snapshot.turn}, ${options.runContext.taskList.openCount()} open item(s)).\n`,
    ));
  } else {
    // Not resuming: clear any stale interrupted state for this thread, then build fresh.
    if (snapshot && req.threadId) {
      try { runStateRepo.deleteByThread(req.threadId); } catch { /* best-effort */ }
    }
    managedMessages = await buildManagedToolMessages(req, spec, options.runContext);
  }

  const resolvedMaxTokens = resolveChatOutputTokens(req.provider, req.model, spec.loopConfig.maxTokens);
  const contextBudget = resolveContextWindowBudget({
    provider: req.provider,
    model: req.model,
    taskKind: spec.contextTaskKind ?? 'chat',
    thinkingMode: req.thinkingMode,
    requestedMaxOutputTokens: resolvedMaxTokens,
  });
  const budgetToolDefs = spec.toolRegistry.buildToolDefs(req.language);
  let contextTooLongRetries = 0;
  let transientRetries = 0;
  options.runContext.diagnostics.runStart({
    provider: req.provider,
    model: req.model,
    maxTurns: spec.loopConfig.maxTurns,
    hardMaxTurns: spec.loopConfig.hardMaxTurns,
  });
  const loopResult = await runToolChatLoop({
    provider: req.provider,
    model: req.model,
    systemPrompt: spec.systemPrompt,
    messages: managedMessages,
    toolRegistry: spec.toolRegistry,
    toolContext: spec.toolContext,
    runContext: options.runContext,
    maxTurns: spec.loopConfig.maxTurns,
    hardMaxTurns: spec.loopConfig.hardMaxTurns,
    maxTokens: resolvedMaxTokens,
    shouldContinueAtEndTurn: (turn) => {
      const taskList = options.runContext.taskList;
      if (!taskList.hasOpenItems()) return undefined;
      const open = taskList.openSummary(req.language);
      const pastSoftLimit = turn + 1 >= spec.loopConfig.maxTurns;
      const nudge = pastSoftLimit
        ? localMsg(
            req.language,
            `已达常规轮数但任务清单仍有未完成项：${open}。请用尽量少的步骤收尾——完成关键项，或调用 write_todos 把无法完成的项标记为 cancelled 并如实说明，然后结束。`,
            `Reached the normal turn budget but the task list still has open items: ${open}. Wrap up in as few steps as possible — finish the key items, or call write_todos to mark anything you cannot complete as cancelled and explain honestly, then end.`,
          )
        : localMsg(
            req.language,
            `任务尚未完成，清单仍有未完成项：${open}。请继续推进；完成后调用 write_todos 更新状态，全部完成或确实无法完成时再结束。`,
            `The task is not finished — open items remain: ${open}. Keep going; call write_todos to update statuses, and only end once everything is done or genuinely cannot be completed.`,
          );
      return { nudge };
    },
    thinkingBudget: resolveThinkingBudget(req.provider, req.model, req.thinkingMode),
    signal: req.signal,
    language: req.language,
    imageAttachments: req.imageAttachments,
    pdfAttachments: req.pdfAttachments,
    onChunk: spec.onChunk,
    onCheckpoint: req.threadId
      ? (turn, messages) => {
          try {
            runStateRepo.save({
              sessionId:    req.sessionId,
              threadId:     req.threadId,
              courseId:     req.courseId,
              nodeId:       req.nodeId,
              agent:        req.type,
              status:       'running',
              turn,
              messagesJson:  JSON.stringify(messages),
              taskListJson:  JSON.stringify(options.runContext.taskList.toJSON()),
            });
          } catch {
            // Checkpointing is best-effort; never let it break the loop.
          }
        }
      : undefined,
    beforeTurn: makeProactiveCompactionBeforeTurn(req, spec, options.runContext, contextBudget, budgetToolDefs),
    afterLlmResponse: spec.afterLlmResponse,
    onEndTurn: spec.onEndTurn,
    beforeToolExecution: spec.beforeToolExecution,
    afterToolResults: spec.afterToolResults,
    onLlmError: async (err, _turn, currentMessages) => {
      const classified = classifyError(err);
      // Transient errors: bounded exponential backoff, then retry the same turn.
      if (classified.type === 'rate_limit' || classified.type === 'network_error') {
        if (transientRetries >= MAX_TRANSIENT_LLM_RETRIES) return;
        transientRetries += 1;
        options.runContext.progress(localMsg(
          req.language,
          `\n[网络重试] ${classified.message}（第 ${transientRetries}/${MAX_TRANSIENT_LLM_RETRIES} 次，退避后重试）\n`,
          `\n[Retry] ${classified.message} (attempt ${transientRetries}/${MAX_TRANSIENT_LLM_RETRIES}; backing off)\n`,
        ));
        await sleep(Math.min(8_000, 500 * 2 ** transientRetries));
        return options.runContext.isAborted ? undefined : 'continue';
      }
      // Context overflow: graduated in-memory compaction (cheapest first), then a
      // thread compaction, then a hard head+tail truncation. Everything else is
      // not recoverable here and falls through to the loop's failure handling.
      if (classified.type !== 'context_too_long') return;
      options.runContext.progress(message('contextTooLongCompressing', req.language));
      contextTooLongRetries += 1;
      if (contextTooLongRetries === 1) {
        currentMessages.splice(0, currentMessages.length, ...compressToolHistory(currentMessages, req.language));
        return 'continue';
      }
      if (contextTooLongRetries === 2) {
        if (req.threadId) {
          await contextWindowManager.compactThread({
            modelProvider: req.provider,
            model: req.model,
            courseId: req.courseId,
            nodeId: req.nodeId,
            threadId: req.threadId,
            agent: req.type,
            language: req.language,
            signal: req.signal,
            currentUserMessage: req.userMessage,
            forceSnip: true,
            kind: 'emergency',
            onProgress: (msg) => options.runContext.progress(`${msg}\n`),
            onUsage: (usage) => { options.runContext.addUsage(usage); },
          });
        }
        currentMessages.splice(0, currentMessages.length, ...compressToolHistory(currentMessages, req.language).slice(-10));
        return 'continue';
      }
      currentMessages.splice(0, currentMessages.length, ...truncateHeadTail(currentMessages));
      return 'continue';
    },
    toolRunOptions: {
      auditContext: {
        sessionId: req.sessionId,
        courseId: req.courseId,
        nodeId: req.nodeId,
        threadId: req.threadId,
        agent: req.type,
      },
      ...specToolRunOptions,
      onToolStart:    (call) => {
        specToolRunOptions?.onToolStart?.(call);
        options.runContext.toolCall({ toolCallId: call.id, toolName: call.name, input: call.input });
        req.recorder?.emit({
          type: 'tool.started',
          runId: req.sessionId,
          sessionId: req.sessionId,
          agentType: req.type,
          toolName: call.name,
          toolCallId: call.id,
          status: 'started',
        });
      },
      onToolComplete: (call, result, durationMs) => {
        specToolRunOptions?.onToolComplete?.(call, result, durationMs);
        options.runContext.toolResult({
          toolCallId: call.id,
          toolName: call.name,
          status: 'completed',
          isError: false,
          durationMs,
          content: result.content,
        });
        req.recorder?.emit({
          type: 'tool.completed',
          runId: req.sessionId,
          sessionId: req.sessionId,
          agentType: req.type,
          toolName: call.name,
          toolCallId: call.id,
          status: 'completed',
          durationMs,
        });
        options.runContext.diagnostics.tool({
          toolName: call.name,
          status: 'completed',
          durationMs,
          inputSummary: diagSummary(call.input, 300),
          resultSummary: diagSummary(result.content, 600),
        });
      },
      onToolFailure:  (call, error, durationMs) => {
        specToolRunOptions?.onToolFailure?.(call, error, durationMs);
        options.runContext.toolResult({
          toolCallId: call.id,
          toolName: call.name,
          status: 'failed',
          isError: true,
          durationMs,
          content: error,
        });
        req.recorder?.emit({
          type: 'tool.failed',
          runId: req.sessionId,
          sessionId: req.sessionId,
          agentType: req.type,
          toolName: call.name,
          toolCallId: call.id,
          status: 'failed',
          durationMs,
          error,
        });
        options.runContext.diagnostics.tool({
          toolName: call.name,
          status: 'failed',
          durationMs,
          inputSummary: diagSummary(call.input, 300),
          resultSummary: diagSummary(error, 600),
          isError: true,
        });
      },
    },
  });

  options.runContext.diagnostics.runDone({
    runStatus: loopResult.completed ? 'completed' : options.runContext.isAborted ? 'aborted' : 'incomplete',
    usageIn: options.runContext.usage.inputTokens,
    usageOut: options.runContext.usage.outputTokens,
    costCny: options.runContext.usage.costCny,
  });
  finalizeRunState(req.threadId, req.sessionId, options.runContext.isAborted, loopResult);
  return loopResult;
}
