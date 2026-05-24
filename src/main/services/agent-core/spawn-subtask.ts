/**
 * runSubtask — context-isolated sub-agent delegation (the Task-tool pattern).
 *
 * A parent tool loop can hand a focused objective to a fresh, bounded inner loop
 * that runs with its own message history and task list. Only a concise final
 * result returns to the parent; the sub-agent's intermediate tool calls and
 * reasoning never pollute the parent context. Usage and progress flow up to the
 * shared run context so cost and activity stay visible.
 *
 * The caller supplies the (already filtered) tool registry, which keeps this
 * module free of any dependency on the chat-tool registry and avoids an import
 * cycle.
 */
import type { TokenUsage } from '@shared/types';
import type { ToolTurnMessage } from '../llm/adapter';
import type { AgentToolRegistry } from '../agent-tools/types';
import type { ToolContext } from '../agent-tools/tutor-tools/index';
import { runToolChatLoop, type ToolChatLoopRunContext } from './tool-chat-loop';
import { TaskList } from './task-list';
import { localMsg } from '../prompt/prompt-builder';

export interface RunSubtaskOptions {
  objective: string;
  parentCtx: ToolContext;
  /** Tool registry the sub-agent may use (already filtered; must not include spawn_subtask). */
  registry: AgentToolRegistry<ToolContext>;
  maxTurns?: number;
  language?: string;
}

const DEFAULT_SUBTASK_MAX_TURNS = 15;
const MAX_SUBTASK_TURNS = 30;

function buildSubtaskSystemPrompt(objective: string, language?: string): string {
  return localMsg(
    language,
    `你是一名受导师调度的专注子助手（sub-agent），没有直接用户。请只围绕下面这个目标工作，使用可用工具完成它，然后在最后一轮用一段简洁的结论收尾（你做了什么、产出了什么文件/结果、有无遗留问题）。不要向用户提问，不要展开与目标无关的内容；遇到多步骤工作可用 write_todos 自我规划。\n\n【子任务目标】\n${objective}`,
    `You are a focused sub-agent dispatched by a tutor, with no direct user. Work only on the objective below, use the available tools to complete it, then finish your final turn with a concise result (what you did, what files/results you produced, any open issues). Do not ask the user questions or expand beyond the objective; use write_todos to self-plan multi-step work.\n\n[Sub-task objective]\n${objective}`,
  );
}

function lastAssistantText(messages: ToolTurnMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.text.trim()) return msg.text.trim();
  }
  return '';
}

export interface SubtaskResult {
  text: string;
  usage: TokenUsage;
  completed: boolean;
}

export async function runSubtask(options: RunSubtaskOptions): Promise<SubtaskResult> {
  const parent = options.parentCtx.runContext;
  const subTaskList = new TaskList();
  const language = options.language ?? options.parentCtx.language;

  // Sub-loop run context: usage + progress bubble up to the parent; no terminal
  // stream events (the parent loop owns the user-facing terminal event).
  const subRunContext: ToolChatLoopRunContext & { progress: (chunk: string) => void } = {
    get usage(): TokenUsage {
      return parent?.usage ?? { inputTokens: 0, outputTokens: 0, costCny: 0 };
    },
    get isAborted(): boolean {
      return options.parentCtx.signal?.aborted ?? parent?.isAborted ?? false;
    },
    addUsage(usage, source) {
      return parent?.addUsage(usage, source ?? 'subtask') ?? this.usage;
    },
    chunk(chunk) {
      options.parentCtx.onProgress(chunk);
    },
    progress(chunk) {
      options.parentCtx.onProgress(chunk);
    },
    fail() {
      // Sub-agent failures are surfaced through the returned result, not terminal events.
    },
    complete() {
      // No terminal event for sub-runs.
    },
  };

  // The sub-agent shares the parent's identity/IO but with its own task list and
  // an incremented depth so it cannot recurse into another sub-agent.
  const subCtx: ToolContext = {
    ...options.parentCtx,
    depth: (options.parentCtx.depth ?? 0) + 1,
    taskList: subTaskList,
    onChunk: (chunk: string) => options.parentCtx.onProgress(chunk),
  };

  const maxTurns = Math.max(1, Math.min(options.maxTurns ?? DEFAULT_SUBTASK_MAX_TURNS, MAX_SUBTASK_TURNS));

  const result = await runToolChatLoop<ToolContext>({
    provider: options.parentCtx.provider,
    model: options.parentCtx.model,
    systemPrompt: buildSubtaskSystemPrompt(options.objective, language),
    messages: [{ role: 'user', content: options.objective }],
    toolRegistry: options.registry,
    toolContext: subCtx,
    runContext: subRunContext,
    maxTurns,
    hardMaxTurns: maxTurns,
    maxTokens: 8_000,
    signal: options.parentCtx.signal,
    language,
    emitTerminalEvent: false,
    shouldContinueAtEndTurn: (turn) => {
      if (!subTaskList.hasOpenItems()) return undefined;
      if (turn + 1 >= maxTurns) return undefined;
      return {
        nudge: localMsg(
          language,
          `子任务清单仍有未完成项：${subTaskList.openSummary(language)}。请继续完成，或用 write_todos 标记无法完成的项，然后给出结论。`,
          `The sub-task list still has open items: ${subTaskList.openSummary(language)}. Keep going, or mark anything you cannot complete via write_todos, then give your conclusion.`,
        ),
      };
    },
  });

  const text = lastAssistantText(result.messages)
    || localMsg(language, '子任务已结束，但未返回结论文本。', 'Sub-task ended without a result summary.');

  return { text, usage: result.usage, completed: result.completed };
}
