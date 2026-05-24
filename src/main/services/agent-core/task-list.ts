/**
 * TaskList — a lightweight, per-run task checklist that gives long-horizon agent
 * loops a persistent sense of "what is the whole goal and what's left".
 *
 * It is the hub for two capabilities:
 *  1. Completion gate (tool-chat-loop): the loop only keeps going past a normal
 *     `end_turn` while open items remain (Change 1).
 *  2. Persistent task state (run-state checkpoint): serialized alongside the live
 *     message history so an aborted/crashed run can resume mid-task (Change 3).
 *
 * The model maintains the list via the `write_todos` tool, which replaces the
 * full list each call (the same content-addressed pattern Claude Code uses).
 */

import { localMsg } from '../prompt/prompt-builder';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TaskItem {
  id: string;
  content: string;
  status: TaskStatus;
}

export interface TaskListSnapshot {
  items: TaskItem[];
}

const VALID_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

function normalizeStatus(value: unknown): TaskStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)
    ? (value as TaskStatus)
    : 'pending';
}

const STATUS_MARK: Record<TaskStatus, string> = {
  pending: ' ',
  in_progress: '~',
  completed: 'x',
  cancelled: '-',
};

export interface WriteTodosInput {
  todos?: Array<{ content?: unknown; status?: unknown }>;
}

export class TaskList {
  private items: TaskItem[] = [];

  /** True when the model has never written a list. */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Any item still pending or in progress — i.e. the task is not finished. */
  hasOpenItems(): boolean {
    return this.items.some((item) => item.status === 'pending' || item.status === 'in_progress');
  }

  openCount(): number {
    return this.items.filter((item) => item.status === 'pending' || item.status === 'in_progress').length;
  }

  list(): readonly TaskItem[] {
    return this.items;
  }

  /** Replace the entire list (write_todos semantics). Reassigns sequential ids after dropping blanks. */
  replace(items: Array<{ content: string; status?: TaskStatus }>): void {
    this.items = items
      .map((item) => ({ content: item.content.trim(), status: normalizeStatus(item.status) }))
      .filter((item) => item.content.length > 0)
      .map((item, index) => ({ id: `t${index + 1}`, content: item.content, status: item.status }));
  }

  toJSON(): TaskListSnapshot {
    return { items: this.items.map((item) => ({ ...item })) };
  }

  loadFrom(snapshot: TaskListSnapshot | null | undefined): void {
    if (!snapshot || !Array.isArray(snapshot.items)) return;
    this.items = snapshot.items
      .filter((item): item is TaskItem => typeof item?.content === 'string')
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id ? item.id : `t${index + 1}`,
        content: item.content.trim(),
        status: normalizeStatus(item.status),
      }))
      .filter((item) => item.content.length > 0);
  }

  static fromJSON(snapshot: TaskListSnapshot | null | undefined): TaskList {
    const list = new TaskList();
    list.loadFrom(snapshot);
    return list;
  }

  /** Compact markdown block injected into context each turn. Empty when no list. */
  render(language?: string): string {
    if (this.items.length === 0) return '';
    const header = localMsg(language, '当前任务清单', 'Current task list');
    const lines = this.items.map((item) => `- [${STATUS_MARK[item.status]}] ${item.content}`);
    return `[${header}]\n${lines.join('\n')}`;
  }

  /** One-line open-items summary used by the completion-gate nudge. */
  openSummary(language?: string, max = 5): string {
    const open = this.items.filter((item) => item.status === 'pending' || item.status === 'in_progress');
    if (open.length === 0) return '';
    const shown = open.slice(0, max).map((item) => item.content).join(language === 'en' ? '; ' : '；');
    const more = open.length > max ? ` (+${open.length - max})` : '';
    return `${shown}${more}`;
  }
}

/**
 * Shared `write_todos` handler used by both the chat (TutorTool) and DAG
 * (ToolDef dispatcher) registries. Mutates the provided list and returns a short
 * confirmation string for the model.
 */
export function applyWriteTodos(
  taskList: TaskList | undefined,
  input: WriteTodosInput,
  language?: string,
): string {
  if (!taskList) {
    return localMsg(language, '任务清单在当前上下文不可用。', 'Task list is not available in this context.');
  }
  const raw = Array.isArray(input.todos) ? input.todos : [];
  taskList.replace(
    raw.map((item) => ({
      content: typeof item.content === 'string' ? item.content : '',
      status: normalizeStatus(item.status),
    })),
  );
  const total = taskList.list().length;
  const open = taskList.openCount();
  return localMsg(
    language,
    `任务清单已更新：共 ${total} 项，未完成 ${open} 项。完成全部未完成项后再结束本轮工作。`,
    `Task list updated: ${total} item(s), ${open} open. Finish the open items before ending this turn.`,
  );
}
