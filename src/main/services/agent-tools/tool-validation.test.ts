import { describe, expect, it } from 'vitest';
import { validateToolInput } from './tool-validation';
import type { AgentTool } from './types';

function fakeTool(inputSchema: Record<string, unknown>): AgentTool<unknown> {
  return {
    namespace: 'chat',
    name: 'demo_tool',
    description: '',
    inputSchema,
    maxResultChars: 1000,
    isReadOnly: true,
    permissions: { readOnly: true, canWriteFile: false, canMutateDag: false, canUseWeb: false, maxResultChars: 1000 },
    execute: async () => ({}),
    formatResult: () => '',
  };
}

describe('validateToolInput', () => {
  it('passes when all required params are present', () => {
    const tool = fakeTool({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } });
    expect(validateToolInput(tool, { topic: 'graphs' }).ok).toBe(true);
  });

  it('flags a missing required param with a structured message', () => {
    const tool = fakeTool({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } });
    const result = validateToolInput(tool, {}, 'en-US');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('topic');
  });

  it('flags an out-of-enum value but tolerates number/string representation', () => {
    const tool = fakeTool({ type: 'object', properties: { mode: { enum: ['fast', 'slow'] }, level: { enum: [1, 2, 3] } } });
    expect(validateToolInput(tool, { mode: 'turbo' }).ok).toBe(false);
    expect(validateToolInput(tool, { mode: 'fast' }).ok).toBe(true);
    // number sent as string should still match a numeric enum
    expect(validateToolInput(tool, { level: '2' }).ok).toBe(true);
  });

  it('allows unknown/extra properties through', () => {
    const tool = fakeTool({ type: 'object', required: [], properties: { topic: { type: 'string' } } });
    expect(validateToolInput(tool, { topic: 'x', extra: 42 }).ok).toBe(true);
  });
});
