# Agent Core

`agent-core/` contains the shared runtime used by every tutor channel. It should
stay generic: no course-specific prompt text, no tool-specific business logic and
no workflow-specific persistence.

## Request Flow

1. `AgentOrchestrator` receives an `AgentRequest` from IPC.
2. The selected tutor calls `runChatAgent`.
3. `AgentProfileResolver` applies profile policy, context packs, allowed tools
   and loop config.
4. `runToolChatLoop` runs the model/tool conversation.
5. `AgentRunContext` emits stream, completion, failure and artifact events.
6. `AgentRuntime` manages run state, aborts and standard failure events.

This is the shared path for main tutor chat, sub tutor chat, route planning
tool calls and material generation tool calls. New AI features should reuse this
path unless they are explicitly outside the tutor conversation product surface.

## File Ownership

- `chat-agent-runner.ts`: resolves profile-driven chat run specs.
- `profile-resolver.ts`: validates allowed tools, workflows, context packs and loop config.
- `tool-chat-loop.ts`: the one shared outer LLM tool loop.
- `run-context.ts`: stream/progress/file/DAG event bridge to the renderer.
- `runtime.ts` and `run-state.ts`: run lifecycle, plans and abort handling.
- `agent-events.ts`: standard event payload builders.
- `agent-errors.ts`: standard error codes, retryability and payload normalization.
- `event-bus.ts`: internal run lifecycle events.

## Extension Rules

- Put role policy in `agent-profiles/` and `agent-policy/`, then consume it through
  `AgentProfileResolver`.
- Put tools in `agent-tools/`, then expose them through a profile allowlist.
- Put long-running business operations in `agent-workflows/`, then register them
  with `workflow-runner.ts`.
- Put context selection in `agent-context/`.
- Keep provider/model implementation in the LLM provider layer.

Do not add tutor-specific branches, hardcoded prompts, direct database writes or
private tool permission checks to `agent-core/`.

## Test Expectations

Core changes should cover:

- profile resolution and tool filtering;
- direct chat and tool-call loop behavior;
- abort behavior;
- standardized stream/error/end payloads;
- retryable vs non-retryable error classification.
