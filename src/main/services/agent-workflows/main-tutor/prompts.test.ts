import { describe, expect, it } from 'vitest';
import { DagPromptBuilder } from './prompts';
import type { NodeTarget } from './types';

const target: NodeTarget = {
  min: 15,
  max: 25,
  chapters: '5-7',
  label: 'default',
};

describe('DagPromptBuilder', () => {
  it('adds strict source-library constraints in library mode', () => {
    const prompt = new DagPromptBuilder().buildGenerationPrompt(target, { searchMode: 'library' });

    expect(prompt).toContain('严格参考库模式');
    expect(prompt).toContain('不得联网');
    expect(prompt).toContain('不得凭通用课程体系补出参考库中没有的章节');
  });

  it('keeps normal modes open to complete curriculum coverage', () => {
    const prompt = new DagPromptBuilder().buildGenerationPrompt(target, { searchMode: 'auto' });

    expect(prompt).not.toContain('严格参考库模式');
    expect(prompt).toContain('优先保证知识结构完整');
  });
});
