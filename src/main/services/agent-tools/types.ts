import type { ToolCallBlock, ToolDef, ToolResultBlock } from '../llm/adapter';

export type AgentToolNamespace = 'dag' | 'chat' | 'tutor';

export interface AgentToolPermissions {
  readOnly: boolean;
  canWriteFile: boolean;
  canMutateDag: boolean;
  canUseWeb: boolean;
  maxResultChars: number;
}

export interface AgentTool<TContext = unknown, TOutput = unknown> {
  namespace: AgentToolNamespace;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  maxResultChars: number;
  isReadOnly: boolean;
  permissions: AgentToolPermissions;
  execute(input: Record<string, unknown>, ctx: TContext, call: ToolCallBlock): Promise<TOutput>;
  formatResult(output: TOutput): string;
}

export interface AgentToolRegistry<TContext = unknown> {
  register(tool: AgentTool<TContext>): void;
  get(name: string): AgentTool<TContext> | undefined;
  list(): AgentTool<TContext>[];
  names(): string[];
  buildToolDefs(language?: string): ToolDef[];
}

export interface ToolRunOptions {
  language?: string;
  auditContext?: {
    sessionId?: string;
    courseId?: string;
    nodeId?: string;
    threadId?: string;
    agent?: string;
  };
  onProgress?: (message: string) => void;
  onToolError?: (toolName: string, error: string) => void;
  onToolStart?: (call: ToolCallBlock) => void;
  onToolComplete?: (call: ToolCallBlock, result: ToolResultBlock, durationMs?: number) => void;
  onToolFailure?: (call: ToolCallBlock, error: string, durationMs?: number) => void;
}

export type { ToolCallBlock, ToolDef, ToolResultBlock };
