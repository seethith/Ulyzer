import { describe, expect, it } from 'vitest';
import {
  getGenerationDefaultPrefixes,
  getMaterialGenerationSkill,
  getMaterialWorkflowPrompt,
  listSkills,
} from './registry';
import { buildFeynmanReviewWorkflowPrompt } from './feynman-review.skill';

describe('agent skill registry', () => {
  it('registers the phase 5 priority skills with executable declarations', () => {
    expect(listSkills().map((skill) => skill.id)).toEqual([
      'generate_theory_material',
      'generate_practice_material',
      'feynman_review',
    ]);

    for (const skill of listSkills()) {
      expect(skill.workflowPrompt.zh.length).toBeGreaterThan(20);
      expect(skill.workflowPrompt.en.length).toBeGreaterThan(20);
    }
  });

  it('resolves material generation prompts by folder', () => {
    expect(getMaterialGenerationSkill('theory')?.id).toBe('generate_theory_material');
    expect(getMaterialGenerationSkill('practice')?.id).toBe('generate_practice_material');
    expect(getMaterialGenerationSkill('answer')?.id).toBe('generate_practice_material');
    expect(getMaterialGenerationSkill('notes')).toBeUndefined();

    expect(getMaterialWorkflowPrompt('practice', 'zh')).toContain('generate_quiz');
    expect(getMaterialWorkflowPrompt('practice', 'zh')).toContain('folderName: "answer"');
    expect(getMaterialWorkflowPrompt('theory', 'en')).toContain('learning-function slots');
    expect(getMaterialWorkflowPrompt('theory', 'zh')).toContain('真实问题入口');
    expect(getMaterialWorkflowPrompt('theory', 'en')).toContain('Learning Blueprint / Outline');
    expect(getMaterialWorkflowPrompt('answer', 'en')).toContain('folderName must be "answer"');
  });

  it('centralizes default generation request prefixes', () => {
    const prefixes = getGenerationDefaultPrefixes();

    expect(prefixes).toContain('请帮我生成相关学习资料');
    expect(prefixes).toContain('请按照当前节点的知识纲要，为我生成一份原理资料');
    expect(prefixes).toContain('请按照当前节点的知识纲要，为我生成一套练习题');
    expect(prefixes).toContain("I've finished this node. Please generate a Feynman review checklist");
  });

  it('builds the feynman review workflow prompt from the skill layer', () => {
    const prompt = buildFeynmanReviewWorkflowPrompt({
      nodeName:          'Gradient Descent',
      chapter:           'Optimization',
      difficultyLabel:   'Intermediate',
      outlineText:       '### KC1: Learning Rate',
      learningType:      'intellectual_skill',
      bloomTarget:       'apply',
      prerequisiteNames: 'Derivatives',
      language:          'en',
    });

    expect(prompt).toContain('five-part deep Feynman review checklist');
    expect(prompt).toContain('Learning Rate');
    expect(prompt).toContain('Derivatives');
    expect(prompt).toContain('Boundary conditions');
  });
});
