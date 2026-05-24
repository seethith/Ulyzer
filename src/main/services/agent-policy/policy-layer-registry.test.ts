import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, type PolicyLayerCtx } from './policy-layer-registry';
import { nodeTutorProfile } from '../agent-profiles/node-tutor.profile';
import { mainTutorProfile } from '../agent-profiles/main-tutor.profile';

function nodeCtx(overrides: Partial<PolicyLayerCtx> = {}): PolicyLayerCtx {
  return {
    language: 'zh',
    scope: 'node',
    rolePromptKey: 'subtutor',
    audience: 'sub_tutor',
    searchMode: 'auto',
    provider: 'anthropic',
    model: 'claude',
    hasNode: true,
    ...overrides,
  };
}

describe('composeSystemPrompt', () => {
  it('composes the full node-tutor layer stack when a node is active', async () => {
    const prompt = await composeSystemPrompt(nodeTutorProfile, nodeCtx({ hasNode: true }));
    // role + guidance + toolRouting + folderPolicy + workflowRouting + modelIdentity
    expect(prompt).toContain('AI 学习导师');
    expect(prompt).toContain('严格模式');
    expect(prompt).toContain('generate_theory');
    expect(prompt).toContain('原理资料');
    expect(prompt).toContain('模型身份');
  });

  it('drops node-only layers and uses the general assistant role when no node is active', async () => {
    const prompt = await composeSystemPrompt(nodeTutorProfile, nodeCtx({ hasNode: false }));
    expect(prompt).toContain('AI 学习助手');
    // node-only layers must be skipped
    expect(prompt).not.toContain('严格模式');
    expect(prompt).not.toContain('generate_theory');
    // framework layers still present
    expect(prompt).toContain('模型身份');
  });

  it('uses the catalog role for the course-scoped main tutor', async () => {
    const prompt = await composeSystemPrompt(mainTutorProfile, {
      language: 'zh',
      scope: 'course',
      rolePromptKey: 'maintutor',
      audience: 'main_tutor',
      searchMode: 'auto',
      provider: 'anthropic',
      model: 'claude',
      hasNode: false,
    });
    expect(prompt).toContain('模型身份');
    // main tutor does not wire the node-only guidance layer
    expect(prompt).not.toContain('严格模式');
  });
});
