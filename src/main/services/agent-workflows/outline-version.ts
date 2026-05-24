/**
 * Outline version management.
 *
 * Responsibilities:
 *   - Detect current foundation-blueprint versions for a node (0 = none, 1-3 = v1-v3)
 *   - Read KC coverage status by parsing _index.md files from theory + practice folders
 *   - Generate v2/v3 foundation blueprints using the previous blueprint as context
 *
 * Foundation blueprints stop at v3. The Topic (专题) feature is the manual,
 * open-ended extension branch for individual KCs, scenarios, and exercise types.
 */
import * as fs from 'fs';
import * as path from 'path';
import { streamStructuredCompletion } from '../llm/structured-stream';
import { resolveOutputTokenBudget } from '../agent-context/output-token-budget';
import type { LLMProvider, KcCoverageStatus, SearchMode, TokenUsage } from '@shared/types';
import { computeKcRange, formatKcCountGuidance } from './node-sizing';
import {
  getOutlineDirPath,
  getLatestOutlinePath,
  getFolderPath,
} from '../fs/content.service';
import { localMsg, message } from '../agent-i18n/messages';
import {
  formatOutlineContextTrace,
  formatOutlineStepTrace,
  formatOutlineVerificationTrace,
} from './material/material-progress-trace';
import {
  formatOutlineValidationIssues,
  formatOutlineValidationWarnings,
  isPracticeBlueprint,
  isReviewBlueprint,
  validateOutlineStructure,
  writeOutlineAtomically,
} from './outline/outline-validation';

export const MAX_OUTLINE_VERSION = 3;

// ── Version detection ─────────────────────────────────────────────────────────

/** Returns the highest outline version number that exists (0 if none). */
export function getOutlineVersionNumber(courseId: string, nodeId: string): number {
  const dir = getOutlineDirPath(courseId, nodeId);
  for (const v of [3, 2, 1]) {
    if (fs.existsSync(path.join(dir, `_outline_v${v}.md`))) return v;
  }
  return 0;
}

export function getOutlineVersionPath(courseId: string, nodeId: string, version: 1 | 2 | 3): string {
  return path.join(getOutlineDirPath(courseId, nodeId), `_outline_v${version}.md`);
}

