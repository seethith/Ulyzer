import type { SearchMode } from '@shared/types';
import type { AgentPolicyLayerId, AgentProfile, AgentScope } from '../agent-core/run-state';
import {
  buildSystemPrompt,
  languageLayer,
  modelIdentityLayer,
  roleLayer,
} from '../prompt/prompt-builder';
import type { RoleKey } from '../agent-i18n/prompt-catalog';
import {
  folderPolicyLayer,
  generalLearningAssistantRolePolicyLayer,
  nodeTutorChatRolePolicyLayer,
  nodeTutorToolRoutingPolicyLayer,
  nodeTutorWorkflowRoutingPolicyLayer,
  searchPolicyLayer,
  tutorGuidancePolicyLayer,
} from './index';
import type { SearchPolicyAudience } from './types';

/**
 * Runtime inputs every policy layer may need to resolve itself.
 * Assembled once per run from the request + profile, then handed to the registry
 * so `system prompt` composition is driven by `profile.policyLayers` rather than
 * each agent hand-listing the same layers (see the pre-refactor sub-tutor.ts).
 */
export interface PolicyLayerCtx {
  language?: string;
  scope: AgentScope;
  rolePromptKey: string;
  audience: SearchPolicyAudience;
  searchMode: SearchMode;
  provider: string;
  model: string;
  /** Whether a concrete node is active. Node-scoped layers are skipped when false. */
  hasNode: boolean;
}

/** A layer factory; returns `null` to opt out of a layer for the current state. */
export type PolicyLayerResolver = (ctx: PolicyLayerCtx) => (() => string | Promise<string>) | null;

/**
 * Maps each declarable layer id to a resolver. Resolvers reproduce the exact
 * composition the tutors built by hand before the refactor:
 * - `role` switches by scope/node presence (node-tutor chat vs general assistant vs course role)
 * - node-only layers (`guidance`/`toolRouting`/`folderPolicy`/`workflowRouting`) are skipped
 *   when no node is active, matching sub-tutor's no-node branch.
 */
const POLICY_LAYER_REGISTRY: Record<AgentPolicyLayerId, PolicyLayerResolver> = {
  role: (ctx) =>
    ctx.scope === 'node'
      ? ctx.hasNode
        ? nodeTutorChatRolePolicyLayer(ctx.language)
        : generalLearningAssistantRolePolicyLayer(ctx.language)
      : roleLayer(ctx.rolePromptKey as RoleKey, ctx.language),
  guidance: (ctx) => (ctx.hasNode ? tutorGuidancePolicyLayer(ctx.language) : null),
  toolRouting: (ctx) => (ctx.hasNode ? nodeTutorToolRoutingPolicyLayer(ctx.language) : null),
  folderPolicy: (ctx) => (ctx.hasNode ? folderPolicyLayer(ctx.language) : null),
  workflowRouting: (ctx) => (ctx.hasNode ? nodeTutorWorkflowRoutingPolicyLayer(ctx.language) : null),
  searchPolicy: (ctx) => searchPolicyLayer(ctx.searchMode, ctx.audience, ctx.language),
  modelIdentity: (ctx) => modelIdentityLayer(ctx.provider, ctx.model, ctx.language),
  language: (ctx) => languageLayer(ctx.language),
};

/**
 * Compose a system prompt from `profile.policyLayers`, in declared order.
 * `overrides` lets an AgentDefinition swap a single layer's resolver without
 * forking the whole composition.
 */
export async function composeSystemPrompt(
  profile: AgentProfile,
  ctx: PolicyLayerCtx,
  overrides?: Partial<Record<AgentPolicyLayerId, PolicyLayerResolver>>,
): Promise<string> {
  const layers = profile.policyLayers
    .map((id) => (overrides?.[id] ?? POLICY_LAYER_REGISTRY[id])(ctx))
    .filter((layer): layer is () => string | Promise<string> => layer !== null);
  return buildSystemPrompt(...layers);
}
