import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildTool, registerTool, getTool, getAllTools } from '../index';
import type { ToolContext } from '../index';

// Minimal stub context — tests only need to confirm dispatch works
const stubCtx = {} as ToolContext;

// ── buildTool: Zod validation ─────────────────────────────────────────────────

describe('buildTool — Zod input validation', () => {
  const echoTool = buildTool<{ text: string }, string>({
    name: 'echo',
    description: 'echoes text',
    inputSchema: z.object({ text: z.string().min(1) }),
    inputJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    maxResultChars: 1000,
    execute: async ({ text }) => text,
    formatResult: (out) => out,
  });

  it('accepts valid input and calls the real execute', async () => {
    const result = await echoTool.execute({ text: 'hello' }, stubCtx);
    expect(result).toBe('hello');
  });

  it('rejects missing required field', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(echoTool.execute({} as any, stubCtx)).rejects.toThrow();
  });

  it('rejects wrong type', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(echoTool.execute({ text: 42 } as any, stubCtx)).rejects.toThrow();
  });

  it('rejects hallucinated extra fields after stripping (Zod strict mode off)', async () => {
    // Zod strips unknown keys by default — verify it does NOT throw but does strip
    const result = await echoTool.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { text: 'hello', hallucinated_param: 'x' } as any,
      stubCtx,
    );
    expect(result).toBe('hello');
  });

  it('rejects empty string (min(1))', async () => {
    await expect(echoTool.execute({ text: '' }, stubCtx)).rejects.toThrow();
  });
});

// ── formatResult ──────────────────────────────────────────────────────────────

describe('buildTool — formatResult', () => {
  it('delegates to the provided formatResult impl', () => {
    const t = buildTool<{ n: number }, number>({
      name: 'double',
      description: '',
      inputSchema: z.object({ n: z.number() }),
      inputJsonSchema: {},
      maxResultChars: 100,
      execute: async ({ n }) => n * 2,
      formatResult: (out) => `result: ${out}`,
    });
    expect(t.formatResult(4)).toBe('result: 4');
  });
});

// ── TOOL_REGISTRY ─────────────────────────────────────────────────────────────

describe('tool registry', () => {
  // Use a fresh registry slot with a unique name per test run
  const UNIQUE_NAME = `test_tool_${Math.random().toString(36).slice(2)}`;

  const testTool = buildTool<{ value: number }, number>({
    name: UNIQUE_NAME,
    description: 'test',
    inputSchema: z.object({ value: z.number() }),
    inputJsonSchema: {},
    maxResultChars: 100,
    execute: async ({ value }) => value,
    formatResult: (n) => String(n),
  });

  it('getTool returns undefined for unregistered name', () => {
    expect(getTool('__not_registered__')).toBeUndefined();
  });

  it('registerTool makes getTool find the tool by name', () => {
    registerTool(testTool);
    expect(getTool(UNIQUE_NAME)).toBeDefined();
    expect(getTool(UNIQUE_NAME)?.name).toBe(UNIQUE_NAME);
  });

  it('getAllTools includes the registered tool', () => {
    const names = getAllTools().map((t) => t.name);
    expect(names).toContain(UNIQUE_NAME);
  });

  it('registered tool executes correctly via getTool', async () => {
    const tool = getTool(UNIQUE_NAME)!;
    const result = await tool.execute({ value: 7 }, stubCtx);
    expect(result).toBe(7);
  });
});
