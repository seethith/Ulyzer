import type { ContextPackId } from '../agent-context/context-pack';

export type AgentChannel = 'main_tutor' | 'sub_tutor';

export type AgentProfileId = 'main_tutor' | 'node_tutor';

export type AgentScope = 'course' | 'node';

export type AgentPolicyLayerId =
  | 'role'
  | 'guidance'
  | 'toolRouting'
  | 'workflowRouting'
  | 'folderPolicy'
  | 'searchPolicy'
  | 'modelIdentity'
  | 'language';

export interface AgentLoopConfig {
  /** Soft turn budget: past this the loop nudges the model to converge, but keeps going while tasks are open. */
  maxTurns: number;
  /** Absolute ceiling: the loop never runs more than this many turns regardless of open tasks. */
  hardMaxTurns: number;
  maxTokens: number;
}

export interface AgentProfile {
  id: AgentProfileId;
  agentChannel: AgentChannel;
  scope: AgentScope;
  rolePromptKey: string;
  allowedWorkflows: string[];
  defaultTools: string[];
  contextPacks: ContextPackId[];
  policyLayers: AgentPolicyLayerId[];
  memoryScopes: string[];
  artifactTypes: string[];
  verifiers: string[];
  loopConfig: AgentLoopConfig;
}
