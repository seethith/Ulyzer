import { describe, expect, it } from 'vitest';
import type { LearningSearchCandidate, LearningSourcePlan } from '@shared/types';
import { evaluateLearningCandidates } from './learning-source-evaluator';

const plan: LearningSourcePlan = {
  id: 'plan-1',
  courseId: 'course-1',
  taskType: 'roadmap',
  userGoal: 'React 入门',
  learningShape: 'tool_software',
  planningRationale: 'test',
  createdAt: new Date().toISOString(),
  slots: [{
    id: 'structure',
    name: '课程结构',
    purpose: '找官方或系统课程结构',
    mustHave: true,
    priority: 'high',
    queryIntents: ['React official tutorial learning objectives'],
    qualityCriteria: ['官方', '系统'],
    acceptableSourceTypes: ['official_doc', 'course_syllabus', 'tutorial'],
  }, {
    id: 'rubric',
    name: '评分标准',
    purpose: '找评分标准和作业要求',
    mustHave: true,
    priority: 'high',
    queryIntents: ['React assignment rubric'],
    qualityCriteria: ['有评分标准'],
    acceptableSourceTypes: ['rubric_or_assessment'],
  }],
};

const creativePlan: LearningSourcePlan = {
  ...plan,
  id: 'plan-creative',
  userGoal: '二次元 cosplay 入门到独立出片',
  learningShape: 'creative_project',
  slots: [{
    id: 'mistakes_constraints',
    name: '常见误区与限制',
    purpose: '找到真实制作流程里的常见错误、材料风险、成本限制和实践注意事项。',
    mustHave: true,
    priority: 'high',
    queryIntents: ['cosplay 常见错误 材料 工具 注意事项'],
    qualityCriteria: ['真实经验', '有可操作建议'],
    acceptableSourceTypes: ['common_mistake', 'safety_or_constraint', 'community_experience'],
  }],
};

const examPlan: LearningSourcePlan = {
  ...plan,
  id: 'plan-exam',
  userGoal: '线性代数学习路线图',
  learningShape: 'exam_course',
  slots: [{
    id: 'learning_structure',
    name: '课程结构',
    purpose: '找到教材目录、课程大纲和正式学习目标。',
    mustHave: true,
    priority: 'high',
    queryIntents: ['线性代数 课程大纲 教材目录'],
    qualityCriteria: ['课程结构', '权威来源'],
    acceptableSourceTypes: ['course_syllabus', 'textbook_or_notes'],
  }],
};

function candidate(partial: Partial<LearningSearchCandidate>): LearningSearchCandidate {
  return {
    slotId: 'structure',
    query: 'React official tutorial learning objectives',
    title: 'React Official Documentation: Learn React',
    url: 'https://react.dev/learn',
    excerpt: 'Official React documentation with learning objectives, examples, practice steps, curriculum structure, and guided tutorials. '.repeat(12),
    provider: 'tavily',
    rawScore: 0.62,
    ...partial,
  };
}

