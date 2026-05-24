import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningSourceEvaluation, LearningSourcePlan } from '@shared/types';
import { executeLearningSearchPlan } from './learning-search-executor';
import { missingMustHaveSlots, runLearningGapSearch } from './learning-gap-search';

vi.mock('./learning-search-executor', () => ({
  executeLearningSearchPlan: vi.fn(async (input) => ({
    candidates: [],
    queriesUsed: input.plan.slots.slice(0, input.maxQueries).map((slot: { id: string; name: string; queryIntents: string[] }) => ({
      slotId: slot.id,
      slotName: slot.name,
      query: slot.queryIntents[0],
    })),
    warnings: [],
  })),
}));

const plan: LearningSourcePlan = {
  id: 'plan-1',
  courseId: 'course-1',
  taskType: 'practice',
  userGoal: '线性代数',
  learningShape: 'exam_course',
  planningRationale: 'test',
  createdAt: new Date().toISOString(),
  slots: [{
    id: 'structure',
    name: '课程结构',
    purpose: '课程大纲',
    mustHave: true,
    priority: 'high',
    queryIntents: ['linear algebra syllabus'],
    qualityCriteria: ['系统'],
    acceptableSourceTypes: ['course_syllabus'],
  }, {
    id: 'practice',
    name: '练习题',
    purpose: '练习题和作业',
    mustHave: true,
    priority: 'high',
    queryIntents: ['linear algebra problem set'],
    qualityCriteria: ['有题目'],
    acceptableSourceTypes: ['exercise_or_assignment'],
  }, {
    id: 'extra',
    name: '补充案例',
    purpose: '可选案例',
    mustHave: false,
    priority: 'low',
    queryIntents: ['linear algebra cases'],
    qualityCriteria: ['案例'],
    acceptableSourceTypes: ['project_or_case'],
  }],
};

function evaluation(slotId: string): LearningSourceEvaluation {
  return {
    url: `https://example.com/${slotId}`,
    slotId,
    sourceType: 'course_syllabus',
    trustLevel: 'educational',
    qualityScore: 0.72,
    whyUseful: 'test',
    limitations: '',
    shouldIngest: true,
    enabledByDefault: true,
    mainEvidence: false,
  };
}

describe('learning gap search', () => {
  beforeEach(() => {
    vi.mocked(executeLearningSearchPlan).mockClear();
  });

  it('finds missing must-have slots', () => {
    const missing = missingMustHaveSlots({
      plan,
      evaluations: [evaluation('structure')],
    });
    expect(missing.map((slot) => slot.id)).toEqual(['practice']);
  });

  it('does not force follow-up for missing optional slots', () => {
    const missing = missingMustHaveSlots({
      plan,
      evaluations: [evaluation('structure'), evaluation('practice')],
    });
    expect(missing).toEqual([]);
  });

  it('runs bounded follow-up search for missing slots', async () => {
    const result = await runLearningGapSearch({
      plan,
      evaluations: [],
      taskType: 'practice',
      maxQueries: 1,
      maxResultsPerQuery: 3,
      searchDepth: 'basic',
    });
    expect(executeLearningSearchPlan).toHaveBeenCalledOnce();
    expect(result.queriesUsed).toHaveLength(1);
    expect(result.missingSlots.map((slot) => slot.id)).toEqual(['structure', 'practice']);
  });
});
