import type { LearningSourceEvaluation, LearningSourcePlan, LearningSourceSlot, ResearchTaskType } from '@shared/types';
import { executeLearningSearchPlan } from './learning-search-executor';
import type { LearningSearchExecutionResult } from './types';

function slotCovered(slot: LearningSourceSlot, evaluations: LearningSourceEvaluation[]): boolean {
  return evaluations.some((evaluation) =>
    evaluation.slotId === slot.id
    && evaluation.shouldIngest
    && evaluation.qualityScore >= 0.55,
  );
}

function gapQuery(slot: LearningSourceSlot, taskType: ResearchTaskType, userGoal: string): string {
  const base = slot.queryIntents[0] || `${userGoal} ${slot.name}`;
  const text = `${slot.id} ${slot.name} ${slot.purpose}`.toLowerCase();
  if (/练习|题目|作业|practice|exercise|assignment|problem/.test(text)) return `${base} problem set assignment practice exercises`;
  if (/误区|错误|风险|安全|mistake|risk|safety|constraint/.test(text)) return `${base} common mistakes risks safety precautions`;
  if (/项目|案例|作品|project|case|example/.test(text)) return `${base} beginner project tutorial case study examples`;
  if (/课程|结构|路线|大纲|curriculum|syllabus|roadmap|structure/.test(text)) return `${base} syllabus curriculum learning objectives`;
  if (taskType === 'practice' || taskType === 'answer') return `${base} worked examples solutions rubric`;
  return `${base} authoritative tutorial examples`;
}

export function missingMustHaveSlots(input: {
  plan: LearningSourcePlan;
  evaluations: LearningSourceEvaluation[];
  maxSlots?: number;
}): LearningSourceSlot[] {
  return input.plan.slots
    .filter((slot) => slot.mustHave)
    .filter((slot) => !slotCovered(slot, input.evaluations))
    .slice(0, input.maxSlots ?? 2);
}

export async function runLearningGapSearch(input: {
  plan: LearningSourcePlan;
  evaluations: LearningSourceEvaluation[];
  taskType: ResearchTaskType;
  maxQueries: number;
  maxResultsPerQuery: number;
  searchDepth: 'basic' | 'advanced';
  useExa?: boolean;
  signal?: AbortSignal;
}): Promise<LearningSearchExecutionResult & { missingSlots: LearningSourceSlot[] }> {
  const missingSlots = missingMustHaveSlots({ plan: input.plan, evaluations: input.evaluations });
  if (missingSlots.length === 0 || input.maxQueries <= 0) {
    return { candidates: [], queriesUsed: [], warnings: [], missingSlots };
  }

  const gapPlan: LearningSourcePlan = {
    ...input.plan,
    slots: missingSlots.map((slot) => ({
      ...slot,
      queryIntents: [gapQuery(slot, input.taskType, input.plan.userGoal), ...slot.queryIntents].slice(0, 3),
    })),
  };

  const result = await executeLearningSearchPlan({
    plan: gapPlan,
    taskType: input.taskType,
    maxQueries: Math.min(input.maxQueries, missingSlots.length),
    maxResultsPerQuery: input.maxResultsPerQuery,
    searchDepth: input.searchDepth,
    useExa: input.useExa,
    signal: input.signal,
  });
  return { ...result, missingSlots };
}