describe('evaluateLearningCandidates', () => {
  it('scores official documentation as high-quality main evidence', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({})],
      plan,
      taskType: 'roadmap',
      allowCommunityAutoImport: true,
    });
    expect(result.evaluations[0].qualityScore).toBeGreaterThanOrEqual(0.78);
    expect(result.evaluations[0].sourceType).toBe('official_doc');
    expect(result.evaluations[0].mainEvidence).toBe(true);
  });

  it('never promotes community posts to main evidence', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        title: 'Reddit discussion about learning React',
        url: 'https://www.reddit.com/r/reactjs/comments/example',
        excerpt: 'Personal opinions, community discussion, beginner tips, mistakes, and informal recommendations. '.repeat(8),
        rawScore: 0.95,
      })],
      plan,
      taskType: 'roadmap',
      allowCommunityAutoImport: true,
    });
    expect(result.evaluations[0].sourceType).toBe('community_experience');
    expect(result.evaluations[0].mainEvidence).toBe(false);
  });

  it('downgrades very short content', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        title: 'React tips',
        url: 'https://example.com/react',
        excerpt: 'Short.',
        rawScore: 0.5,
      })],
      plan,
      taskType: 'roadmap',
      allowCommunityAutoImport: true,
    });
    expect(result.evaluations[0].shouldIngest).toBe(false);
    expect(result.evaluations[0].qualityScore).toBeLessThan(0.55);
  });

  it('blocks thesis and document-sharing sources before they enter the evidence pack', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        title: '线性代数本科毕业论文开题报告范文下载',
        url: 'https://wenku.baidu.com/view/example',
        query: '线性代数 课程大纲 教材目录',
        excerpt: '本文档为本科毕业论文、开题报告、论文范文下载，包含若干线性代数相关内容。'.repeat(8),
        rawScore: 0.96,
      })],
      plan: examPlan,
      taskType: 'theory',
      allowCommunityAutoImport: false,
    });
    expect(result.evaluations[0].shouldIngest).toBe(false);
    expect(result.evaluations[0].mainEvidence).toBe(false);
    expect(result.evaluations[0].limitations).toContain('来源风险');
  });

  it('penalizes source types that do not match the slot', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        slotId: 'rubric',
        title: 'React beginner tutorial',
        url: 'https://example.com/react-tutorial',
        excerpt: 'A beginner tutorial with concepts, examples, and steps for building small components. '.repeat(10),
        rawScore: 0.6,
      })],
      plan,
      taskType: 'practice',
      allowCommunityAutoImport: true,
    });
    expect(result.evaluations[0].sourceType).toBe('tutorial');
    expect(result.evaluations[0].qualityScore).toBeLessThan(0.7);
  });

  it('conditionally imports high-quality community experience for practical learning slots', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        slotId: 'mistakes_constraints',
        title: 'Cosplay 新手踩坑经验：假发、妆造、道具材料注意事项',
        url: 'https://www.zhihu.com/question/cosplay-example',
        query: 'cosplay 常见错误 材料 工具 注意事项',
        excerpt: '个人实践经验，包含材料工具选择、假发处理、妆造步骤、常见错误、安全风险、成本控制和现场复盘。'.repeat(16),
        rawScore: 0.92,
      })],
      plan: creativePlan,
      taskType: 'roadmap',
      allowCommunityAutoImport: false,
    });
    expect(result.evaluations[0].sourceType).toBe('community_experience');
    expect(result.evaluations[0].shouldIngest).toBe(true);
    expect(result.evaluations[0].enabledByDefault).toBe(true);
    expect(result.evaluations[0].mainEvidence).toBe(false);
    expect(result.evaluations[0].limitations).toContain('实践补充');
  });

  it('still blocks community posts for strict exam-course structure slots by default', async () => {
    const result = await evaluateLearningCandidates({
      candidates: [candidate({
        slotId: 'learning_structure',
        title: '线性代数怎么学的个人经验',
        url: 'https://www.zhihu.com/question/linear-algebra-example',
        query: '线性代数 课程大纲 教材目录',
        excerpt: '个人经验帖，讨论学习线性代数的感受、踩坑、推荐顺序和一些主观建议。'.repeat(16),
        rawScore: 0.92,
      })],
      plan: examPlan,
      taskType: 'roadmap',
      allowCommunityAutoImport: false,
    });
    expect(result.evaluations[0].sourceType).toBe('community_experience');
    expect(result.evaluations[0].shouldIngest).toBe(false);
    expect(result.evaluations[0].mainEvidence).toBe(false);
    expect(result.evaluations[0].limitations).toContain('当前设置不允许');
  });

  it('caps conditional community imports to avoid filling the library with experience posts', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({
      slotId: 'mistakes_constraints',
      title: `Cosplay 实践经验 ${index + 1}`,
      url: `https://www.zhihu.com/question/cosplay-${index + 1}`,
      query: 'cosplay 常见错误 材料 工具 注意事项',
      excerpt: '个人实践经验，包含材料工具选择、假发处理、妆造步骤、常见错误、安全风险、成本控制和现场复盘。'.repeat(16),
      rawScore: 0.95 - index * 0.02,
    }));
    const result = await evaluateLearningCandidates({
      candidates,
      plan: creativePlan,
      taskType: 'roadmap',
      allowCommunityAutoImport: false,
    });
    expect(result.evaluations.filter((item) => item.shouldIngest).length).toBe(3);
    expect(result.evaluations[3].limitations).toContain('避免参考库被经验帖占满');
  });
});
