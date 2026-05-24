import type { ToolCallBlock, ToolDef } from '../llm/adapter';
import { localizeToolDefinition } from '../agent-i18n/tool-descriptions';
import { DEFAULT_MAX_RESULT_CHARS } from './tool-policy';
import { resolveToolPermissions } from './tool-permissions';
import type { AgentTool, AgentToolNamespace, AgentToolRegistry } from './types';

interface ToolModuleLike<TContext> {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  maxResultChars: number;
  isReadOnly?: boolean;
  execute(input: never, ctx: TContext): Promise<unknown>;
  formatResult(output: never): string;
}

export class UnifiedToolRegistry<TContext = unknown> implements AgentToolRegistry<TContext> {
  private readonly tools = new Map<string, AgentTool<TContext>>();

  constructor(tools: AgentTool<TContext>[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool<TContext>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<TContext> | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool<TContext>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  buildToolDefs(language?: string): ToolDef[] {
    return this.list().map((tool) => {
      const localized = localizeToolDefinition(
        tool.name,
        tool.description,
        tool.inputSchema,
        language,
      );
      return {
        name:        tool.name,
        description: localized.description,
        inputSchema: localized.inputSchema,
      };
    });
  }
}

export function createAgentToolRegistry<TContext>(
  tools: AgentTool<TContext>[],
): UnifiedToolRegistry<TContext> {
  return new UnifiedToolRegistry(tools);
}

export function fromToolModule<TContext>(
  namespace: AgentToolNamespace,
  tool: ToolModuleLike<TContext>,
): AgentTool<TContext> {
  const permissions = resolveToolPermissions(namespace, tool.name, {
    readOnly: tool.isReadOnly === true,
    maxResultChars: tool.maxResultChars,
  });
  return {
    namespace,
    name:           tool.name,
    description:    tool.description,
    inputSchema:    tool.inputJsonSchema,
    maxResultChars: permissions.maxResultChars,
    isReadOnly:     permissions.readOnly,
    permissions,
    execute:        (input, ctx) => tool.execute(input as never, ctx),
    formatResult:   (output) => tool.formatResult(output as never),
  };
}

export function fromToolDef<TContext>(
  namespace: AgentToolNamespace,
  def: ToolDef,
  execute: (call: ToolCallBlock, ctx: TContext) => Promise<string>,
  options: { maxResultChars?: number; isReadOnly?: boolean } = {},
): AgentTool<TContext, string> {
  const permissions = resolveToolPermissions(namespace, def.name, {
    readOnly: options.isReadOnly === true,
    maxResultChars: options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  });
  return {
    namespace,
    name:           def.name,
    description:    def.description,
    inputSchema:    def.inputSchema,
    maxResultChars: permissions.maxResultChars,
    isReadOnly:     permissions.readOnly,
    permissions,
    execute:        (_input, ctx, call) => execute(call, ctx),
    formatResult:   (output) => output,
  };
}
