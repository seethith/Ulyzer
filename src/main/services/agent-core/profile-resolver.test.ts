import { describe, expect, it } from 'vitest';
import { createAgentToolRegistry } from '../agent-tools/registry';
import type { AgentTool } from '../agent-tools/types';
import { mainTutorProfile } from '../agent-profiles/main-tutor.profile';
import { nodeTutorProfile } from '../agent-profiles/node-tutor.profile';
import { AgentProfileResolver } from './profile-resolver';
import type { AgentProfile } from './run-state';

function tool(name: string): AgentTool<Record<string, unknown>, string> {
  return {
    namespace: 'chat',
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    maxResultChars: 100,
    isReadOnly: true,
    permissions: {
      readOnly: true,
      canWriteFile: false,
      canMutateDag: false,
      canUseWeb: false,
      maxResultChars: 100,
    },
    execute: async () => name,
    formatResult: (output) => output,
  };
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'node_tutor',
    agentChannel: 'sub_tutor',
    scope: 'node',
    rolePromptKey: 'subtutor',
    allowedWorkflows: ['chat'],
    defaultTools: ['a', 'b'],
    contextPacks: [],
    policyLayers: [],
    memoryScopes: [],
    artifactTypes: [],
    verifiers: [],
    loopConfig: { maxTurns: 2, hardMaxTurns: 4, maxTokens: 256 },
    ...overrides,
  };
}

describe('AgentProfileResolver', () => {
  it('resolves profiles by runtime channel', () => {
    const resolver = new AgentProfileResolver([mainTutorProfile, nodeTutorProfile]);

    expect(resolver.getProfile('main_tutor')).toBe(mainTutorProfile);
    expect(resolver.getProfile('sub_tutor')).toBe(nodeTutorProfile);
  });

  it('filters tool registries according to profile defaultTools order', () => {
    const resolver = new AgentProfileResolver([profile()]);
    const registry = createAgentToolRegistry([
      tool('c'),
      tool('b'),
      tool('a'),
    ]);

    const filtered = resolver.filterToolRegistry(registry, profile());

    expect(filtered.names()).toEqual(['a', 'b']);
  });

  it('fails fast when a profile declares a missing tool', () => {
    const resolver = new AgentProfileResolver([profile({ defaultTools: ['missing'] })]);
    const registry = createAgentToolRegistry([tool('a')]);

    expect(() => resolver.filterToolRegistry(registry, profile({ defaultTools: ['missing'] })))
      .toThrow('Tool missing is declared by node_tutor but is not registered');
  });

  it('guards workflow access and exposes loop config copies', () => {
    const resolver = new AgentProfileResolver([profile({ allowedWorkflows: ['chat', 'material.generate'] })]);
    const p = profile({ allowedWorkflows: ['chat', 'material.generate'] });

    expect(() => resolver.assertWorkflowAllowed(p, 'material.generate')).not.toThrow();
    expect(() => resolver.assertWorkflowAllowed(p, 'route.generate')).toThrow('Workflow route.generate is not allowed for node_tutor');
    expect(resolver.getLoopConfig(p)).toEqual({ maxTurns: 2, hardMaxTurns: 4, maxTokens: 256 });
    expect(resolver.getLoopConfig(p)).not.toBe(p.loopConfig);
  });
});
