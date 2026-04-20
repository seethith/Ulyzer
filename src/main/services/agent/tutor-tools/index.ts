import { z } from 'zod';
import type { LLMProvider, FileGeneratedPayload } from '@shared/types';

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

// ── Tool registry ──────────────────────────────────────────────────────────────
// Enables O(1) dispatch by name — no if-else chains needed in the loop.
// Call registerTool() once per tool (in tutor-tools/registry.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_REGISTRY = new Map<string, TutorTool<any, any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerTool(tool: TutorTool<any, any>): void {
  TOOL_REGISTRY.set(tool.name, tool);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTool(name: string): TutorTool<any, any> | undefined {
  return TOOL_REGISTRY.get(name);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAllTools(): TutorTool<any, any>[] {
  return [...TOOL_REGISTRY.values()];
}

export interface ToolContext {
  sessionId: string;
  courseId: string;
  nodeId: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  language?: string;
  /** Push a progress message to the user's chat stream — does NOT go to the LLM */
  onProgress: (msg: string) => void;
  /** Called when a file has been successfully saved */
  onFileGenerated: (payload: FileGeneratedPayload) => void;
  /** Stream content chunks to the user in real-time (used by generation tools in chat context) */
  onChunk?: (chunk: string) => void;
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
export function truncateResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[...内容过长，已截断中间部分...]\n\n${text.slice(-half)}`;
}
