import type { SearchMode } from '@shared/types';
import type { CommandContext } from '../commands/registry';
import type { PolicyLayerCtx } from '../agent-policy/policy-layer-registry';
import { runChatAgent, type ChatAgentRunSpec } from './chat-agent-runner';
import type { AgentRequest } from './orchestrator';
import { AgentRunContext } from './run-context';
import type { AgentProfile } from './run-state';

/**
 * Declarative contract for an agent's chat path. An agent supplies its profile
 * plus per-run builders; `runAgentDefinition` owns the boilerplate (run context,
 * usage source, error metadata, slash-command wiring) that every agent shared.
 *
 * Combined with `composeSystemPrompt` (policy-layer-registry) and
 * `composeMiddlewares` (agent-middleware), adding an agent is mostly: declare a
 * profile, build its tool context, list its middlewares.
 */
export interface AgentDefinition<TCtx> {
  readonly profile: AgentProfile;
  /** Usage-ledger source tag for this agent's runs. */
  readonly usageSource: string;
  buildCommandContext(req: AgentRequest): CommandContext;
  buildRunSpec(
    req: AgentRequest,
    runContext: AgentRunContext,
  ): Promise<ChatAgentRunSpec<TCtx>> | ChatAgentRunSpec<TCtx>;
}

/** The effective search mode for a request (defaults to 'auto' when unset). */
export function resolveSearchMode(req: AgentRequest): SearchMode {
  return req.searchMode ?? 'auto';
}

/** Build the inputs the policy-layer registry needs to compose a system prompt. */
export function resolvePolicyLayerCtx(
  profile: AgentProfile,
  req: AgentRequest,
  hasNode: boolean,
): PolicyLayerCtx {
  return {
    language: req.language,
    scope: profile.scope,
    rolePromptKey: profile.rolePromptKey,
    audience: profile.agentChannel,
    searchMode: resolveSearchMode(req),
    provider: req.provider,
    model: req.model,
    hasNode,
  };
}

/**
 * Run an agent definition end-to-end: create the shared run context, then drive
 * the existing `runChatAgent` engine with the definition's per-run spec builder.
 */
export async function runAgentDefinition<TCtx>(
  def: AgentDefinition<TCtx>,
  req: AgentRequest,
): Promise<void> {
  const runContext = new AgentRunContext({
    sessionId: req.sessionId,
    courseId: req.courseId,
    nodeId: req.nodeId,
    threadId: req.threadId,
    provider: req.provider,
    model: req.model,
    usageSource: def.usageSource,
    sender: req.senderEvent.sender,
    signal: req.signal,
    recorder: req.recorder,
    errorDetails: {
      agentType: req.type,
      provider: req.provider,
      model: req.model,
      searchMode: resolveSearchMode(req),
      ...(req.nodeId ? { nodeId: req.nodeId } : {}),
    },
  });

  await runChatAgent({
    req,
    runContext,
    commandContext: def.buildCommandContext(req),
    buildRunSpec: (runReq) => def.buildRunSpec(runReq, runContext),
  });
}
