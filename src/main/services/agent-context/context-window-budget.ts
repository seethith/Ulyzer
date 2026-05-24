import type { ThinkingMode } from '@shared/types';
import { resolveModelCapability, resolveThinkingBudget } from '../llm/model-capabilities';

export type ContextTaskKind = 'chat' | 'roadmap' | 'material' | 'utility';

export interface ContextWindowBudget {
  contextWindow: number;
  maxOutputTokens: number;
  reservedOutputTokens: number;
  reservedThinkingTokens: number;
  safetyTokens: number;
  inputBudget: number;
  compressAt: number;
  collapseAt: number;
}

function outputReserveForTask(taskKind: ContextTaskKind, maxOutputTokens: number): number {
  if (taskKind === 'roadmap') return Math.min(Math.max(16_000, Math.floor(maxOutputTokens * 0.75)), maxOutputTokens);
  if (taskKind === 'material') return Math.min(Math.max(8_192, Math.floor(maxOutputTokens * 0.5)), maxOutputTokens);
  if (taskKind === 'utility') return Math.min(2_048, maxOutputTokens);
  return Math.min(8_192, maxOutputTokens);
}

export function resolveContextWindowBudget(input: {
  provider: string;
  model: string;
  taskKind?: ContextTaskKind;
  thinkingMode?: ThinkingMode;
  requestedMaxOutputTokens?: number;
}): ContextWindowBudget {
  const capability = resolveModelCapability(input.provider, input.model);
  const contextWindow = Math.max(8_192, capability.contextWindow);
  const maxOutputTokens = Math.max(1_024, capability.maxOutputTokens);
  const requested = input.requestedMaxOutputTokens
    ? Math.min(input.requestedMaxOutputTokens, maxOutputTokens)
    : undefined;
  const reservedOutputTokens = requested ?? outputReserveForTask(input.taskKind ?? 'chat', maxOutputTokens);
  const reservedThinkingTokens = resolveThinkingBudget(
    input.provider,
    input.model,
    input.thinkingMode,
  ) ?? 0;
  const safetyTokens = Math.max(1_024, Math.floor(contextWindow * 0.05));
  const inputBudget = Math.max(
    1_024,
    Math.floor(contextWindow - reservedOutputTokens - reservedThinkingTokens - safetyTokens),
  );

  return {
    contextWindow,
    maxOutputTokens,
    reservedOutputTokens,
    reservedThinkingTokens,
    safetyTokens,
    inputBudget,
    compressAt: Math.floor(inputBudget * 0.78),
    collapseAt: Math.floor(inputBudget * 0.9),
  };
}
