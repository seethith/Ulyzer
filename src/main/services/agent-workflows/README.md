# Agent Workflow Boundaries

This app keeps normal learning actions behind one conversation entry:
`IPC.AGENT_CHAT` with `action: 'chat'`. Main tutor, sub tutor, route planning,
material generation and ordinary dialogue all enter through that chat path, then
branch by profile, tools and registered workflow IDs.

## Runtime Shape

1. `AgentOrchestrator` receives chat requests and chooses the tutor channel.
2. `runChatAgent` resolves the `AgentProfile`, context packs, policy layers,
   tool registry and loop config.
3. The model can answer directly or call a registered tool.
4. Tools may start long-running workflows through `workflow-runner.ts`.
5. Workflows report progress through `WorkflowLifecycle` and `AgentRunContext`.

Keep `runToolChatLoop` as the only outer LLM tool loop for tutor conversations.
Workflow modules can run their own internal steps, but should not create a second
conversation loop that bypasses profile policy, tool permissions or standard
error events.

## Current Ownership

- `route.generate`: route/DAG generation from main tutor chat.
- `material.generate`: theory/practice material generation from sub tutor chat tools.
- `outline.generateNext`: knowledge outline generation and upgrade.
- `topic.generate`: node topic expansion.
- `main-tutor.ts`: main tutor chat wiring, route-planning tools and route workflow call.
- `sub-tutor.ts`: node tutor chat wiring, node context and material tool exposure.
- `main-tutor/*`: route generation internals only.
- `material/material-generation-loop.ts`: theory/practice generation loop and save-file orchestration.
- `workflow-lifecycle.ts`: shared progress, failure and generated-artifact event behavior.
- `workflow-runner.ts`: workflow dispatcher only.

## Adding A Workflow

1. Put implementation under `agent-workflows/<domain>/`.
2. Add the workflow ID to `workflow-types.ts`.
3. Register the handler in `workflow-runner.ts`.
4. Trigger it from a tool or existing tutor path, not from a new IPC route.
5. Wrap progress/failure/file events with `WorkflowLifecycle`.
6. Add tests for runner registration, lifecycle events and error normalization.

Use a direct renderer action only when the product is intentionally adding a new
non-chat UI. Normal AI features should be reachable by chat and tools.

## What Does Not Belong Here

- Role behavior, tone rules, allowed workflows and allowed tools belong in
  `agent-profiles/` and `agent-policy/`.
- Context-pack selection belongs in `agent-context/context-pack-resolver.ts`.
- Tool registration and permissions belong in `agent-tools/`.
- Provider/model/API fixes belong in the LLM provider layer.
- Tutor files should not hardcode broad policy, duplicate loop logic, or keep
  private copies of tool permission rules.

## Test Expectations

Workflow changes should cover:

- workflow dispatch through `workflow-runner.ts`;
- progress and generated artifact events through `WorkflowLifecycle`;
- abort and failure payloads using standard agent error codes;
- preservation of the normal chat path for direct answers and tool calls.
