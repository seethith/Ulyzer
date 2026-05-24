# Agent Tool Boundaries

Tools are split by the loop that can call them. A tool should be visible only to
the agent profile that needs it.

- `chat-tools/`: user-facing node tutor tools selected during ordinary dialogue.
- `tutor-tools/`: internal helpers for the material generation loop.
- `dag-tools/`: main tutor route-editing tools and route-generation search support.
- `tool-catalog.ts`: namespace-aware catalog used before building an `AgentToolRegistry`.
- `tool-permissions.ts`: centralized capability policy for `readOnly`, file writes, DAG mutation, web access and result-size limits.
- `registry.ts`: shared adapter that turns local tool modules into the common `AgentToolRegistry` shape.

## Adding A Tool

1. Choose the namespace by visibility:
   - conversation command or user request: `chat-tools`;
   - internal material-writing helper: `tutor-tools`;
   - route graph mutation/search: `dag-tools`.
2. Implement the tool in that namespace.
3. Export it from the namespace `index.ts`.
4. Add a matching `tool-permissions.ts` entry.
5. Add the tool name to the owning `AgentProfile` if the model may call it.
6. Add tests for registration, permissions and the success/failure behavior.

Do not register a tool in multiple namespaces unless the same capability is
intentionally available in both loops. When a tool starts a long-running
operation, call a registered workflow instead of embedding workflow orchestration
inside the tool body.

## Error And Result Rules

- Tool failures should pass through `normalizeAgentError`.
- User-visible failure text should use the normalized message.
- Save/file tools should classify persistence failures as `SAVE_FAILED`.
- Network or provider failures should preserve retryability from the LLM error classifier.
- Large or privileged results must be constrained by `tool-permissions.ts`.

## What Does Not Belong In Tools

- Broad role prompts or tutor behavior policy.
- Context-pack construction.
- Raw IPC routing.
- A private LLM tool loop.
- Workflow progress event shaping.

Those responsibilities live in `agent-profiles/`, `agent-policy/`,
`agent-context/`, `agent-core/` and `agent-workflows/`.
