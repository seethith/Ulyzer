import { describe, expect, it } from 'vitest';
import { extractExerciseCandidatesFromText } from './source-exercises';

describe('source exercise extraction', () => {
  it('extracts question, choices, answer, and solution markers', () => {
    const text = `
练习 1：判断下列说法是否正确。
A. 任何方阵都有逆矩阵
B. 可逆矩阵的行列式不为 0
C. 零矩阵可逆
D. 单位矩阵不可逆

参考答案：B。

解析：可逆矩阵等价于行列式非零，A/C/D 都是常见误解。
`;
    const exercises = extractExerciseCandidatesFromText(text, {
      sourceLocator: 'p.12',
      licenseStatus: 'user_import',
    });
    expect(exercises).toHaveLength(1);
    expect(exercises[0].choices).toHaveLength(4);
    expect(exercises[0].answerMd).toContain('B');
    expect(exercises[0].solutionMd).toContain('行列式');
    expect(exercises[0].itemType).toBe('multiple_choice');
  });

  it('ignores ordinary prose without exercise starts', () => {
    const exercises = extractExerciseCandidatesFromText('矩阵是由数字排列成的矩形阵列。这里介绍基本概念和背景。');
    expect(exercises).toHaveLength(0);
  });

  it('ignores grading rubrics and assignment scoring tables', () => {
    const text = `
作业 100
根据作业完成及正确率情况计分；10%
期末
成绩
考核
50%
期末

题目 1：作业评分标准
提交时间（权重 0.1）按时提交 延时半天 延时一天 超过一天提交
规范性（权重 0.2）规范、整洁、美观 较整洁 不整洁
正确率（权重 0.4）≥ 90% ≥ 80% ≥ 60% < 60%
`;
    const exercises = extractExerciseCandidatesFromText(text, {
      sourceLocator: 'page 303 block 1',
    });
    expect(exercises).toHaveLength(0);
  });

  it('ignores syllabus and teaching objective fragments', () => {
    const text = `
问题 1：
课程目标 1 支撑毕业要求指标点 2.1
教学内容：矩阵与二次型 4 学时
考核方式：课堂表现 10% 作业 20% 期末考试 70%
达成度评价：按照课程目标达成情况统计
`;
    const exercises = extractExerciseCandidatesFromText(text);
    expect(exercises).toHaveLength(0);
  });

  it('keeps assignment prompts when they contain a real task action', () => {
    const text = `
作业 1：
根据下列矩阵 A，计算其行列式，并说明每一步行变换对结果的影响。

A = [[1, 2], [3, 4]]
`;
    const exercises = extractExerciseCandidatesFromText(text, {
      licenseStatus: 'user_import',
    });
    expect(exercises).toHaveLength(1);
    expect(exercises[0].stemMd).toContain('计算其行列式');
  });
});
