import { describe, expect, it } from 'vitest';
import { createAgentToolRegistry } from './registry';
import { ToolRunner } from './tool-runner';
import type { AgentTool } from './types';

function createTool(
  name: string,
  options: {
    readOnly?: boolean;
    result?: string;
    maxResultChars?: number;
    onExecute?: () => void | Promise<void>;
  } = {},
): AgentTool<Record<string, never>, string> {
  return {
    namespace:      'tutor',
    name,
    description:   `${name} description`,
    inputSchema:   { type: 'object', properties: {} },
    maxResultChars: options.maxResultChars ?? 1000,
    isReadOnly:    options.readOnly === true,
    permissions:   {
      readOnly: options.readOnly === true,
      canWriteFile: false,
      canMutateDag: false,
      canUseWeb: false,
      maxResultChars: options.maxResultChars ?? 1000,
    },
    execute:       async () => {
      await options.onExecute?.();
      return options.result ?? name;
    },
    formatResult:  (output) => output,
  };
}

describe('ToolRunner', () => {
  it('preserves execution order around writes while returning results in call order', async () => {
    const executionOrder: string[] = [];
    const registry = createAgentToolRegistry([
      createTool('write', { onExecute: () => { executionOrder.push('write'); } }),
      createTool('read', { readOnly: true, onExecute: () => { executionOrder.push('read'); } }),
    ]);
    const runner = new ToolRunner(registry);

    const results = await runner.runMany([
      { id: '1', name: 'write', input: {} },
      { id: '2', name: 'read', input: {} },
    ], {});

    expect(executionOrder).toEqual(['write', 'read']);
    expect(results.map((result) => result.toolCallId)).toEqual(['1', '2']);
  });

  it('executes update_profile before generate_dag when the model calls both in one turn', async () => {
    const executionOrder: string[] = [];
    const registry = createAgentToolRegistry([
      createTool('generate_dag', { onExecute: () => { executionOrder.push('generate_dag'); } }),
      createTool('update_profile', { onExecute: () => { executionOrder.push('update_profile'); } }),
    ]);
    const runner = new ToolRunner(registry);

    const results = await runner.runMany([
      { id: 'route', name: 'generate_dag', input: {} },
      { id: 'profile', name: 'update_profile', input: {} },
    ], {});

    expect(executionOrder).toEqual(['update_profile', 'generate_dag']);
    expect(results.map((result) => result.toolCallId)).toEqual(['route', 'profile']);
  });

  it('runs the model\'s evidence-search calls even alongside generate_dag (no framework override)', async () => {
    const executionOrder: string[] = [];
    const registry = createAgentToolRegistry([
      createTool('web_search', { readOnly: true, onExecute: () => { executionOrder.push('web_search'); } }),
      createTool('search_library', { readOnly: true, onExecute: () => { executionOrder.push('search_library'); } }),
      createTool('generate_dag', { onExecute: () => { executionOrder.push('generate_dag'); } }),
    ]);
    const runner = new ToolRunner(registry);

    const results = await runner.runMany([
      { id: 'web', name: 'web_search', input: {} },
      { id: 'library', name: 'search_library', input: {} },
      { id: 'route', name: 'generate_dag', input: {} },
    ], {});

    // The harness no longer drops the model's tool calls — every requested tool runs.
    expect(executionOrder).toContain('web_search');
    expect(executionOrder).toContain('search_library');
    expect(executionOrder).toContain('generate_dag');
    expect(results.map((result) => result.toolCallId)).toEqual(['web', 'library', 'route']);
  });

  it('runs consecutive read-only calls as a parallel batch', async () => {
    const executionOrder: string[] = [];
    let releaseFirstRead: (() => void) | undefined;

    const registry = createAgentToolRegistry([
      createTool('read_slow', {
        readOnly: true,
        onExecute: async () => {
          executionOrder.push('read_slow:start');
          await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
          executionOrder.push('read_slow:end');
        },
      }),
      createTool('read_fast', {
        readOnly: true,
        onExecute: () => {
          executionOrder.push('read_fast');
          releaseFirstRead?.();
        },
      }),
      createTool('write', { onExecute: () => { executionOrder.push('write'); } }),
    ]);
    const runner = new ToolRunner(registry);

    await runner.runMany([
      { id: '1', name: 'read_slow', input: {} },
      { id: '2', name: 'read_fast', input: {} },
      { id: '3', name: 'write', input: {} },
    ], {});

    expect(executionOrder).toEqual(['read_slow:start', 'read_fast', 'read_slow:end', 'write']);
  });

  it('returns structured unknown-tool errors', async () => {
    const runner = new ToolRunner(createAgentToolRegistry([
      createTool('known'),
    ]));

    const [result] = await runner.runMany([
      { id: 'missing-1', name: 'missing', input: {} },
    ], {}, { language: 'en' });

    expect(result).toMatchObject({
      toolCallId: 'missing-1',
      isError:    true,
    });
    expect(result.content).toContain('unknown tool missing');
    expect(result.content).toContain('known');
  });

  it('truncates long formatted results through the shared policy', async () => {
    const runner = new ToolRunner(createAgentToolRegistry([
      createTool('long', { result: 'abcdefghij', maxResultChars: 6 }),
    ]));

    const [result] = await runner.runMany([
      { id: 'long-1', name: 'long', input: {} },
    ], {});

    expect(result.content).toContain('abc');
    expect(result.content).toContain('hij');
    expect(result.content).toContain('已截断');
  });
});
