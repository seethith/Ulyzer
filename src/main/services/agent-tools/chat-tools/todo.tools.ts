/**
 * write_todos — lets the conversational tool loop maintain a persistent task
 * checklist. The list lives on the run's TaskList (via ctx.taskList) and is both
 * injected into context each turn and used as the loop's completion gate.
 */
import { z } from 'zod';
import { applyWriteTodos, type TaskStatus } from '../../agent-core/task-list';
import type { TutorTool, ToolContext } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';

const TODO_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

interface WriteTodosToolInput {
  todos: Array<{ content: string; status?: TaskStatus }>;
}

export const writeTodosTool: TutorTool<WriteTodosToolInput, string> = buildTool({
  name: 'write_todos',
  description: toolDescription('write_todos'),
  inputSchema: z.object({
    todos: z.array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
      }),
    ),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: toolPropertyDescription('write_todos', 'todos'),
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: [...TODO_STATUSES] },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
  maxResultChars: 400,
  isReadOnly: true,
  execute: (input, ctx: ToolContext) =>
    Promise.resolve(applyWriteTodos(ctx.taskList, input, ctx.language)),
  formatResult: (summary) => summary,
});
