import { describe, expect, it } from 'vitest';
import { resolveModelCapability } from '../llm/model-capabilities';
import { resolveOutputTokenBudget } from './output-token-budget';

describe('output token budget', () => {
  it('uses high-output DeepSeek v4 capability instead of the old 8k cap', () => {
    const capability = resolveModelCapability('deepseek', 'deepseek-v4-flash');
    expect(capability.maxOutputTokens).toBeGreaterThan(8_192);

    const materialBudget = resolveOutputTokenBudget({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      task: 'material_theory',
    });
    expect(materialBudget).toBeGreaterThan(8_192);
  });

  it('caps requested output at model capability', () => {
    const capability = resolveModelCapability('deepseek', 'deepseek-v4-flash');
    const budget = resolveOutputTokenBudget({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      task: 'material_theory',
      requestedMaxTokens: capability.maxOutputTokens + 1,
    });
    expect(budget).toBe(capability.maxOutputTokens);
  });
});
