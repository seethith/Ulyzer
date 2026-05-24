import { resolveModelCapability } from '../llm/model-capabilities';

export type OutputBudgetTask =
  | 'material_theory'
  | 'material_practice'
  | 'material_answer'
  | 'outline'
  | 'feynman'
  | 'mindmap'
  | 'utility';

const TASK_TARGETS: Record<OutputBudgetTask, { min: number; preferred: number; max: number }> = {
  material_theory:   { min: 24_000, preferred: 64_000, max: 128_000 },
  material_practice: { min: 32_000, preferred: 96_000, max: 160_000 },
  material_answer:   { min: 24_000, preferred: 64_000, max: 128_000 },
  outline:           { min: 4_000,  preferred: 12_000, max: 24_000 },
  feynman:           { min: 12_000, preferred: 32_000, max: 64_000 },
  mindmap:           { min: 4_000,  preferred: 8_000,  max: 16_000 },
  utility:           { min: 2_048,  preferred: 8_192,  max: 16_384 },
};

export function resolveOutputTokenBudget(input: {
  provider: string;
  model: string;
  task: OutputBudgetTask;
  requestedMaxTokens?: number;
}): number {
  const capability = resolveModelCapability(input.provider, input.model);
  const modelMax = Math.max(1_024, capability.maxOutputTokens);
  if (input.requestedMaxTokens) return Math.max(1_024, Math.min(input.requestedMaxTokens, modelMax));

  const target = TASK_TARGETS[input.task] ?? TASK_TARGETS.utility;
  const desired = Math.max(target.min, Math.min(target.preferred, target.max));
  return Math.max(1_024, Math.min(desired, modelMax));
}
