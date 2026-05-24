import * as fs from 'fs';
import * as path from 'path';
import { writeFileContent } from '../../fs/content.service';

export interface OutlineValidationIssue {
  code: string;
  message: string;
}

export interface OutlineValidationResult {
  passed: boolean;
  kcCount: number;
  issues: OutlineValidationIssue[];
  warnings: OutlineValidationIssue[];
  format: 'learning_blueprint' | 'practice_blueprint' | 'review_blueprint' | 'kc_outline';
}

interface KcBlock {
  id: string;
  name: string;
  body: string;
}

function parseKcBlocks(content: string): KcBlock[] {
  const matches = [...content.matchAll(/^###\s+(KC\d+)\s*[:：]\s*(.+)$/gmi)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
    return {
      id: match[1].toUpperCase(),
      name: match[2].trim(),
      body: content.slice(start, nextStart),
    };
  });
}

function hasField(body: string, zh: string, en: string): boolean {
  return hasAnyField(body, [zh, en]);
}

function extractField(body: string, zh: string, en: string): string {
  return extractAnyField(body, [zh, en]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FIELD_MARKER = String.raw`(?:\*\*|__|` + '`' + String.raw`)?`;

function fieldNamePattern(names: string[]): string {
  return names.map(escapeRegExp).join('|');
}

function fieldLineRegex(names: string[]): RegExp {
  const fieldNames = fieldNamePattern(names);
  return new RegExp(
    String.raw`(?:^|\n)\s*(?:[-*+]\s*)?` +
      FIELD_MARKER +
      String.raw`(?:` + fieldNames + String.raw`)` +
      FIELD_MARKER +
      String.raw`\s*(?:[:：]|[-–—])\s*` +
      FIELD_MARKER +
      String.raw`(.+)$`,
    'im',
  );
}

function tableFieldRegex(names: string[]): RegExp {
  const fieldNames = fieldNamePattern(names);
  return new RegExp(
    String.raw`(?:^|\n)\s*\|\s*` +
      FIELD_MARKER +
      String.raw`(?:` + fieldNames + String.raw`)` +
      FIELD_MARKER +
      String.raw`\s*\|\s*(.+?)\s*\|`,
    'im',
  );
}

function hasAnyField(body: string, names: string[]): boolean {
  return fieldLineRegex(names).test(body) || tableFieldRegex(names).test(body);
}

function extractAnyField(body: string, names: string[]): string {
  const lineMatch = body.match(fieldLineRegex(names));
  if (lineMatch?.[1]) return cleanFieldValue(lineMatch[1]);
  const tableMatch = body.match(tableFieldRegex(names));
  if (tableMatch?.[1]) return cleanFieldValue(tableMatch[1]);
  return '';
}

function cleanFieldValue(value: string): string {
  return value
    .replace(/\s*\|.*$/, '')
    .replace(/^(?:\*\*|__|`)+/, '')
    .replace(/(?:\*\*|__|`)+$/, '')
    .trim();
}

function countMisconceptions(content: string): number {
  const section = content.split(/##\s+(?:边界条件|Edge Conditions)/i)[0] ?? content;
  return [...section.matchAll(/^\s*\d+[.)、]\s*(?:误解|Misconception)\s*[:：]/gmi)].length;
}

function countEdgeConditions(content: string): number {
  const m = content.match(/##\s+(?:边界条件|Edge Conditions)\s*\n([\s\S]*)$/i);
  if (!m) return 0;
  return m[1].split('\n').filter((line) => /^\s*[-*]\s+\S+/.test(line)).length;
}

function prerequisiteRefs(body: string): string[] {
  const value = extractAnyField(body, ['前置KC', '前置依赖', '前置知识', 'Prerequisite KC', 'Prerequisite KCs', 'Prerequisite', 'Prerequisites']);
  if (!value || /^(无|none)$/i.test(value)) return [];
  return [...value.matchAll(/\bKC\d+\b/gi)].map((m) => m[0].toUpperCase());
}

function isLikelyIncompleteMastery(value: string): boolean {
  const normalized = value.replace(/[，。,.;；.!！\])）]+$/g, '').trim();
  if (!normalized) return true;
  if (normalized.length < 10) return true;
  return normalized.length < 24 && /(一个|一种|某个|某类|是否|能否|能够?|可以|会|将|the|a|an|of|to)$/i.test(normalized);
}

function isPlaceholderCell(value: string): boolean {
  const normalized = value
    .replace(/\*\*|__|`/g, '')
    .trim()
    .replace(/[。.;；,，]+$/g, '')
    .trim();
  return /^(?:\.{3}|…)$/.test(normalized)
    || /^(?:TODO|待补|待完善)$/i.test(normalized)
    || /^\[(?:名称|Name|具体|specific|observable|错误认知|incorrect|correct|边界|edge|待补)\]$/i.test(normalized);
}

function lineHasUnfilledPlaceholder(line: string): boolean {
  const stripped = line.replace(/\*\*|__|`/g, '').trim();
  if (!stripped) return false;

  if (stripped.includes('|')) {
    const cells = stripped
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length === 0 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return false;
    return cells.some(isPlaceholderCell);
  }

  const fieldMatch = stripped.match(/^(?:[-*+]\s*)?[^:：|]+[:：]\s*(.+)$/);
  if (fieldMatch?.[1]) return isPlaceholderCell(fieldMatch[1]);
  return isPlaceholderCell(stripped);
}

function hasUnfilledPlaceholder(text: string): boolean {
  if (/(?:TODO|待补|待完善)/i.test(text)) return true;
  if (/\[(?:名称|Name|具体|specific|observable|错误认知|incorrect|correct|边界|edge|待补)\]/i.test(text)) return true;
  return text.split('\n').some(lineHasUnfilledPlaceholder);
}

function hasSection(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

function isLearningBlueprint(content: string): boolean {
  return /学习蓝图|Learning Blueprint/i.test(content)
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:学习目标|Learning Goals|Performance Goals)/i])
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:学习推进|Learning Flow|Learning Sequence)/i]);
}

