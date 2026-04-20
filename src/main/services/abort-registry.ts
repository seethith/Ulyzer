/**
 * Shared abort registry — both llm.ipc and agent.ipc register their
 * AbortControllers here so a single LLM_ABORT handler can cancel any stream.
 */
const registry = new Map<string, AbortController>();

export function registerAbort(sessionId: string, controller: AbortController): void {
  registry.set(sessionId, controller);
}

export function unregisterAbort(sessionId: string): void {
  registry.delete(sessionId);
}

export function abortSession(sessionId: string): void {
  const controller = registry.get(sessionId);
  if (controller) {
    controller.abort();
    registry.delete(sessionId);
  }
}
