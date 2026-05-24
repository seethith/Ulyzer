import { verifySourceCitation } from './citation.verifier';
import { combineVerificationResults, fail, pass, type VerificationIssue, type VerificationResult } from './types';

const QUESTION_RE = /(^|\n)\s*(?:#{1,4}\s*)?(?:Q\d+|问题\s*\d+|题目\s*\d+|\d+[.、])/i;

const LAYER_PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  { code: 'remember_understand', label: 'remember/understand layer', re: /第一层|Tier\s*1|Remember\s*\/\s*Understand|记忆\s*\/\s*理解/i },
  { code: 'analyze_evaluate', label: 'analysis/evaluation layer', re: /第二层|Tier\s*2|Analy[sz]e\s*\/\s*Evaluate|分析\s*\/\s*评估|分析|评估|Analyze|Evaluate/i },
  { code: 'apply', label: 'application layer', re: /第三层|Tier\s*3|Apply|Application|应用/i },
  { code: 'create', label: 'creation layer', re: /第四层|Tier\s*4|Create|Creation|创造/i },
];

const WORKBOOK_GROUP_PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  { code: 'prototype', label: 'prototype exercise group', re: /A\s*组|Group\s*A|核心原型|Prototype/i },
  { code: 'variation', label: 'variation exercise group', re: /B\s*组|Group\s*B|变式|Variation/i },
  { code: 'diagnosis', label: 'error diagnosis group', re: /C\s*组|Group\s*C|错误诊断|Error\s*Diagnosis/i },
  { code: 'transfer', label: 'transfer/synthesis group', re: /D\s*组|Group\s*D|迁移|综合|Transfer|Synthesis/i },
];

const KC_METADATA_RE = /(^|\n)\s*[-*]?\s*(?:KC|知识点|Knowledge\s*Component)[:：]/i;
const COGNITIVE_METADATA_RE = /(^|\n)\s*[-*]?\s*(?:布鲁姆|Bloom|认知动作|Cognitive\s*(?:Action|Process))[:：]/i;
const TYPE_METADATA_RE = /(^|\n)\s*[-*]?\s*(?:题型|Type)[:：]/i;
const SOURCE_STRATEGY_RE = /(^|\n)\s*[-*]?\s*(?:来源策略|Source\s*Strategy)[:：]/i;
const TEST_OR_RUBRIC_RE = /测试用例|输入|输出|预期|验收|自检|评分维度|rubric|test\s*case|input|output|expected|acceptance|self-check/i;

export function verifyPracticeStructure(content: string): VerificationResult {
  if (!content.trim()) {
    return fail('practiceStructure', [{
      code: 'practice.empty_content',
      severity: 'error',
      message: 'Practice content is empty.',
    }]);
  }

  const missingLayers = LAYER_PATTERNS.filter((layer) => !layer.re.test(content));
  const issues: VerificationIssue[] = missingLayers.map((layer) => ({
    code: `practice.missing_layer.${layer.code}`,
    severity: 'warning' as const,
    message: `Missing ${layer.label}.`,
  }));

  if (!QUESTION_RE.test(content)) {
    issues.push({
      code: 'practice.no_question_markers',
      severity: 'error',
      message: 'Practice content must include numbered questions such as Q1 or 1.',
    });
  }

  const missingGroups = WORKBOOK_GROUP_PATTERNS.filter((group) => !group.re.test(content));
  for (const group of missingGroups) {
    issues.push({
      code: `practice.missing_workbook_group.${group.code}`,
      severity: 'warning',
      message: `Missing ${group.label}.`,
    });
  }

  if (!KC_METADATA_RE.test(content)) {
    issues.push({
      code: 'practice.missing_kc_metadata',
      severity: 'warning',
      message: 'Each practice set must label question KC metadata.',
    });
  }
  if (!COGNITIVE_METADATA_RE.test(content)) {
    issues.push({
      code: 'practice.missing_cognitive_metadata',
      severity: 'warning',
      message: 'Each practice set should label cognitive-action metadata.',
    });
  }
  if (!TYPE_METADATA_RE.test(content)) {
    issues.push({
      code: 'practice.missing_type_metadata',
      severity: 'warning',
      message: 'Each practice set must label exercise type metadata.',
    });
  }
  if (!SOURCE_STRATEGY_RE.test(content)) {
    issues.push({
      code: 'practice.missing_source_strategy',
      severity: 'warning',
      message: 'Each practice set must label source strategy metadata.',
    });
  }
  if (!TEST_OR_RUBRIC_RE.test(content)) {
    issues.push({
      code: 'practice.missing_verifiable_criteria',
      severity: 'warning',
      message: 'Practice content must include test cases, acceptance criteria, self-check criteria, or rubrics.',
    });
  }

  return issues.some((issue) => issue.severity === 'error')
    ? fail('practiceStructure', issues)
    : pass('practiceStructure', issues);
}

export function verifyPracticeContent(content: string): VerificationResult {
  return combineVerificationResults('practiceMaterial', [
    verifyPracticeStructure(content),
    verifySourceCitation(content),
  ]);
}

export function verifyPracticeHasAnswer(answerSaved: boolean): VerificationResult {
  if (!answerSaved) {
    return fail('practiceHasAnswer', [{
      code: 'practice.answer_missing',
      severity: 'error',
      message: 'A practice exercise file must be paired with a saved answer file.',
    }]);
  }
  return pass('practiceHasAnswer');
}
