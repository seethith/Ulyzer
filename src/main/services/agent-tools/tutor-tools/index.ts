import { z } from 'zod';
import type { LLMProvider, FileGeneratedPayload, SearchMode, OutlineVersionSelection } from '@shared/types';
import type { AgentRunContext } from '../../agent-core/run-context';
import type { TaskList } from '../../agent-core/task-list';
import { message } from '../../agent-i18n/messages';

// ── Tool interface ─────────────────────────────────────────────────────────────

export interface TutorTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** Anthropic JSON Schema for the tool definition sent to the API */
  inputJsonSchema: Record<string, unknown>;
  /** Truncate tool result to this many chars before sending back to the model */
  maxResultChars: number;
  /** True = tool only reads data; safe to run in parallel with other read-only tools */
  isReadOnly?: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  formatResult(output: TOutput): string;
}

export interface ToolContext {
  sessionId: string;
  courseId: string;
  nodeId: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  language?: string;
  searchMode?: SearchMode;
  outlineVersion?: OutlineVersionSelection;
  /** Push a progress message to the user's chat stream — does NOT go to the LLM */
  onProgress: (msg: string) => void;
  /** Called when a file has been successfully saved */
  onFileGenerated: (payload: FileGeneratedPayload) => void;
  /** Stream content chunks to the user in real-time (used by generation tools in chat context) */
  onChunk?: (chunk: string) => void;
  runContext?: AgentRunContext;
  /** Per-run task checklist maintained via write_todos; drives the loop's completion gate. */
  taskList?: TaskList;
  /** Sub-agent nesting depth; 0 = top-level. Used by spawn_subtask to block recursion. */
  depth?: number;
}

/**
 * Wrap a tool definition so `execute` always validates its input via Zod before
 * delegating to the real implementation. Rejects hallucinated parameters.
 */
export function buildTool<I, O>(
  def: TutorTool<I, O>,
): TutorTool<I, O> {
  return {
    ...def,
    execute: async (input: I, ctx: ToolContext): Promise<O> => {
      const validated = def.inputSchema.parse(input) as I;
      return def.execute(validated, ctx);
    },
  };
}

/** Truncate long tool output to prevent blowing up the context window */
export function truncateResult(text: string, maxChars: number, language?: string): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}${message('toolResultTruncated', language)}${text.slice(-half)}`;
}