export function readOutlineVersionText(courseId: string, nodeId: string, version: 1 | 2 | 3): string {
  const outlinePath = getOutlineVersionPath(courseId, nodeId, version);
  try {
    return fs.existsSync(outlinePath) ? fs.readFileSync(outlinePath, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function isLearningBlueprintFile(text: string): boolean {
  return /学习蓝图|Learning Blueprint/i.test(text)
    && /##\s+\d*[.、]?\s*(?:学习目标|Learning Goals|Performance Goals)/i.test(text)
    && /##\s+\d*[.、]?\s*(?:核心知识结构|Knowledge Structure|Core Knowledge Structure)/i.test(text)
    && /##\s+\d*[.、]?\s*(?:掌握证据|Evidence|Diagnosis)/i.test(text);
}

export interface OutlineBundleStatus {
  complete: boolean;
  latestVersion: number;
  missingVersions: number[];
  staleVersions: number[];
}

export function getOutlineBundleStatus(courseId: string, nodeId: string): OutlineBundleStatus {
  const checks: Array<[1 | 2 | 3, (text: string) => boolean]> = [
    [1, isLearningBlueprintFile],
    [2, isPracticeBlueprint],
    [3, isReviewBlueprint],
  ];
  const missingVersions: number[] = [];
  const staleVersions: number[] = [];
  for (const [version, isValid] of checks) {
    const text = readOutlineVersionText(courseId, nodeId, version);
    if (!text) {
      missingVersions.push(version);
    } else if (!isValid(text)) {
      staleVersions.push(version);
    }
  }
  const latestVersion = getOutlineVersionNumber(courseId, nodeId);
  return {
    complete: missingVersions.length === 0 && staleVersions.length === 0,
    latestVersion,
    missingVersions,
    staleVersions,
  };
}

export function removeOutlineVersionsFrom(courseId: string, nodeId: string, fromVersion: 1 | 2 | 3): void {
  for (let version = fromVersion; version <= 3; version += 1) {
    try { fs.rmSync(getOutlineVersionPath(courseId, nodeId, version as 1 | 2 | 3), { force: true }); } catch { /* ignore */ }
  }
}

// ── KC parsing helpers ────────────────────────────────────────────────────────

function parseKcIds(text: string): string[] {
  const ids: string[] = [];
  const re = /^###\s+(KC\d+)\s*[:：]/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

function outlineVersionNumberFromPath(outlinePath: string | null): number {
  const versionMatch = outlinePath?.match(/_outline_v([1-3])\.md$/);
  if (versionMatch) return Number(versionMatch[1]);
  if (outlinePath?.endsWith('_outline.md')) return 1;
  return 0;
}

export interface KcCoverageCheckOptions {
  outlineText?: string;
  outlinePath?: string | null;
  version?: number;
}

/**
 * Read all KC IDs that appear in "覆盖KC：..." lines across both theory/ and
 * practice/ _index.md files for the node.
 */
function readAllCoveredKcIds(courseId: string, nodeId: string): Set<string> {
  const covered = new Set<string>();
  for (const folder of ['theory', 'practice'] as const) {
    try {
      const indexPath = path.join(getFolderPath(courseId, nodeId, folder), '_index.md');
      if (!fs.existsSync(indexPath)) continue;
      const text = fs.readFileSync(indexPath, 'utf-8');
      for (const m of text.matchAll(/^(?:覆盖KC|KCs covered)：?:?\s*(.+)$/mg)) {
        for (const part of m[1].split(',')) {
          const idMatch = part.trim().match(/^(KC\d+)/);
          if (idMatch) covered.add(idMatch[1]);
        }
      }
    } catch { /* non-fatal */ }
  }
  return covered;
}

// ── Coverage check ────────────────────────────────────────────────────────────

/**
 * Check KC coverage for a node against its latest outline.
 * Returns `isFullyCovered: false` for legacy outlines (no KC markers) since
 * KC-level coverage tracking is not available for them.
 */
export function checkKcCoverage(courseId: string, nodeId: string, options: KcCoverageCheckOptions = {}): KcCoverageStatus {
  const requestedVersion = options.version ?? outlineVersionNumberFromPath(options.outlinePath ?? null);
  const version = requestedVersion || getOutlineVersionNumber(courseId, nodeId);
  if (version === 0) {
    return { version: 0, allKcIds: [], coveredKcIds: [], uncoveredKcIds: [], isFullyCovered: false };
  }

  const outlinePath = options.outlinePath ?? getLatestOutlinePath(courseId, nodeId);
  const outlineText = options.outlineText
    ?? (outlinePath
      ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8'); } catch { return ''; } })()
      : '');

  const allKcIds = parseKcIds(outlineText);
  if (allKcIds.length === 0) {
    // Legacy outline format — KC coverage tracking not available
    return { version, allKcIds: [], coveredKcIds: [], uncoveredKcIds: [], isFullyCovered: false };
  }

  const coveredSet = readAllCoveredKcIds(courseId, nodeId);
  const coveredKcIds   = allKcIds.filter((id) => coveredSet.has(id));
  const uncoveredKcIds = allKcIds.filter((id) => !coveredSet.has(id));

  return {
    version,
    allKcIds,
    coveredKcIds,
    uncoveredKcIds,
    isFullyCovered: uncoveredKcIds.length === 0 && allKcIds.length > 0,
  };
}

// ── Next-version generation ───────────────────────────────────────────────────

export interface OutlineGenerateNextOptions {
  courseId: string;
  nodeId: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  language?: string;
  searchMode?: SearchMode;
  onProgressChunk: (msg: string) => void;
  onComplete?: (usage: TokenUsage) => void;
}

/** Compute advisory KC granularity text for v2/v3 prompts based on node metadata. */
function getKcCountRangeStr(node: import('@shared/types').DagNode): string {
  const v1Range = computeKcRange(node);
  return `${v1Range.min}-${v1Range.max}`;
}

function parseKcGuidance(range: string): { min: number; max: number } {
  const match = range.match(/(\d+)\D+(\d+)/);
  if (!match) return { min: 3, max: 12 };
  return { min: Number(match[1]), max: Number(match[2]) };
}

function buildPracticeBlueprintPrompt(input: {
  node: import('@shared/types').DagNode;
  baseText: string;
  currentVersion: number;
  kcTargetRange: string;
  language?: string;
}): string {
  const isEn = input.language === 'en';
  const granularity = formatKcCountGuidance(parseKcGuidance(input.kcTargetRange), input.language);
  if (isEn) {
    return `You are designing the Practice & Exercise Blueprint v2 for the learning node "${input.node.name}".\n\n` +
      `**Role of v2:** This is the most important practice engine blueprint. It is not a more detailed v1 and it is not a worksheet. It tells the system how to generate accurate, varied, repeatable practice for this node under learner self-direction.\n\n` +
      `**Base v${input.currentVersion} learning blueprint:**\n${input.baseText}\n\n` +
      `**Design principles:**\n` +
      `- Use the v1 KC boundaries; do not invent a new curriculum.\n` +
      `- ${granularity}\n` +
      `- Focus on generating good exercises repeatedly: prototype, variation, counterexample, error diagnosis, and transfer tasks.\n` +
      `- Include next-round generation rules for continued practice, but phrase mastery thresholds as learner self-check references, not automatic grading.\n` +
      `- Keep everything compact and reusable; write generation hints, not full exercises.\n\n` +
      `**Strict output format (no explanations):**\n\n` +
      `# Practice & Exercise Blueprint — ${input.node.name} (v2)\n\n` +
      `## 1. Practice Goals & Exercise Boundary\n- Practice goal: ...\n- Exercise boundary: ...\n- Priority: ...\n\n` +
      `## 2. KC × Exercise Matrix\n| KC | Prototype | Variation | Counterexample / Discrimination | Error Diagnosis | Transfer / Synthesis |\n| --- | --- | --- | --- | --- | --- |\n| KC1 | ... | ... | ... | ... | ... |\n\n` +
      `## 3. Exercise Template Library\n### KC1: [KC name]\n- Prototype template: ...\n- Variation dimensions: ...\n- Error diagnosis template: ...\n- Transfer template: ...\n- Checkable outcome / rubric: ...\n\n` +
      `## 4. Error Triggers & Remediation Rules\n| Error signal | Related KC | Follow-up practice direction | Review prompt |\n| --- | --- | --- | --- |\n| ... | KC1 | ... | ... |\n\n` +
      `## 5. Continuous Practice Generation Rules\n- Interleaving strategy: ...\n- New / review / transfer ratio: ...\n- Learner self-check mastery threshold: ...\n- Next-round generation rule: ...\n- Mistake-review question interface: ...\n`;
  }

  return `你是学习节点「${input.node.name}」的实践与出题蓝图设计师。\n\n` +
    `**v2 定位：** v2 是最重要的实践发动机蓝图。它不是更详细的 v1，也不是直接出的练习册；它要告诉系统如何围绕本节点持续生成准确、多样、可复用的练习，并服务用户主导的自评学习。\n\n` +
    `**基础 v${input.currentVersion} 学习蓝图：**\n${input.baseText}\n\n` +
    `**设计原则：**\n` +
    `- 沿用 v1 的 KC 和边界，不重新发明课程。\n` +
    `- ${granularity}\n` +
    `- 重点服务持续出好题：原型题、变式题、反例/辨析题、错误诊断题、迁移/综合题。\n` +
    `- 包含下一轮练习生成规则；掌握阈值只作为用户自评参考，不假装系统能自动判定学生真实水平。\n` +
    `- 保持精炼可复用：写“出题提示/生成规则”，不要直接写完整题目。\n\n` +
    `**严格输出格式（不输出解释）：**\n\n` +
    `# 实践与出题蓝图 — ${input.node.name}（v2）\n\n` +
    `## 1. 实践目标与出题边界\n- 实践目标：...\n- 出题边界：...\n- 出题优先级：...\n\n` +
    `## 2. KC × 题型矩阵\n| KC | 原型题 | 变式题 | 反例/辨析题 | 错误诊断题 | 迁移/综合题 |\n| --- | --- | --- | --- | --- | --- |\n| KC1 | ... | ... | ... | ... | ... |\n\n` +
    `## 3. 题型模板库\n### KC1: [KC 名称]\n- 原型题模板：...\n- 变量变化维度：...\n- 错误诊断模板：...\n- 迁移题模板：...\n- 可验证结果 / 评分维度：...\n\n` +
    `## 4. 错误触发与补练规则\n| 错误信号 | 关联 KC | 补练方向 | 复盘追问 |\n| --- | --- | --- | --- |\n| ... | KC1 | ... | ... |\n\n` +
    `## 5. 持续出题与下一轮练习规则\n- 交错练习策略：...\n- 新题 / 复习题 / 迁移题比例：...\n- 用户自评掌握阈值：...\n- 下一轮练习生成规则：...\n- 错题复盘问题接口：...\n`;
}

function buildReviewBlueprintPrompt(input: {
  node: import('@shared/types').DagNode;
  baseText: string;
  currentVersion: number;
  language?: string;
}): string {
  const isEn = input.language === 'en';
  if (isEn) {
    return `You are designing the Review & Deepening Blueprint v3 for the learning node "${input.node.name}".\n\n` +
      `**Role of v3:** This blueprint supports learner self-check, Feynman review, misconception repair, and deeper transfer. It is not the main exercise engine; v2 handles practice generation.\n\n` +
      `**Base v${input.currentVersion} blueprint:**\n${input.baseText}\n\n` +
      `**Rules:**\n` +
      `- Build from v1/v2 KCs, practice errors, and mastery evidence.\n` +
      `- Write reflection prompts and review templates, not a test paper.\n` +
      `- Do not require the system to observe real learner performance; phrase checks as learner self-assessment.\n` +
      `- Keep it compact and reusable for Feynman checklist generation.\n\n` +
      `**Strict output format (no explanations):**\n\n` +
      `# Review & Deepening Blueprint — ${input.node.name} (v3)\n\n` +
      `## 1. Review Goals\n- Review goal: ...\n- Self-assessment boundary: ...\n\n` +
      `## 2. Feynman Retelling Questions\n### KC1: [KC name]\n- Retell in plain language: ...\n- Explain why / when it works: ...\n- Explain a boundary or counterexample: ...\n\n` +
      `## 3. Self-Check Checklist\n- [ ] ...\n- [ ] ...\n\n` +
      `## 4. Misconception Explanation Paths\n| Misconception | Explanation path | Analogy / representation | Follow-up reflection |\n| --- | --- | --- | --- |\n| ... | ... | ... | ... |\n\n` +
      `## 5. Mistake Review Template\n- What did I answer or do?\n- Which KC did it involve?\n- What assumption caused the mistake?\n- What is the corrected explanation?\n- What similar situation should I try next?\n\n` +
      `## 6. Transfer & Deepening Questions\n- Near transfer: ...\n- Far transfer: ...\n- Summary prompt: ...\n`;
  }

  return `你是学习节点「${input.node.name}」的复盘与深化蓝图设计师。\n\n` +
    `**v3 定位：** v3 服务用户自查、费曼复述、误解修复和理解深化。它不是主要出题引擎；持续出题由 v2 负责。\n\n` +
    `**基础 v${input.currentVersion} 蓝图：**\n${input.baseText}\n\n` +
    `**规则：**\n` +
    `- 基于 v1/v2 的 KC、练习错误类型和掌握证据设计复盘结构。\n` +
    `- 输出反思问题和复盘模板，不输出测试卷。\n` +
    `- 不假装系统能观察真实学习表现；所有检查都写成用户自评。\n` +
    `- 保持精炼，可直接服务费曼复盘清单生成。\n\n` +
    `**严格输出格式（不输出解释）：**\n\n` +
    `# 复盘与深化蓝图 — ${input.node.name}（v3）\n\n` +
    `## 1. 复盘目标\n- 复盘目标：...\n- 自评边界：...\n\n` +
    `## 2. 费曼复述问题\n### KC1: [KC 名称]\n- 用自己的话讲清楚：...\n- 解释为什么 / 何时成立：...\n- 解释一个边界或反例：...\n\n` +
    `## 3. 自检清单\n- [ ] ...\n- [ ] ...\n\n` +
    `## 4. 常见误解解释路径\n| 误解 | 解释路径 | 类比 / 表征 | 后续反思 |\n| --- | --- | --- | --- |\n| ... | ... | ... | ... |\n\n` +
    `## 5. 错题复盘模板\n- 我当时写了什么 / 做了什么？\n- 它涉及哪个 KC？\n- 错误背后的假设是什么？\n- 正确解释是什么？\n- 下一个相似情景该怎么试？\n\n` +
    `## 6. 迁移与深化问题\n- 近迁移：...\n- 远迁移：...\n- 总结提示：...\n`;
}

/**
 * Generate the next foundation blueprint (v1→v2 or v2→v3) from the current latest blueprint.
 * Writes the new file to `纲要/_outline_v{n}.md` and returns the new version number.
 * Throws if already at MAX_OUTLINE_VERSION or if no base blueprint exists.
 */
export async function generateNextOutlineVersion(
  opts: OutlineGenerateNextOptions,
  node: import('@shared/types').DagNode,
): Promise<number> {
  const outlineStartedAt = Date.now();
  const currentVersion = getOutlineVersionNumber(opts.courseId, opts.nodeId);
  if (currentVersion >= MAX_OUTLINE_VERSION) {
    throw new Error(
      `已达最高版本 v${MAX_OUTLINE_VERSION}，请使用「生成专题」功能深入某个 KC。`
    );
  }

  const nextVersion = currentVersion + 1;

  // Must have a versioned base blueprint to expand from
  const baseStartedAt = Date.now();
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '读取基础纲要', 'read base outline'),
    status: 'start',
    detail: localMsg(opts.language, `准备基于 v${currentVersion} 生成 v${nextVersion}。`, `Preparing to generate v${nextVersion} from v${currentVersion}.`),
    language: opts.language,
  }));
  const basePath = getLatestOutlinePath(opts.courseId, opts.nodeId);
  const baseText  = basePath
    ? (() => { try { return fs.readFileSync(basePath, 'utf-8').trim(); } catch { return ''; } })()
    : '';

  if (!baseText) {
    opts.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(opts.language, '读取基础纲要', 'read base outline'),
      status: 'fail',
      durationMs: Date.now() - baseStartedAt,
      detail: localMsg(opts.language, '基础纲要为空或不存在。', 'Base outline is empty or missing.'),
      language: opts.language,
    }));
    throw new Error('找不到基础纲要，请先生成 v1 纲要。');
  }
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '读取基础纲要', 'read base outline'),
    status: 'done',
    durationMs: Date.now() - baseStartedAt,
    detail: localMsg(opts.language, `读取 ${baseText.length.toLocaleString('en-US')} 字符。`, `Read ${baseText.length.toLocaleString('en-US')} chars.`),
    language: opts.language,
  }));

  const isEn = opts.language === 'en';
  const kcTargetRange = getKcCountRangeStr(node);
  const coverageStartedAt = Date.now();
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '读取覆盖记录', 'read coverage records'),
    status: 'start',
    detail: localMsg(opts.language, '读取原理/实践索引中的 KC 覆盖情况。', 'Reading KC coverage from theory/practice indexes.'),
    language: opts.language,
  }));
  const coverage = checkKcCoverage(opts.courseId, opts.nodeId);
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '读取覆盖记录', 'read coverage records'),
    status: 'done',
    durationMs: Date.now() - coverageStartedAt,
    detail: localMsg(opts.language, `已覆盖 ${coverage.coveredKcIds.length}，未覆盖 ${coverage.uncoveredKcIds.length}。`, `${coverage.coveredKcIds.length} covered, ${coverage.uncoveredKcIds.length} uncovered.`),
    language: opts.language,
  }));

  const targetLabel = nextVersion === 2
    ? localMsg(opts.language, '实践与出题蓝图', 'Practice & Exercise Blueprint')
    : localMsg(opts.language, '复盘与深化蓝图', 'Review & Deepening Blueprint');
  opts.onProgressChunk(isEn
    ? `📝 Generating ${targetLabel} v${nextVersion}…\n`
    : `📝 正在生成${targetLabel} v${nextVersion}…\n`);
  opts.onProgressChunk(formatOutlineContextTrace({
    node,
    provider: opts.provider,
    model: opts.model,
    currentVersion,
    targetVersion: nextVersion,
    kcTargetRange,
    baseOutlineChars: baseText.length,
    coveredKcCount: coverage.coveredKcIds.length,
    uncoveredKcCount: coverage.uncoveredKcIds.length,
    prerequisiteNames: (node.prerequisites ?? []).join(isEn ? ', ' : '、'),
    learningType: node.learning_type,
    bloomTarget: node.bloom_target,
    language: opts.language,
  }));

  const systemPrompt = nextVersion === 2
    ? buildPracticeBlueprintPrompt({ node, baseText, currentVersion, kcTargetRange, language: opts.language })
    : buildReviewBlueprintPrompt({ node, baseText, currentVersion, language: opts.language });

  const maxTokens = resolveOutputTokenBudget({
    provider: opts.provider,
    model: opts.model,
    task: 'outline',
  });
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '构建蓝图提示词', 'build blueprint prompt'),
    status: 'done',
    detail: localMsg(opts.language, `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；输出上限 ${maxTokens.toLocaleString('en-US')} tokens；KC 数量由节点目标自行决定。`, `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; output cap ${maxTokens.toLocaleString('en-US')} tokens; KC count is chosen from the node goal.`),
    language: opts.language,
  }));

  const generationStartedAt = Date.now();
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, `模型生成${targetLabel}`, `model drafts ${targetLabel}`),
    status: 'start',
    detail: localMsg(opts.language, `基于 v${currentVersion} 生成 ${targetLabel} v${nextVersion}。`, `Generating ${targetLabel} v${nextVersion} from v${currentVersion}.`),
    language: opts.language,
  }));
  const result = await streamStructuredCompletion({
    provider: opts.provider,
    model: opts.model,
    messages: [{ role: 'user', content: isEn
      ? `Please generate ${targetLabel} v${nextVersion} for "${node.name}".`
      : `请为「${node.name}」生成${targetLabel} v${nextVersion}。` }],
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    signal: opts.signal,
    kind: 'text',
    language: opts.language,
    maxContinuations: 2,
    onProgress: (msg) => opts.onProgressChunk(msg),
    onUsage: (usage) => { opts.onComplete?.(usage); },
  });

  let content = result.text.trim();
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, `模型生成${targetLabel}`, `model drafts ${targetLabel}`),
    status: 'done',
    durationMs: Date.now() - generationStartedAt,
    detail: localMsg(opts.language, `输出约 ${content.length.toLocaleString('en-US')} 字符；停止原因 ${result.stopReason}；续写 ${result.continuationCount} 次${result.hitContinuationLimit ? '；达到续写上限' : ''}。`, `Output about ${content.length.toLocaleString('en-US')} chars; stop reason ${result.stopReason}; continuations ${result.continuationCount}${result.hitContinuationLimit ? '; hit continuation limit' : ''}.`),
    language: opts.language,
  }));
  if (!content) {
    throw new Error(message('outlineVersionGenerationFailed', opts.language, {
      version: nextVersion,
      error:   localMsg(opts.language, '内容为空', 'empty response'),
    }));
  }

  const validationStartedAt = Date.now();
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '结构校验', 'structure validation'),
    status: 'start',
    detail: localMsg(opts.language, '检查蓝图核心章节、KC 字段、前置引用、掌握证据和明显空话；KC 数量只做软提示。', 'Checking blueprint sections, KC fields, prerequisites, mastery evidence, and vague placeholders; KC count is a soft warning only.'),
    language: opts.language,
  }));
  let validation = validateOutlineStructure(content, kcTargetRange, nextVersion);
  if (!validation.passed) {
    opts.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(opts.language, '结构校验', 'structure validation'),
      status: 'fail',
      durationMs: Date.now() - validationStartedAt,
      detail: localMsg(opts.language, `初稿问题 ${validation.issues.length} 个，触发一次修复生成。`, `${validation.issues.length} draft issue(s); triggering one repair generation.`),
      language: opts.language,
    }));
    opts.onProgressChunk(localMsg(opts.language,
      `- 纲要校验：v${nextVersion} 初稿未通过，正在要求模型修复。\n${formatOutlineValidationIssues(validation)}\n`,
      `- Outline validation: v${nextVersion} draft failed; asking the model to repair it.\n${formatOutlineValidationIssues(validation)}\n`,
    ));
    const repairStartedAt = Date.now();
    opts.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(opts.language, '修复生成', 'repair generation'),
      status: 'start',
      detail: localMsg(opts.language, '把校验问题和初稿发回模型，要求输出完整修复版。', 'Sending validation issues and the draft back to the model for a complete repaired version.'),
      language: opts.language,
    }));
    const repair = await streamStructuredCompletion({
      provider: opts.provider,
      model: opts.model,
      messages: [{
        role: 'user',
        content: localMsg(opts.language,
          `下面这份 v${nextVersion} 纲要未通过结构校验。请输出一份完整修复后的纲要全文，不要解释。\n\n校验问题：\n${formatOutlineValidationIssues(validation)}\n\n原纲要：\n${content}`,
          `This v${nextVersion} outline failed structural validation. Output the complete repaired outline only, with no explanation.\n\nValidation issues:\n${formatOutlineValidationIssues(validation)}\n\nOriginal outline:\n${content}`,
        ),
      }],
      systemPrompt,
      maxTokens,
      temperature: 0.15,
      signal: opts.signal,
      kind: 'text',
      language: opts.language,
      maxContinuations: 1,
      onProgress: (msg) => opts.onProgressChunk(msg),
      onUsage: (usage) => { opts.onComplete?.(usage); },
    });
    content = repair.text.trim();
    opts.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(opts.language, '修复生成', 'repair generation'),
      status: 'done',
      durationMs: Date.now() - repairStartedAt,
      detail: localMsg(opts.language, `修复版约 ${content.length.toLocaleString('en-US')} 字符；停止原因 ${repair.stopReason}；续写 ${repair.continuationCount} 次${repair.hitContinuationLimit ? '；达到续写上限' : ''}。`, `Repaired output about ${content.length.toLocaleString('en-US')} chars; stop reason ${repair.stopReason}; continuations ${repair.continuationCount}${repair.hitContinuationLimit ? '; hit continuation limit' : ''}.`),
      language: opts.language,
    }));
    validation = validateOutlineStructure(content, kcTargetRange, nextVersion);
  } else {
    if (validation.warnings.length > 0) {
      opts.onProgressChunk(localMsg(opts.language,
        `- 纲要校验提示（不阻断）：\n${formatOutlineValidationWarnings(validation)}\n`,
        `- Outline validation warnings (non-blocking):\n${formatOutlineValidationWarnings(validation)}\n`,
      ));
    }
    opts.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(opts.language, '结构校验', 'structure validation'),
      status: 'done',
      durationMs: Date.now() - validationStartedAt,
      detail: localMsg(opts.language, `初稿通过，无需二次修复生成；格式 ${validation.format}。`, `Draft passed; no repair generation needed; format ${validation.format}.`),
      language: opts.language,
    }));
  }

  if (!validation.passed) {
    throw new Error(message('outlineVersionGenerationFailed', opts.language, {
      version: nextVersion,
      error: formatOutlineValidationIssues(validation),
    }));
  }

  const writePath = path.join(getOutlineDirPath(opts.courseId, opts.nodeId), `_outline_v${nextVersion}.md`);
  opts.onProgressChunk(formatOutlineVerificationTrace({
    targetVersion: nextVersion,
    content,
    kcTargetRange,
    filename: path.basename(writePath),
    language: opts.language,
  }));
  const persistStartedAt = Date.now();
  writeOutlineAtomically(writePath, content);
  opts.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(opts.language, '写入纲要文件', 'persist outline file'),
    status: 'done',
    durationMs: Date.now() - persistStartedAt,
    detail: localMsg(opts.language, `保存到 ${path.basename(writePath)}；总耗时 ${((Date.now() - outlineStartedAt) / 1000).toFixed(1)} 秒。`, `Saved as ${path.basename(writePath)}; total ${((Date.now() - outlineStartedAt) / 1000).toFixed(1)}s.`),
    language: opts.language,
  }));
  opts.onProgressChunk(message('outlineVersionGeneratedProgress', opts.language, { version: nextVersion }));

  return nextVersion;
}
