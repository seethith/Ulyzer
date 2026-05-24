import { createAgentToolRegistry, type UnifiedToolRegistry } from '../agent-tools/registry';
import type { AgentTool, AgentToolRegistry } from '../agent-tools/types';
import type { AgentChannel, AgentLoopConfig, AgentProfile } from './run-state';

export class AgentProfileResolver {
  private readonly profilesByChannel: Map<AgentChannel, AgentProfile>;

  constructor(profiles: AgentProfile[]) {
    this.profilesByChannel = new Map(profiles.map((profile) => [profile.agentChannel, profile]));
  }

  getProfile(channel: AgentChannel): AgentProfile {
    const profile = this.profilesByChannel.get(channel);
    if (!profile) throw new Error(`Agent profile not registered: ${channel}`);
    return profile;
  }

  getLoopConfig(profile: AgentProfile): AgentLoopConfig {
    return { ...profile.loopConfig };
  }

  assertWorkflowAllowed(profile: AgentProfile, workflowId: string): void {
    if (!profile.allowedWorkflows.includes(workflowId)) {
      throw new Error(`Workflow ${workflowId} is not allowed for ${profile.id}`);
    }
  }

  filterToolRegistry<TContext>(
    registry: AgentToolRegistry<TContext>,
    profile: AgentProfile,
  ): UnifiedToolRegistry<TContext> {
    const selected: AgentTool<TContext>[] = [];
    for (const toolName of profile.defaultTools) {
      const tool = registry.get(toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} is declared by ${profile.id} but is not registered`);
      }
      selected.push(tool);
    }
    return createAgentToolRegistry(selected);
  }
}
