import { localize, message, type LocalizedText } from '../agent-i18n/messages';

export type VerificationSeverity = 'error' | 'warning';

export interface VerificationIssue {
  code: string;
  message: string;
  severity: VerificationSeverity;
  details?: Record<string, unknown>;
}

export interface VerificationResult {
  verifier: string;
  passed: boolean;
  issues: VerificationIssue[];
}

export function pass(verifier: string, issues: VerificationIssue[] = []): VerificationResult {
  return { verifier, passed: !issues.some((issue) => issue.severity === 'error'), issues };
}

export function fail(verifier: string, issues: VerificationIssue[]): VerificationResult {
  return { verifier, passed: false, issues };
}

export function combineVerificationResults(verifier: string, results: VerificationResult[]): VerificationResult {
  const issues = results.flatMap((result) => result.issues);
  return {
    verifier,
    passed: results.every((result) => result.passed),
    issues,
  };
}

const PRACTICE_LAYER_LABELS: Record<string, LocalizedText> = {
  remember_understand: { zh: '记忆/理解层', en: 'remember/understand layer' },
  analyze_evaluate:    { zh: '分析/评估层', en: 'analysis/evaluation layer' },
  apply:               { zh: '应用层', en: 'application layer' },
  create:              { zh: '创造层', en: 'creation layer' },
};

const VERIFICATION_MESSAGES: Record<string, LocalizedText> = {
  'practice.empty_content': {
    zh: '实践资料内容为空。',
    en: 'Practice content is empty.',
  },
  'practice.no_question_markers': {
    zh: '实践资料必须包含题号标记，例如 Q1 或 1。',
    en: 'Practice content must include numbered questions such as Q1 or 1.',
  },
  'practice.answer_missing': {
    zh: '练习题文件必须配套保存参考答案文件。',
    en: 'A practice exercise file must be paired with a saved answer file.',
  },
  'practice.missing_workbook_group.prototype': {
    zh: '缺少 A组：核心原型题。',
    en: 'Missing Group A: Core Prototype Exercises.',
  },
  'practice.missing_workbook_group.variation': {
    zh: '缺少 B组：变式训练。',
    en: 'Missing Group B: Variations.',
  },
  'practice.missing_workbook_group.diagnosis': {
    zh: '缺少 C组：错误诊断。',
    en: 'Missing Group C: Error Diagnosis.',
  },
  'practice.missing_workbook_group.transfer': {
    zh: '缺少 D组：迁移/综合。',
    en: 'Missing Group D: Transfer/Synthesis.',
  },
  'practice.missing_kc_metadata': {
    zh: '实践资料必须标注题目对应的 KC。',
    en: 'Practice content must label question KC metadata.',
  },
  'practice.missing_cognitive_metadata': {
    zh: '实践资料应标注题目的认知动作。',
    en: 'Practice content should label cognitive-action metadata.',
  },
  'practice.missing_type_metadata': {
    zh: '实践资料必须标注题型。',
    en: 'Practice content must label exercise type metadata.',
  },
  'practice.missing_source_strategy': {
    zh: '实践资料必须标注来源策略。',
    en: 'Practice content must label source strategy metadata.',
  },
  'practice.missing_verifiable_criteria': {
    zh: '实践资料必须包含测试用例、验收条件、自检标准或评分维度。',
    en: 'Practice content must include test cases, acceptance criteria, self-check criteria, or rubrics.',
  },
  'citation.empty_content': {
    zh: '内容为空。',
    en: 'Content is empty.',
  },
  'citation.missing_source_marker': {
    zh: '实践资料必须包含来源标记，例如 来源、Source、[AI原创] 或 [AI Original]。',
    en: 'Practice content must include source markers such as 来源, Source, [AI原创], or [AI Original].',
  },
  'kc.no_kc_outline': {
    zh: '纲要中没有找到 KC 标记，已跳过 KC 覆盖校验。',
    en: 'No KC markers were found in the outline; KC coverage check skipped.',
  },
  'kc.coverage_low': {
    zh: 'KC 覆盖率过低：{covered}/{total}。',
    en: 'KC coverage is too low: {covered}/{total}.',
  },
  'dag.edge_unknown_node': {
    zh: '边引用了未知节点：{source} -> {target}',
    en: 'Edge references an unknown node: {source} -> {target}',
  },
  'dag.cycle_detected': {
    zh: '路线图中存在循环依赖。',
    en: 'DAG contains a cycle.',
  },
  'dag.goal_missing': {
    zh: '缺少明确目标文本，已跳过确定性覆盖校验。',
    en: 'No explicit goal text was available for deterministic coverage checking.',
  },
  'dag.goal_coverage_low': {
    zh: '路线节点与目标的匹配度偏低。',
    en: 'Route nodes appear weakly aligned with the stated goal.',
  },
  'dag.goal_coverage_partial': {
    zh: '路线目标覆盖不完整，请复查节点命名和描述。',
    en: 'Route goal coverage is partial; review node naming and descriptions.',
  },
};

function issueParams(issue: VerificationIssue): Record<string, string | number> {
  const details = issue.details ?? {};
  const ratioMatch = issue.message.match(/(\d+)\/(\d+)/);
  return {
    covered: typeof details.covered === 'number' ? details.covered : ratioMatch?.[1] ?? '',
    total: typeof details.total === 'number' ? details.total : ratioMatch?.[2] ?? '',
    source: typeof details.source === 'string' ? details.source : '',
    target: typeof details.target === 'string' ? details.target : '',
  };
}

export function formatVerificationIssueMessage(issue: VerificationIssue, language?: string): string {
  const layerPrefix = 'practice.missing_layer.';
  if (issue.code.startsWith(layerPrefix)) {
    const labelKey = issue.code.slice(layerPrefix.length);
    const label = PRACTICE_LAYER_LABELS[labelKey];
    return label
      ? localize({ zh: '缺少{label}。', en: 'Missing {label}.' }, language, { label: localize(label, language) })
      : issue.message;
  }

  const localized = VERIFICATION_MESSAGES[issue.code];
  return localized ? localize(localized, language, issueParams(issue)) : issue.message;
}

export function formatVerificationIssues(result: VerificationResult, language?: string): string {
  if (result.passed) {
    return message('verificationPassed', language);
  }
  const lines = result.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `- [${issue.code}] ${formatVerificationIssueMessage(issue, language)}`);
  return message('verificationFailedHeader', language) + '\n' + lines.join('\n');
}
