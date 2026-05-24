import type { ToolCallBlock, ToolDef } from '../llm/adapter';
import { createAgentToolRegistry, fromToolDef, fromToolModule, type UnifiedToolRegistry } from './registry';
import type { AgentTool, AgentToolNamespace } from './types';

interface ToolModuleLike<TContext> {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  maxResultChars: number;
  isReadOnly?: boolean;
  execute(input: never, ctx: TContext): Promise<unknown>;
  formatResult(output: never): string;
}

export class ToolCatalog<TContext = unknown> {
  private readonly tools = new Map<string, AgentTool<TContext>>();

  constructor(readonly namespace: AgentToolNamespace) {}

  register(tool: AgentTool<TContext>): void {
    if (tool.namespace !== this.namespace) {
      throw new Error(`Tool ${tool.name} belongs to ${tool.namespace}, not ${this.namespace}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate ${this.namespace} tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: AgentTool<TContext>[]): void {
    for (const tool of tools) this.register(tool);
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

  toRegistry(): UnifiedToolRegistry<TContext> {
    return createAgentToolRegistry(this.list());
  }
}

export function createToolCatalog<TContext>(
  namespace: AgentToolNamespace,
  tools: AgentTool<TContext>[],
): ToolCatalog<TContext> {
  const catalog = new ToolCatalog<TContext>(namespace);
  catalog.registerAll(tools);
  return catalog;
}

export function createToolCatalogFromModules<TContext>(
  namespace: AgentToolNamespace,
  modules: ToolModuleLike<TContext>[],
): ToolCatalog<TContext> {
  return createToolCatalog(
    namespace,
    modules.map((tool) => fromToolModule(namespace, tool)),
  );
}

export function createToolCatalogFromDefs<TContext>(
  namespace: AgentToolNamespace,
  defs: ToolDef[],
  execute: (call: ToolCallBlock, ctx: TContext) => Promise<string>,
): ToolCatalog<TContext> {
  return createToolCatalog(
    namespace,
    defs.map((def) => fromToolDef(namespace, def, execute)),
  );
}
