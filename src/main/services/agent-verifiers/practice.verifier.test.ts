import { describe, expect, it } from 'vitest';
import { verifyKcCoverage } from './material.verifier';
import { verifyPracticeContent, verifyPracticeHasAnswer, verifyPracticeStructure } from './practice.verifier';
import { verifySourceCitation } from './citation.verifier';

describe('practice verifiers', () => {
  const validPractice = [
    '# Practice',
    '## A组：核心原型题',
    '### Q1',
    '- KC：KC1 概念 A',
    '- 布鲁姆：记忆/理解',
    '- 题型：原型题',
    '- 来源策略：AI原创',
    '解释概念 A 在给定边界中的含义。 [AI原创]',
    '## B组：变式训练',
    '### Q2',
    '- KC：KC1 概念 A',
    '- 布鲁姆：分析/评估',
    '- 题型：变式题',
    '- 来源策略：题型参考',
    '比较 A 和 B，并说明限制条件变化后的判断。 来源：https://example.com',
    '## C组：错误诊断',
    '### Q3',
    '- KC：KC2 应用 A',
    '- 布鲁姆：应用',
    '- 题型：错误诊断',
    '- 来源策略：AI原创',
    '给出一个错误方案，定位错误并修正；验收：输出应符合预期。 [AI原创]',
    '## D组：迁移/综合',
    '### Q4',
    '- KC：KC3 综合 A',
    '- 布鲁姆：创造',
    '- 题型：迁移/综合',
    '- 来源策略：AI原创',
    '设计一个使用 A 的方案。评分维度：完整性、准确性、边界处理。 [AI原创]',
  ].join('\n\n');

  it('passes complete four-tier practice content with citations', () => {
    expect(verifyPracticeStructure(validPractice).passed).toBe(true);
    expect(verifySourceCitation(validPractice).passed).toBe(true);
    expect(verifyPracticeContent(validPractice).passed).toBe(true);
  });

  it('accepts source strategy metadata as practice citation evidence', () => {
    expect(verifySourceCitation('- 来源策略：AI原创').passed).toBe(true);
    expect(verifySourceCitation('- 来源策略：题型参考').passed).toBe(true);
    expect(verifySourceCitation('- Source Strategy: AI Original').passed).toBe(true);
  });

  it('rejects missing layers and source markers', () => {
    const result = verifyPracticeContent('# Thin practice\n\nQ1. Do something.');

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('practice.missing_layer.apply');
    expect(result.issues.map((issue) => issue.code)).toContain('practice.missing_workbook_group.prototype');
    expect(result.issues.map((issue) => issue.code)).toContain('citation.missing_source_marker');
  });

  it('warns but does not block when workbook metadata is missing', () => {
    const content = [
      '## 第一层：记忆/理解',
      'Q1. 解释概念 A。 [AI原创]',
      '## 第二层：分析/评估',
      'Q2. 比较 A 和 B。 [AI原创]',
      '## 第三层：应用',
      'Q3. 在真实场景中应用 A。 [AI原创]',
      '## 第四层：创造',
      'Q4. 设计一个使用 A 的方案。 [AI原创]',
    ].join('\n\n');

    const result = verifyPracticeContent(content);

    expect(result.passed).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain('practice.missing_kc_metadata');
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('requires a saved answer for practice generation', () => {
    expect(verifyPracticeHasAnswer(false).passed).toBe(false);
    expect(verifyPracticeHasAnswer(true).passed).toBe(true);
  });

  it('checks KC coverage against KC-model outlines', () => {
    const outline = [
      '### KC1: Linear Regression',
      '### KC2: Gradient Descent',
    ].join('\n');

    expect(verifyKcCoverage(outline, 'Linear Regression and Gradient Descent are both covered.').passed).toBe(true);
    expect(verifyKcCoverage(outline, 'Only Linear Regression is covered.').passed).toBe(false);
  });
});