export function isPracticeBlueprint(content: string): boolean {
  return /实践与出题蓝图|Practice\s*(?:&|and)?\s*Exercise\s*Blueprint/i.test(content)
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:KC\s*[×xX]\s*题型|题型矩阵|Exercise Matrix|KC.*Exercise)/i])
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:持续出题|下一轮练习|Practice Generation|Next-Round)/i]);
}

export function isReviewBlueprint(content: string): boolean {
  return /复盘与深化蓝图|Review\s*(?:&|and)?\s*Deepening\s*Blueprint/i.test(content)
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:费曼|Feynman)/i])
    || hasSection(content, [/##\s+\d*[.、]?\s*(?:错题复盘|Review Template|Mistake Review)/i]);
}

function countBlueprintMisconceptions(content: string): number {
  const normalized = content.replace(/\*\*|__|`/g, '');
  return [...normalized.matchAll(/(?:常见误解|常见误区|常见错误|误解|误区|Misconception|Common Error|Common Mistake)\s*[:：]/gi)].length;
}

function countLearningFlowItems(content: string): number {
  const m = content.match(/##\s+\d*[.、]?\s*(?:学习推进|学习流程|Learning Flow|Learning Sequence)[^\n]*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!m) return 0;
  const lines = m[1].split('\n').map((line) => line.trim()).filter(Boolean);
  const bulletOrNumbered = lines.filter((line) => /^(?:[-*+]|\d+[.)、])\s+\S+/.test(line)).length;
  const tableRows = lines.filter((line) =>
    /^\|.+\|$/.test(line) &&
    !/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line) &&
    !/^\|\s*(?:阶段|步骤|Stage|Step)\s*\|/i.test(line)
  ).length;
  const subheadings = lines.filter((line) => /^#{3,6}\s+\S+/.test(line)).length;
  const stageKeywords = [
    '激活旧知',
    '建立核心概念',
    '例子/反例',
    'Worked Example',
    '引导练习',
    '迁移',
    '自检',
    '纠错',
    'Activate',
    'Build',
    'Counterexample',
    'Guided Practice',
    'Transfer',
    'Self-check',
  ];
  const keywordHits = stageKeywords.filter((keyword) => m[1].includes(keyword)).length;
  return Math.max(bulletOrNumbered, tableRows, subheadings, keywordHits);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s:：，。,.;；（）()[\]【】"'“”‘’_-]+/g, '');
}

function isVagueEvidence(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  return /^(能)?(理解|掌握|了解|熟悉|知道)(相关|基本|核心)?(知识|概念|内容|原理)?$/.test(normalized)
    || /^(understand|master|know|learn)(the)?(basic|core)?(concept|knowledge|content)?$/i.test(normalized);
}

export function validateOutlineStructure(
  content: string,
  _kcTargetRange: string,
  targetVersion: number,
): OutlineValidationResult {
  const issues: OutlineValidationIssue[] = [];
  const warnings: OutlineValidationIssue[] = [];
  const trimmed = content.trim();
  const kcs = parseKcBlocks(trimmed);
  const practiceBlueprint = isPracticeBlueprint(trimmed);
  const reviewBlueprint = isReviewBlueprint(trimmed);
  const blueprint = isLearningBlueprint(trimmed);
  const requiredMisconceptions = targetVersion >= 2 ? 3 : 2;
  const requiredEdges = targetVersion >= 2 ? 2 : 1;

  if (!trimmed) issues.push({ code: 'empty', message: '纲要内容为空' });
  if (!/^#\s+/.test(trimmed)) issues.push({ code: 'missing-title', message: '缺少一级标题' });
  if (practiceBlueprint) {
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:实践目标|Practice Goals|Practice Objective)/i])) {
      issues.push({ code: 'missing-practice-goals', message: '缺少实践目标与出题边界章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:KC\s*[×xX]\s*题型|题型矩阵|Exercise Matrix|KC.*Exercise)/i])) {
      issues.push({ code: 'missing-exercise-matrix', message: '缺少 KC × 题型矩阵' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:题型模板|Exercise Template|Template Library)/i])) {
      issues.push({ code: 'missing-template-library', message: '缺少题型模板库' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:错误触发|补练|Error.*Remediation|Remediation)/i])) {
      issues.push({ code: 'missing-remediation-rules', message: '缺少错误触发与补练规则' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:持续出题|下一轮练习|Practice Generation|Next-Round)/i])) {
      issues.push({ code: 'missing-generation-rules', message: '缺少持续出题/下一轮练习规则' });
    }
  } else if (reviewBlueprint) {
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:复盘目标|Review Goals|Review Objective)/i])) {
      issues.push({ code: 'missing-review-goals', message: '缺少复盘目标章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:费曼|Feynman)/i])) {
      issues.push({ code: 'missing-feynman-questions', message: '缺少费曼复述问题章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:自检|Self[- ]?Check|Checklist)/i])) {
      issues.push({ code: 'missing-self-check', message: '缺少自检清单' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:错题复盘|Mistake Review|Review Template)/i])) {
      issues.push({ code: 'missing-mistake-review', message: '缺少错题复盘模板' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:迁移|深化|Transfer|Deepening)/i])) {
      issues.push({ code: 'missing-transfer-deepening', message: '缺少迁移/深化问题' });
    }
  } else if (blueprint) {
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:学习目标|Learning Goals|Performance Goals)/i])) {
      issues.push({ code: 'missing-learning-goals', message: '缺少学习目标与表现目标章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:前置准备|Prerequisites|Prerequisite Preparation)/i])) {
      issues.push({ code: 'missing-prerequisites', message: '缺少前置准备章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:核心知识结构|Knowledge Structure|Core Knowledge Structure|知识单元|Knowledge Units)/i])) {
      issues.push({ code: 'missing-kc-section', message: '缺少核心知识结构章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:学习推进|学习流程|Learning Flow|Learning Sequence)/i])) {
      issues.push({ code: 'missing-learning-flow', message: '缺少学习推进顺序章节' });
    }
    if (!hasSection(trimmed, [/##\s+\d*[.、]?\s*(?:掌握证据|测评证据|Evidence|Diagnosis)/i])) {
      issues.push({ code: 'missing-evidence-model', message: '缺少掌握证据与诊断章节' });
    }
  } else {
    if (!/##\s+(?:知识单元|Knowledge Units)/i.test(trimmed)) issues.push({ code: 'missing-kc-section', message: '缺少知识单元章节' });
    if (!/##\s+(?:常见误解|Common Misconceptions)/i.test(trimmed)) issues.push({ code: 'missing-misconceptions', message: '缺少常见误解章节' });
    if (!/##\s+(?:边界条件|Edge Conditions)/i.test(trimmed)) issues.push({ code: 'missing-edge-conditions', message: '缺少边界条件章节' });
  }

  if (!practiceBlueprint && !reviewBlueprint && kcs.length === 0) {
    issues.push({ code: 'kc-count-empty', message: '未解析到任何 KC 标记' });
  }

  const ids = new Set(kcs.map((kc) => kc.id));
  const seenNames = new Set<string>();
  kcs.forEach((kc, index) => {
    const expected = `KC${index + 1}`;
    if (kc.id !== expected) issues.push({ code: 'kc-order', message: `${kc.id} 编号不连续，应为 ${expected}` });
    if (!kc.name || hasUnfilledPlaceholder(kc.name)) issues.push({ code: 'kc-placeholder', message: `${kc.id} 名称仍含占位符` });
    const normalizedName = normalizeName(kc.name);
    if (normalizedName && seenNames.has(normalizedName)) {
      warnings.push({ code: 'kc-duplicate-name', message: `${kc.id} 名称与前文 KC 疑似重复` });
    }
    seenNames.add(normalizedName);

    if (blueprint || practiceBlueprint || reviewBlueprint) {
      if (!hasAnyField(kc.body, ['前置依赖', '前置KC', '前置知识', 'Prerequisite KC', 'Prerequisite KCs', 'Prerequisite', 'Prerequisites'])) {
        if (blueprint) issues.push({ code: 'kc-missing-prereq', message: `${kc.id} 缺少前置依赖字段` });
      }
      if (!hasAnyField(kc.body, ['掌握证据', '可观察证据', '掌握表现', '达成证据', 'Mastery Evidence', 'Observable Evidence', 'Mastery Indicator', 'Success Evidence'])) {
        if (blueprint) issues.push({ code: 'kc-missing-mastery', message: `${kc.id} 缺少掌握证据字段` });
      }
      if (!hasAnyField(kc.body, ['认知动作', 'Cognitive Action', 'Cognitive Process', '布鲁姆层级', 'Bloom Level'])) {
        warnings.push({ code: 'kc-missing-cognitive-action', message: `${kc.id} 缺少认知动作提示` });
      }
      if (!hasAnyField(kc.body, ['推荐表征', '表征方式', '表征与例反例', 'Representation', 'Representations', 'Representation + minimal example / key counterexample'])) {
        warnings.push({ code: 'kc-missing-representation', message: `${kc.id} 缺少推荐表征提示` });
      }
    } else {
      if (!hasField(kc.body, '类型', 'Type')) issues.push({ code: 'kc-missing-type', message: `${kc.id} 缺少类型字段` });
      if (!hasField(kc.body, '布鲁姆层级', 'Bloom Level')) issues.push({ code: 'kc-missing-bloom', message: `${kc.id} 缺少布鲁姆层级字段` });
      if (!hasField(kc.body, '前置KC', 'Prerequisite KCs')) issues.push({ code: 'kc-missing-prereq', message: `${kc.id} 缺少前置 KC 字段` });
      if (!hasField(kc.body, '掌握指标', 'Mastery Indicator')) issues.push({ code: 'kc-missing-mastery', message: `${kc.id} 缺少掌握指标字段` });
    }

    const mastery = (blueprint || practiceBlueprint || reviewBlueprint)
      ? extractAnyField(kc.body, ['掌握证据', '可观察证据', '掌握表现', '达成证据', 'Mastery Evidence', 'Observable Evidence', 'Mastery Indicator', 'Success Evidence'])
      : extractField(kc.body, '掌握指标', 'Mastery Indicator');
    if (!practiceBlueprint && !reviewBlueprint && (isLikelyIncompleteMastery(mastery) || isVagueEvidence(mastery) || hasUnfilledPlaceholder(mastery))) {
      issues.push({ code: 'kc-incomplete-mastery', message: `${kc.id} 掌握证据/指标疑似未写完整或过于空泛` });
    }
    for (const ref of prerequisiteRefs(kc.body)) {
      if (!ids.has(ref)) issues.push({ code: 'kc-bad-prereq', message: `${kc.id} 引用了不存在的前置 ${ref}` });
    }
  });

  if (practiceBlueprint || reviewBlueprint) {
    if (hasUnfilledPlaceholder(trimmed)) {
      issues.push({ code: 'placeholder', message: '纲要仍包含占位符或待补内容' });
    }
  } else if (blueprint) {
    const misconceptionCount = countBlueprintMisconceptions(trimmed);
    if (misconceptionCount < 1) {
      warnings.push({ code: 'misconception-count-soft', message: '蓝图中缺少常见误解/常见错误信息，建议补充但不阻断生成' });
    } else if (misconceptionCount < requiredMisconceptions) {
      warnings.push({ code: 'misconception-count-soft', message: `误解/错误提示 ${misconceptionCount} 条，建议至少 ${requiredMisconceptions} 条` });
    }
    const flowItems = countLearningFlowItems(trimmed);
    if (flowItems < 4) {
      warnings.push({ code: 'learning-flow-thin', message: '学习推进顺序偏少，建议补充但不阻断生成' });
    }
  } else {
    const misconceptionCount = countMisconceptions(trimmed);
    if (misconceptionCount < requiredMisconceptions) {
      issues.push({ code: 'misconception-count', message: `常见误解 ${misconceptionCount} 条，少于 ${requiredMisconceptions} 条` });
    }
    const edgeCount = countEdgeConditions(trimmed);
    if (edgeCount < requiredEdges) {
      issues.push({ code: 'edge-count', message: `边界条件 ${edgeCount} 条，少于 ${requiredEdges} 条` });
    }
  }
  if (!practiceBlueprint && !reviewBlueprint && hasUnfilledPlaceholder(trimmed)) {
    issues.push({ code: 'placeholder', message: '纲要仍包含占位符或待补内容' });
  }

  return {
    passed: issues.length === 0,
    kcCount: kcs.length,
    issues,
    warnings,
    format: practiceBlueprint ? 'practice_blueprint' : reviewBlueprint ? 'review_blueprint' : blueprint ? 'learning_blueprint' : 'kc_outline',
  };
}

export function formatOutlineValidationIssues(result: OutlineValidationResult): string {
  return result.issues.map((issue, index) => `${index + 1}. [${issue.code}] ${issue.message}`).join('\n');
}

export function formatOutlineValidationWarnings(result: OutlineValidationResult): string {
  return result.warnings.map((issue, index) => `${index + 1}. [${issue.code}] ${issue.message}`).join('\n');
}

export function writeOutlineAtomically(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileContent(tmpPath, content);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.renameSync(tmpPath, filePath);
}
