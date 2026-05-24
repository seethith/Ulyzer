/**
 * spawn_subtask — lets the node tutor delegate a focused objective to a
 * context-isolated sub-agent. The sub-agent runs its own bounded tool loop and
 * returns only a concise result, keeping the parent conversation clean.
 */
import { z } from 'zod';
import { runSubtask } from '../../agent-core/spawn-subtask';
import type { TutorTool, ToolContext } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { buildSubAgentToolRegistry } from './registry';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { localMsg } from '../../prompt/prompt-builder';

interface SpawnSubtaskInput {
  objective: string;
  tools?: string[];
  max_turns?: number;
}

export const spawnSubtaskTool: TutorTool<SpawnSubtaskInput, string> = buildTool({
  name: 'spawn_subtask',
  description: toolDescription('spawn_subtask'),
  inputSchema: z.object({
    objective: z.string(),
    tools: z.array(z.string()).optional(),
    max_turns: z.number().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: toolPropertyDescription('spawn_subtask', 'objective') },
      tools: { type: 'array', items: { type: 'string' }, description: toolPropertyDescription('spawn_subtask', 'tools') },
      max_turns: { type: 'number', description: toolPropertyDescription('spawn_subtask', 'max_turns') },
    },
    required: ['objective'],
  },
  maxResultChars: 4_000,
  isReadOnly: false,
  execute: async (input, ctx: ToolContext): Promise<string> => {
    // Recursion guard: a sub-agent cannot spawn another sub-agent.
    if ((ctx.depth ?? 0) >= 1) {
      return localMsg(
        ctx.language,
        '子任务内不允许再派发子任务（spawn_subtask 已禁用）。请直接用现有工具完成。',
        'Nested sub-tasks are not allowed (spawn_subtask is disabled inside a sub-agent). Complete this directly with the available tools.',
      );
    }
    const objective = input.objective?.trim();
    if (!objective) {
      return localMsg(ctx.language, '请提供明确的子任务目标。', 'Please provide a clear sub-task objective.');
    }
    const result = await runSubtask({
      objective,
      parentCtx: ctx,
      registry: buildSubAgentToolRegistry(input.tools),
      maxTurns: input.max_turns,
      language: ctx.language,
    });
    return result.text;
  },
  formatResult: (text) => text,
});
