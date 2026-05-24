import { describe, expect, it, vi } from 'vitest';
import { LLMAdapter } from '../llm/adapter';
import { planLearningSources } from './learning-source-planner';

function slotText(plan: Awaited<ReturnType<typeof planLearningSources>>): string {
  return plan.slots.map((slot) => [
    slot.id,
    slot.name,
    slot.purpose,
    slot.queryIntents.join(' '),
  ].join(' ')).join('\n');
}

describe('planLearningSources fallback planner', () => {
  it('plans linear algebra with structure, textbook, practice, and misconception slots', async () => {
    const plan = await planLearningSources({
      courseId: 'course-1',
      taskType: 'roadmap',
      userGoal: '线性代数',
      searchMode: 'web',
    });
    const text = slotText(plan);
    expect(plan.learningShape).toBe('exam_course');
    expect(text).toMatch(/学习结构|进阶顺序/);
    expect(text).toMatch(/教材目录|讲义结构/);
    expect(text).toMatch(/练习任务|项目/);
    expect(text).toMatch(/误区|限制/);
  });

  it('plans cosplay with materials, safety, steps, and cases', async () => {
    const plan = await planLearningSources({
      courseId: 'course-1',
      taskType: 'roadmap',
      userGoal: 'cosplay 道具与服装制作',
      searchMode: 'web',
    });
    const text = slotText(plan);
    expect(plan.learningShape).toBe('creative_project');
    expect(text).toMatch(/材料工具|安全准备/);
    expect(text).toMatch(/方法步骤|案例/);
    expect(text).toMatch(/练习任务|项目/);
  });

  it('plans game learning with mechanics, versions, operations, and practice', async () => {
    const plan = await planLearningSources({
      courseId: 'course-1',
      taskType: 'roadmap',
      userGoal: '学习王者荣耀',
      searchMode: 'web',
    });
    const text = slotText(plan);
    expect(plan.learningShape).toBe('game_system');
    expect(text).toMatch(/机制系统|版本变化/);
    expect(text).toMatch(/操作训练|实战复盘/);
    expect(text).toMatch(/练习任务|项目/);
  });

  it('plans social etiquette with scenarios, boundaries, practice, and cultural differences', async () => {
    const plan = await planLearningSources({
      courseId: 'course-1',
      taskType: 'roadmap',
      userGoal: '学习社交礼仪',
      searchMode: 'web',
    });
    const text = slotText(plan);
    expect(plan.learningShape).toBe('social_behavior');
    expect(text).toMatch(/场景边界|文化差异/);
    expect(text).toMatch(/练习任务|项目/);
    expect(text).toMatch(/误区|限制/);
  });

  it('falls back when the LLM planner fails', async () => {
    const spy = vi.spyOn(LLMAdapter, 'stream').mockRejectedValueOnce(new Error('planner unavailable'));
    const plan = await planLearningSources({
      courseId: 'course-1',
      taskType: 'roadmap',
      userGoal: 'React 入门',
      searchMode: 'web',
      provider: 'openai',
      model: 'test-model',
    });
    expect(plan.slots.length).toBeGreaterThanOrEqual(4);
    expect(plan.planningRationale).toContain('兜底');
    spy.mockRestore();
  });
});
