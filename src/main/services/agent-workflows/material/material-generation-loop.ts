/**
 * MaterialGenerationLoop — agentic theory/practice material generation.
 *
 * Architecture: LLMAdapter.streamWithTools(), multi-turn loop.
 *   Turn N: model decides which tool to call (rag_retrieve / web_search /
 *            generate_quiz / save_file)
 *   Tool executes → result fed back → model continues
 *   When model emits pure text (end_turn) → loop exits
 *
 * Compression layers (cheapest → most expensive):
 *   1. Snip       — truncate single oversized messages  (snipMessage, always on)
 *   2. Microcompact — fold old turns into summary stub  (>20 turns, >85% budget)
 *   3. Context Collapse — LLM-generated summary         (>90% budget)
 */
import * as fs from 'fs';
import * as path from 'path';
import { GENERATE_FOLDER_KEYS } from '@shared/types';
import type { DagNode, EvidencePack, GenerateFolder, TokenUsage, FileGeneratedPayload, LLMProvider, SearchMode, OutlineVersionSelection } from '@shared/types';
import type { WorkflowLifecycle, WorkflowPhase } from '../workflow-lifecycle';
import { normalizeAgentError } from '../../agent-core/agent-errors';
import type { ToolCallBlock, ToolResultBlock, ToolTurnMessage } from '../../llm/adapter';
import { streamStructuredCompletion } from '../../llm/structured-stream';
import { NodeRepository } from '../../db/repositories/node.repo';
import {
  buildPracticeSourceBrief,
  buildOutlineSearchResults,
  detectDomain,
  formatPracticeSourceBrief,
} from '../../web/source-strategy';
import { collectEvidencePack, formatEvidencePack, summarizeEvidencePack } from '../../web/research-pipeline';
import { youtubeSearch } from '../../web/youtube';
import {
  checkKcCoverage,
  generateNextOutlineVersion,
  getOutlineBundleStatus,
  MAX_OUTLINE_VERSION,
  removeOutlineVersionsFrom,
} from '../outline-version';
import { buildOutlineContextForArtifact, normalizeOutlineVersionForArtifact, parseKcsFromOutline } from '../outline-context';
import { getFolderPath, getCourseDir, writeFileContent, getLatestOutlinePath, getOutlineV1WritePath, getOutlineDirPath } from '../../fs/content.service';
import type { ToolContext } from '../../agent-tools/tutor-tools/index';
import { buildTutorToolRegistry } from '../../agent-tools/tutor-tools/registry';
import { runToolChatLoop, type ToolChatLoopRunContext } from '../../agent-core/tool-chat-loop';
import { buildMaterialGenerationContext } from '../../agent-context/context-builder';
import { compressToolHistory } from '../../agent-context/compactor';
import { compactByDecision } from '../../agent-context/compaction-ladder';
import { getGenerationDefaultPrefixes, getMaterialWorkflowPrompt } from '../../agent-skills/registry';
import { message } from '../../agent-i18n/messages';
import {
  getArtifactDisplayName,
  getArtifactIndexEntry,
  getArtifactIndexHeader,
  getPairedAnswerFilename,
} from '../../agent-i18n/artifact-names';
import { formatVerificationIssues } from '../../agent-verifiers/types';
import { verifyPracticeHasAnswer } from '../../agent-verifiers/practice.verifier';
import { buildSystemPrompt, roleLayer, languageLayer, sourcesLayer, localMsg } from '../../prompt/prompt-builder';
import { classifyError, exponentialBackoff } from '../../llm/errors';
import { createBudget } from '../../agent-context/token-budget';
import { resolveContextWindowBudget } from '../../agent-context/context-window-budget';
import { resolveOutputTokenBudget } from '../../agent-context/output-token-budget';
import { computeKcRange, formatKcCountGuidance } from '../node-sizing';
import { createLogger } from '../../../utils/logger';
import {
  formatMaterialCompactionTrace,
  formatMaterialContextTrace,
  formatMaterialSaveTrace,
  formatMaterialSourceTrace,
  formatMaterialToolResultTrace,
  formatMaterialToolStartTrace,
  formatMaterialTurnTrace,
  formatMaterialVerificationTrace,
  formatGenerationStepTrace,
  formatOutlineContextTrace,
  formatOutlineSourceTrace,
  formatOutlineStepTrace,
  formatOutlineVerificationTrace,
} from './material-progress-trace';
import {
  formatOutlineValidationIssues,
  formatOutlineValidationWarnings,
  validateOutlineStructure,
  writeOutlineAtomically,
} from '../outline/outline-validation';

const log = createLogger('MaterialGenerationLoop');

function isGenerateFolder(value: string): value is GenerateFolder {
  return (GENERATE_FOLDER_KEYS as readonly string[]).includes(value);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 20;

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner: '入门', intermediate: '进阶', advanced: '高级',
};
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
};
function diffLabel(difficulty: string, language?: string): string {
  const map = language === 'en' ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH;
  return map[difficulty] ?? difficulty;
}

function createEmptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costCny: 0 };
}

function createMaterialLoopContext(
  req: MaterialGenerationRequest,
  accUsage: TokenUsage,
  onUsage: (usage: TokenUsage) => void,
): ToolChatLoopRunContext {
  return {
    get usage() {
      return { ...accUsage };
    },
    get isAborted() {
      return req.signal?.aborted ?? false;
    },
    addUsage(usage: Partial<TokenUsage> | undefined) {
      const inputCacheHitTokens = usage?.inputCacheHitTokens ?? 0;
      const inputCacheMissTokens = usage?.inputCacheMissTokens ?? 0;
      const normalized = {
        inputTokens: usage?.inputTokens ?? inputCacheHitTokens + inputCacheMissTokens,
        outputTokens: usage?.outputTokens ?? 0,
        costCny: usage?.costCny ?? 0,
        ...(inputCacheHitTokens > 0 ? { inputCacheHitTokens } : {}),
        ...(inputCacheMissTokens > 0 ? { inputCacheMissTokens } : {}),
        ...(usage?.estimated ? { estimated: true } : {}),
      };
      accUsage.inputTokens += normalized.inputTokens;
      accUsage.outputTokens += normalized.outputTokens;
      accUsage.costCny += normalized.costCny;
      if ((normalized.inputCacheHitTokens ?? 0) > 0) {
        accUsage.inputCacheHitTokens = (accUsage.inputCacheHitTokens ?? 0) + (normalized.inputCacheHitTokens ?? 0);
      }
      if ((normalized.inputCacheMissTokens ?? 0) > 0) {
        accUsage.inputCacheMissTokens = (accUsage.inputCacheMissTokens ?? 0) + (normalized.inputCacheMissTokens ?? 0);
      }
      if (normalized.estimated) accUsage.estimated = true;
      onUsage(normalized);
      return { ...accUsage };
    },
    chunk(chunk: string) {
      req.onChunk(chunk);
    },
    fail(error: unknown) {
      req.onError(normalizeAgentError(error).message);
    },
    complete() {
      // Material generation runs inside a chat tool; the outer chat loop owns the terminal stream event.
    },
  };
}

function materialPhaseLabel(req: MaterialGenerationRequest, phase: WorkflowPhase): string | null {
  const folder = getArtifactDisplayName(req.targetFolder, req.language);
  switch (phase) {
    case 'prepare_context':  return localMsg(req.language, '正在准备资料…', 'Preparing material…');
    case 'retrieve_sources': return localMsg(req.language, '正在检索资料…', 'Retrieving sources…');
    case 'generate_content': return localMsg(req.language, `正在生成${folder}…`, `Generating ${folder}…`);
    case 'verify':           return localMsg(req.language, '正在校验资料…', 'Verifying material…');
    default:                 return null;
  }
}

function startWorkflowPhase(req: MaterialGenerationRequest, phase: WorkflowPhase): void {
  req.lifecycle?.start(phase);
  // Clean user-facing phase hint (separate from the dev diagnostics trace).
  const label = materialPhaseLabel(req, phase);
  if (label) req.lifecycle?.context?.phase(label);
}

function completeWorkflowPhase(
  req: MaterialGenerationRequest,
  phase: WorkflowPhase,
  artifactIds: string[] = [],
): void {
  req.lifecycle?.complete(phase, artifactIds);
}

function failWorkflow(req: MaterialGenerationRequest, error: string): void {
  if (req.lifecycle) req.lifecycle.fail(normalizeAgentError(error));
}

// ── Repositories ──────────────────────────────────────────────────────────────

const nodeRepo = new NodeRepository();

// ── Outline & index helpers ───────────────────────────────────────────────────

function readIndexMd(courseId: string, nodeId: string, folderName: GenerateFolder): string {
  const indexPath = path.join(getFolderPath(courseId, nodeId, folderName), '_index.md');
  try {
    return fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';
  } catch {
    return '';
  }
}

function hasGeneratedMarkdownFiles(courseId: string, nodeId: string, folderName: GenerateFolder): boolean {
  try {
    const folderPath = getFolderPath(courseId, nodeId, folderName);
    if (!fs.existsSync(folderPath)) return false;
    return fs.readdirSync(folderPath).some((entry) => entry.endsWith('.md') && !entry.startsWith('_'));
  } catch {
    return false;
  }
}

function isNextPracticeRequest(text: string | undefined): boolean {
  if (!text) return false;
  return /下一套|下一份|再来(?:一)?套|再出(?:一)?套|再生成(?:一)?套|继续(?:出题|练习|生成)|不要重复|别重复|换一批|新(?:的)?练习|another\s+(?:set|round)|next\s+(?:set|round)|more\s+(?:practice|exercises)|non[-\s]?repeating/i.test(text);
}

function getOutlinePathForSelection(
  courseId: string,
  nodeId: string,
  selection?: OutlineVersionSelection,
): string | null {
  if (!selection || selection === 'latest') return getLatestOutlinePath(courseId, nodeId);
  const outlinePath = path.join(getOutlineDirPath(courseId, nodeId), `_outline_${selection}.md`);
  return fs.existsSync(outlinePath) ? outlinePath : null;
}

function readSelectedOutlineText(
  courseId: string,
  nodeId: string,
  selection?: OutlineVersionSelection,
): { text: string; path: string | null; version: string } {
  const outlinePath = getOutlinePathForSelection(courseId, nodeId, selection);
  const text = outlinePath
    ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8').trim(); } catch { return ''; } })()
    : '';
  return {
    text,
    path: outlinePath,
    version: getOutlineVersion(outlinePath),
  };
}

function buildMaterialOutlineContext(req: MaterialGenerationRequest): {
  text: string;
  path: string | null;
  version: string;
  kcSourceText: string;
  kcSourceVersion: OutlineVersionSelection | undefined;
  saveOutlineVersion: OutlineVersionSelection | undefined;
} {
  const artifactKind = req.targetFolder === 'practice' || req.targetFolder === 'answer'
    ? 'practice'
    : req.targetFolder === 'theory'
      ? 'theory'
      : 'review';
  const outlineVersion = normalizeOutlineVersionForArtifact({
    artifactKind,
    outlineVersion: req.outlineVersion,
    userMessage: req.userMessage,
  });
  const selected = buildOutlineContextForArtifact({
    courseId: req.courseId,
    nodeId: req.nodeId,
    artifactKind,
    outlineVersion,
    language: req.language,
  });
  return {
    text: selected.text,
    path: selected.path,
    version: selected.versionLabel,
    kcSourceText: selected.kcSourceText,
    kcSourceVersion: selected.kcSourceVersion,
    saveOutlineVersion: selected.primaryVersion,
  };
}

function buildMaterialToolMessages(content: string): ToolTurnMessage[] {
  return [{ role: 'user', content }];
}

function materialOutputTask(folder: GenerateFolder): Parameters<typeof resolveOutputTokenBudget>[0]['task'] {
  if (folder === 'practice') return 'material_practice';
  if (folder === 'answer') return 'material_answer';
  return 'material_theory';
}

function shouldAllowMaterialWebSearch(prepared: PreparedMaterialContext): boolean {
  if (prepared.searchMode === 'library' || prepared.searchMode === 'off') return false;
  if (prepared.isPractice) {
    // Practice generation already receives the system retrieval package and
    // a structured practice-source brief. Letting the model run free-form
    // web_search here often duplicates the same expensive search, inflates
    // context, and makes long streaming saves more fragile.
    return false;
  }
  return false;
}

function buildMaterialToolPolicyTrace(input: {
  prepared: PreparedMaterialContext;
  sources: MaterialSourceBundle;
  allowWebSearch: boolean;
  allowRagRetrieve: boolean;
  allowReadNodeMaterials: boolean;
  maxTokens: number;
  language?: string;
}): string {
  const tools = [
    input.allowRagRetrieve ? 'rag_retrieve' : '',
    input.allowReadNodeMaterials ? 'read_node_materials' : '',
    input.allowWebSearch ? 'web_search' : '',
    input.prepared.targetFolder === 'practice' ? 'generate_quiz' : '',
    'save_file',
  ].filter(Boolean);
  const reason = input.allowWebSearch
    ? localMsg(input.language, '实践题源不足或覆盖缺口较多，允许一次模型侧补搜。', 'Practice sources are insufficient or coverage gaps remain, so one model-side follow-up search is allowed.')
    : input.prepared.searchMode === 'library'
      ? localMsg(input.language, '严格参考库模式，禁用联网搜索。', 'Strict library mode; web search is disabled.')
      : input.prepared.targetFolder === 'theory'
        ? localMsg(input.language, '原理资料使用系统预检索与受控补搜结果，禁用模型自由 web_search。', 'Theory material uses system retrieval/controlled follow-up; free-form model web_search is disabled.')
        : input.prepared.targetFolder === 'practice'
          ? localMsg(input.language, '实践资料已在系统检索阶段完成题源/资料收集，禁用模型自由 web_search，避免重复补搜和上下文膨胀。', 'Practice material already receives system-collected sources/exercise patterns; free-form model web_search is disabled to avoid duplicate searches and context bloat.')
          : localMsg(input.language, '当前资料已有足够来源，禁用额外 web_search。', 'Current sources are sufficient; extra web_search is disabled.');
  return localMsg(
    input.language,
    `- 工具策略：开放 ${tools.join('、')}；${reason} 输出上限 ${input.maxTokens.toLocaleString('en-US')} tokens。\n` +
      (input.sources.controlledSearchReason ? `- 受控补搜：${input.sources.controlledSearchReason}\n` : ''),
    `- Tool policy: enabled ${tools.join(', ')}; ${reason} output cap ${input.maxTokens.toLocaleString('en-US')} tokens.\n` +
      (input.sources.controlledSearchReason ? `- Controlled follow-up: ${input.sources.controlledSearchReason}\n` : ''),
  );
}

function createHiddenDraftProgress(req: MaterialGenerationRequest): (chunk: string) => void {
  let chars = 0;
  let lastChars = 0;
  let lastAt = Date.now();
  let announced = false;
  return (chunk: string) => {
    chars += chunk.length;
    const now = Date.now();
    if (!announced) {
      announced = true;
      req.onProgressChunk(localMsg(req.language,
        '- 正文生成：模型正在撰写资料正文，正文内容会直接进入 save_file，不在聊天区展开。\n',
        '- Draft generation: the model is writing the artifact body; content will go into save_file and is not expanded in chat.\n',
      ));
    }
    if (chars - lastChars < 2_000 && now - lastAt < 5_000) return;
    lastChars = chars;
    lastAt = now;
    req.onProgressChunk(localMsg(req.language,
      `- 正文生成：已生成约 ${chars.toLocaleString('en-US')} 字符，等待模型调用 save_file 保存…\n`,
      `- Draft generation: about ${chars.toLocaleString('en-US')} chars generated, waiting for save_file...\n`,
    ));
  };
}

// ── KC coverage helpers ───────────────────────────────────────────────────────

/** Extract outline version string (v1/v2/v3) from file path; returns 'v1' for legacy. */
function getOutlineVersion(outlinePath: string | null): string {
  if (!outlinePath) return 'v1';
  const m = path.basename(outlinePath).match(/_outline_(v\d+)\.md/);
  return m ? m[1] : 'v1';
}

function compactList(items: string[], fallback: string, max = 8): string {
  const deduped = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return deduped.length > 0 ? deduped.slice(0, max).join('、') : fallback;
}

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

interface PracticeQuestionBlock {
  heading: string;
  text: string;
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function splitPracticeQuestionBlocks(content: string): PracticeQuestionBlock[] {
  const lines = content.split('\n');
  const starts: number[] = [];
  const headingRe = /^\s*(?:#{1,6}\s*)?(?:Q\s*\d+|[A-D]\s*\d+|问题\s*\d+|题目\s*\d+|\d{1,2}[.、])\b/i;
  lines.forEach((line, index) => {
    if (headingRe.test(cleanMarkdownLine(line))) starts.push(index);
  });
  if (starts.length === 0) return [];
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const blockLines = lines.slice(start, end);
    return {
      heading: cleanMarkdownLine(blockLines[0] ?? ''),
      text: blockLines.join('\n').trim(),
    };
  }).filter((block) => block.text.length > 20);
}

function metadataValue(block: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:^|\\n)\\s*[-*•]?\\s*(?:\\*\\*)?\\s*(?:${labelPattern})\\s*(?:\\*\\*)?\\s*[:：]\\s*([^\\n]+)`, 'i');
  const match = block.match(re);
  return match?.[1]?.replace(/\*\*/g, '').trim() || null;
}

function extractPracticeKcs(content: string): string[] {
  const blocks = splitPracticeQuestionBlocks(content);
  if (blocks.length > 0) {
    const values = new Set<string>();
    for (const block of blocks) {
      const value = metadataValue(block.text, ['KC', '知识点', 'Knowledge Component']);
      if (value) {
        const id = value.match(/\bKC\s*\d+\b/i)?.[0]?.replace(/\s+/g, '').toUpperCase();
        values.add(id ? `${id}${value.replace(/\bKC\s*\d+\b/i, '').trim() ? ` ${value.replace(/\bKC\s*\d+\b/i, '').replace(/^[-—:：·\s]+/, '').trim()}` : ''}` : value);
        continue;
      }
      const id = block.text.match(/\bKC\s*\d+\b/i)?.[0]?.replace(/\s+/g, '').toUpperCase();
      if (id) values.add(id);
    }
    if (values.size > 0) return [...values];
  }
  const values = new Set<string>();
  for (const match of content.matchAll(/\b(KC\d+)\b(?:\s*[：:·-]\s*([^\n，,；;）)]{1,32}))?/gi)) {
    const id = match[1].toUpperCase();
    const name = match[2]?.trim();
    values.add(name ? `${id} ${name}` : id);
  }
  return [...values];
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function formatDistribution(counts: Map<string, number>, language?: string): string {
  return counts.size > 0
    ? [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(language === 'en' ? ', ' : '，')
    : localMsg(language, '未显式标注', 'not explicitly labeled');
}

function countMap(entries: Array<[string, number]>): Map<string, number> {
  return new Map(entries.filter(([, count]) => count > 0));
}

function practiceTypeDistribution(content: string, language?: string): string {
  const blocks = splitPracticeQuestionBlocks(content);
  if (blocks.length > 0) {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const value = `${metadataValue(block.text, ['题型', 'Type']) ?? ''} ${block.heading}`;
      if (/变式|Variation|Group\s*B|^B\s*\d+/i.test(value)) increment(counts, localMsg(language, '变式题', 'Variation'));
      else if (/错误诊断|诊断|Error\s*Diagnosis|Group\s*C|^C\s*\d+/i.test(value)) increment(counts, localMsg(language, '错误诊断', 'Error diagnosis'));
      else if (/迁移|综合|Transfer|Synthesis|Group\s*D|^D\s*\d+/i.test(value)) increment(counts, localMsg(language, '迁移综合', 'Transfer/synthesis'));
      else increment(counts, localMsg(language, '原型题', 'Prototype'));
    }
    return formatDistribution(counts, language);
  }
  const fallback = countMap([
    [localMsg(language, '原型题', 'Prototype'), countMatches(content, /A\s*组|核心原型|原型题|Prototype/gi)],
    [localMsg(language, '变式题', 'Variation'), countMatches(content, /B\s*组|变式|Variation/gi)],
    [localMsg(language, '错误诊断', 'Error diagnosis'), countMatches(content, /C\s*组|错误诊断|诊断|Error\s*Diagnosis/gi)],
    [localMsg(language, '迁移综合', 'Transfer/synthesis'), countMatches(content, /D\s*组|迁移|综合|Transfer|Synthesis/gi)],
  ]);
  return formatDistribution(fallback, language);
}

function cognitiveDistribution(content: string, language?: string): string {
  const blocks = splitPracticeQuestionBlocks(content);
  if (blocks.length > 0) {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const value = metadataValue(block.text, ['认知动作', 'Cognitive Action', 'Cognitive Process', '布鲁姆', 'Bloom']) ?? block.text.slice(0, 240);
      if (/创造|Create/i.test(value)) increment(counts, localMsg(language, '创造', 'Create'));
      else if (/评估|Evaluate/i.test(value)) increment(counts, localMsg(language, '评估', 'Evaluate'));
      else if (/分析|Analyze|Analyse/i.test(value)) increment(counts, localMsg(language, '分析', 'Analyze'));
      else if (/应用|Apply/i.test(value)) increment(counts, localMsg(language, '应用', 'Apply'));
      else increment(counts, localMsg(language, '理解', 'Understand'));
    }
    return formatDistribution(counts, language);
  }
  const counts = countMap([
    [localMsg(language, '理解', 'Understand'), countMatches(content, /理解|记忆|Remember|Understand/gi)],
    [localMsg(language, '应用', 'Apply'), countMatches(content, /应用|Apply/gi)],
    [localMsg(language, '分析', 'Analyze'), countMatches(content, /分析|Analyze|Analyse/gi)],
    [localMsg(language, '评估', 'Evaluate'), countMatches(content, /评估|Evaluate/gi)],
    [localMsg(language, '创造', 'Create'), countMatches(content, /创造|Create/gi)],
  ]);
  return formatDistribution(counts, language);
}

function sourceStrategyDistribution(content: string, language?: string): string {
  const blocks = splitPracticeQuestionBlocks(content);
  if (blocks.length > 0) {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const value = metadataValue(block.text, ['来源策略', 'Source Strategy']) ?? block.text;
      if (/来源改编|Adapted|Source:|来源[:：]/i.test(value)) increment(counts, localMsg(language, '来源改编', 'Adapted'));
      else if (/题型参考|Pattern Reference/i.test(value)) increment(counts, localMsg(language, '题型参考', 'Pattern reference'));
      else if (/AI\s*原创|AI Original/i.test(value)) increment(counts, localMsg(language, 'AI原创', 'AI original'));
      else increment(counts, localMsg(language, '未显式标注', 'not explicitly labeled'));
    }
    return formatDistribution(counts, language);
  }
  const counts = countMap([
    [localMsg(language, 'AI原创', 'AI original'), countMatches(content, /AI原创|AI Original/gi)],
    [localMsg(language, '题型参考', 'Pattern reference'), countMatches(content, /题型参考|Pattern Reference/gi)],
    [localMsg(language, '来源改编', 'Adapted'), countMatches(content, /来源改编|Source:\s|来源[:：]|Adapted/gi)],
  ]);
  return formatDistribution(counts, language);
}

function extractPracticeScenarioHints(content: string, language?: string): string {
  const blocks = splitPracticeQuestionBlocks(content);
  if (blocks.length > 0) {
    return compactList(
      blocks.map((block) => block.heading.replace(/^Q\s*\d+[.、:：\s-]*/i, '').trim()),
      localMsg(language, '未提取到明显场景', 'no obvious scenario extracted'),
      8,
    );
  }
  const lines = content
    .split('\n')
    .map((line) => line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/\*\*|__|`|>\s*/g, '')
      .trim())
    .filter((line) =>
      line.length >= 6 &&
      line.length <= 80 &&
      /场景|情境|案例|变量|数据|实验|代码|矩阵|函数|证明|推导|操作|项目|scenario|case|data|experiment|code|matrix|proof|operation/i.test(line) &&
      !/^[-|:：]+$/.test(line));
  return compactList(lines, localMsg(language, '未提取到明显场景', 'no obvious scenario extracted'), 8);
}

function buildNextPracticeSuggestion(content: string, language?: string): string {
  const missing: string[] = [];
  if (!/变式|Variation/i.test(content)) missing.push(localMsg(language, '补变式题', 'add variation exercises'));
  if (!/错误诊断|Error\s*Diagnosis|诊断/i.test(content)) missing.push(localMsg(language, '补错误诊断题', 'add error-diagnosis exercises'));
  if (!/迁移|综合|Transfer|Synthesis/i.test(content)) missing.push(localMsg(language, '补迁移/综合题', 'add transfer/synthesis exercises'));
  if (missing.length > 0) {
    return missing.join(language === 'en' ? ', ' : '、');
  }
  return localMsg(language,
    '更换场景、变量、表征方式或错误类型，避免复用本套题的题干结构。',
    'Change scenarios, variables, representations, or error types; avoid reusing this set’s question structures.',
  );
}

function buildPracticeHistoryEntry(
  fileName: string,
  date: string,
  content: string,
  language?: string,
): string {
  const kcs = compactList(extractPracticeKcs(content), localMsg(language, '未显式标注', 'not explicitly labeled'), 12);
  if (language === 'en') {
    return `\n### ${fileName} (${date})\n` +
      `- Covered KCs: ${kcs}\n` +
      `- Exercise types: ${practiceTypeDistribution(content, language)}\n` +
      `- Cognitive actions: ${cognitiveDistribution(content, language)}\n` +
      `- Used scenarios / variables: ${extractPracticeScenarioHints(content, language)}\n` +
      `- Source strategies: ${sourceStrategyDistribution(content, language)}\n` +
      `- Next-set hint: ${buildNextPracticeSuggestion(content, language)}\n`;
  }
  return `\n### ${fileName}（${date}）\n` +
    `- 覆盖 KC：${kcs}\n` +
    `- 题型分布：${practiceTypeDistribution(content, language)}\n` +
    `- 认知动作：${cognitiveDistribution(content, language)}\n` +
    `- 已用场景 / 变量：${extractPracticeScenarioHints(content, language)}\n` +
    `- 来源策略：${sourceStrategyDistribution(content, language)}\n` +
    `- 下一套建议：${buildNextPracticeSuggestion(content, language)}\n`;
}

function ensurePracticeHistorySection(existing: string, language?: string): string {
  if (/^##\s+(?:Practice History|出题历史)/m.test(existing)) return existing;
  const heading = localMsg(language, '## 出题历史\n', '## Practice History\n');
  return `${existing.trimEnd()}\n\n${heading}`;
}

function buildPracticeHistoryGuide(req: MaterialGenerationRequest, indexText: string): string {
  if (req.targetFolder !== 'practice') return '';
  const nextPractice = isNextPracticeRequest(req.userMessage);
  return localMsg(req.language,
    `\n\n**出题历史与下一套练习要求：**\n` +
    `- 生成实践资料时必须同时参考 [学习蓝图 / 纲要] 和 [已有资料覆盖情况]；其中 [已有资料覆盖情况] 里的「出题历史」记录了过去练习覆盖过的 KC、题型、场景、变量和下一套建议。\n` +
    `- ${indexText.trim() ? '已有出题历史可用：优先避开其中记录的 KC×题型×场景重复组合。' : '当前没有出题历史：按 v2 蓝图生成第一套基础练习，并在题目中清楚标注 KC、题型和来源策略。'}\n` +
    `- 如果工具列表开放 read_node_materials，且你需要确认已有题目的具体形式，可以读取 practice；若需要和已学原理对齐，可以读取 theory。不要默认全文照搬旧题。\n` +
    (nextPractice
      ? `- 用户这次是在要“下一套/再来一套/继续练”：必须生成新的非重复练习，优先补历史中薄弱或未覆盖的题型/KC，换场景、变量、表征或错误类型；不要重新生成同一套全纲要基础题。\n`
      : `- 如果用户没有要求下一套，仍要避免和历史题目明显重复；可以生成默认分层练习。\n`),
    `\n\n**Practice history and next-set requirements:**\n` +
    `- Practice generation must use both [Learning Blueprint / Outline] and [Coverage Index]. The Practice History section records previous KC, exercise-type, scenario, variable, and next-set hints.\n` +
    `- ${indexText.trim() ? 'Practice history is available: avoid repeating recorded KC × exercise type × scenario combinations.' : 'No practice history is available: generate the first baseline set from the v2 blueprint and clearly label KC, type, and source strategy.'}\n` +
    `- If read_node_materials is available and you need concrete prior question forms, read practice; read theory only when alignment with existing explanations is needed. Do not copy old questions.\n` +
    (nextPractice
      ? `- The user is asking for a next/additional practice set: generate a new non-repeating set, prioritize weak/uncovered KC or exercise types from history, and change scenarios, variables, representations, or error types. Do not regenerate the same full-outline baseline set.\n`
      : `- Even without an explicit next-set request, avoid obvious repetition with historical exercises; a default tiered set is acceptable.\n`),
  );
}

/**
 * Append a KC coverage record to _index.md after each file save.
 * - KC-model outlines: records which KC IDs are covered (by name match in content).
 * - Legacy outlines: falls back to H2 heading extraction.
 * Non-fatal — errors are logged and swallowed.
 */
function appendToIndexMd(
  courseId: string,
  nodeId: string,
  folderName: GenerateFolder,
  filename: string,
  content: string,
  language?: string,
  outlineTextOverride?: string,
  outlineVersionOverride?: string,
): void {
  try {
    const folderPath  = getFolderPath(courseId, nodeId, folderName);
    const indexPath   = path.join(folderPath, '_index.md');
    const date        = new Date().toISOString().slice(0, 10);

    // Try KC-based coverage (new format)
    const outlinePath = outlineTextOverride ? null : getLatestOutlinePath(courseId, nodeId);
    const outlineText = outlineTextOverride
      ?? (outlinePath
        ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8'); } catch { return ''; } })()
        : '');
    const kcs = parseKcsFromOutline(outlineText);

    let entry: string;
    if (kcs.length > 0) {
      const coveredIds = kcs.map((kc) => kc.id);
      const kcList = coveredIds.length > 0
        ? coveredIds.map((id) => {
            const kc = kcs.find((k) => k.id === id);
            return kc ? `${id} (${kc.name})` : id;
          }).join(', ')
        : localMsg(language, '（未匹配到 KC）', '(no KCs matched)');
      const version = outlineVersionOverride ?? getOutlineVersion(outlinePath);
      entry = getArtifactIndexEntry(folderName, {
        fileName: filename,
        date,
        coverage: kcList,
        outlineVersion: version,
      }, language);
    } else {
      // Legacy fallback: extract H2 headings
      const headings = content
        .split('\n')
        .filter((line) => /^##\s/.test(line))
        .map((line)  => line.replace(/^##\s+/, '').trim())
        .join(language === 'en' ? ', ' : '、');
      entry = getArtifactIndexEntry(folderName, { fileName: filename, date, headings }, language);
    }

    let existing = '';
    if (fs.existsSync(indexPath)) {
      existing = fs.readFileSync(indexPath, 'utf-8');
    } else {
      existing = getArtifactIndexHeader(folderName, language);
    }

    if (folderName === 'practice') {
      const withHistory = ensurePracticeHistorySection(existing + entry, language);
      writeFileContent(indexPath, withHistory + buildPracticeHistoryEntry(filename, date, content, language));
    } else {
      writeFileContent(indexPath, existing + entry);
    }
  } catch (err) {
    log.warn('写入 _index.md 失败（非致命）', { error: String(err) });
  }
}

/** Returns true if the outline already has Bloom-level annotations (Chinese or English). */
export function outlineHasBloomTags(text: string): boolean {
  return /(?:布鲁姆层级|Bloom\s*Level)\s*[:：]\s*\[?\s*(记忆\/理解|分析\/评估|应用|创造|Remember\/Understand|Analyse\/Evaluate|Apply|Create)\s*\]?/i.test(text);
}

/** Returns true if the outline uses the Learning Blueprint format. */
export function outlineHasLearningBlueprintSections(text: string): boolean {
  return /学习蓝图|Learning Blueprint/i.test(text)
    && /##\s+\d*[.、]?\s*(?:学习目标|Learning Goals|Performance Goals)/i.test(text)
    && /##\s+\d*[.、]?\s*(?:核心知识结构|Knowledge Structure|Core Knowledge Structure)/i.test(text)
    && /##\s+\d*[.、]?\s*(?:学习推进|Learning Flow|Learning Sequence)/i.test(text)
    && /##\s+\d*[.、]?\s*(?:掌握证据|测评证据|Evidence|Diagnosis)/i.test(text);
}

const BLOOM_TARGET_LABEL_ZH: Record<string, string> = {
  remember_understand: '记忆/理解',
  analyze_evaluate:    '分析/评估',
  apply:               '应用',
  create:              '创造',
};
const BLOOM_TARGET_LABEL_EN: Record<string, string> = {
  remember_understand: 'Remember/Understand',
  analyze_evaluate:    'Analyse/Evaluate',
  apply:               'Apply',
  create:              'Create',
};

/** Minimal options for v1 outline generation — subset of MaterialGenerationRequest. */
export interface OutlineV1GenOpts {
  courseId: string;
  nodeId:   string;
  provider: LLMProvider;
  model:    string;
  signal?:  AbortSignal;
  language?: string;
  searchMode?: SearchMode;
  onProgressChunk: (msg: string) => void;
  onComplete?: (usage: TokenUsage) => void;
}

/** Generate v1 outline from scratch. Exported for use by the IPC handler when no outline exists yet. */
export async function generateOutlineV1(
  opts: OutlineV1GenOpts,
  node: import('@shared/types').DagNode,
  behavior: { startsMaterialAfter?: boolean } = {},
): Promise<void> {
  return generateOutline(opts, node, behavior);
}

/** Dedicated LLM call to generate outline (written to 纲要/_outline_v1.md). */
async function generateOutline(
  req: OutlineV1GenOpts,
  node: import('@shared/types').DagNode,
  behavior: { startsMaterialAfter?: boolean } = {},
): Promise<void> {
  const outlineStartedAt = Date.now();
  req.onProgressChunk(message('outlineGenerating', req.language));

  // ── Phase 1a: Read chapter_scope for this node ─────────────────────────────
  const scopeStartedAt = Date.now();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '读取 chapter_scope', 'read chapter_scope'),
    status: 'start',
    detail: localMsg(req.language, '读取路线规划给当前节点分配的知识边界。', 'Reading roadmap-assigned knowledge boundaries for this node.'),
    language: req.language,
  }));
  let nodeScope: string[]   = [];
  let boundaryNotes         = '';
  try {
    const scopePath = path.join(getCourseDir(req.courseId), '_chapter_scope.json');
    if (fs.existsSync(scopePath)) {
      const scopeData = JSON.parse(fs.readFileSync(scopePath, 'utf-8')) as Record<string, {
        scope_distribution?: Record<string, string[]>;
        boundary_notes?: string;
      }>;
      const chapterData = scopeData[node.chapter];
      if (chapterData?.scope_distribution?.[node.name]) {
        nodeScope = chapterData.scope_distribution[node.name];
      }
      if (chapterData?.boundary_notes) boundaryNotes = chapterData.boundary_notes;
    }
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '读取 chapter_scope', 'read chapter_scope'),
      status: 'done',
      durationMs: Date.now() - scopeStartedAt,
      detail: localMsg(req.language, `命中 ${nodeScope.length} 条范围；边界备注 ${boundaryNotes ? '有' : '无'}。`, `${nodeScope.length} scope item(s); boundary notes ${boundaryNotes ? 'yes' : 'no'}.`),
      language: req.language,
    }));
  } catch (err) {
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '读取 chapter_scope', 'read chapter_scope'),
      status: 'fail',
      durationMs: Date.now() - scopeStartedAt,
      detail: localMsg(req.language, `非致命，继续生成：${err instanceof Error ? err.message : String(err)}`, `Non-fatal; continuing: ${err instanceof Error ? err.message : String(err)}`),
      language: req.language,
    }));
  }

  // ── Phase 1b: Read adjacent node outlines (prereqs + same-chapter nodes) ──
  const adjacentStartedAt = Date.now();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '读取相邻纲要', 'read adjacent outlines'),
    status: 'start',
    detail: localMsg(req.language, '读取前置节点和同章节点的已有纲要，避免重复覆盖。', 'Reading prerequisite and same-chapter outlines to avoid duplicated coverage.'),
    language: req.language,
  }));
  const allNodes    = nodeRepo.findByCourse(req.courseId);
  const prereqIds   = new Set(node.prerequisites ?? []);
  const adjacentIds = new Set(
    allNodes
      .filter((n) => prereqIds.has(n.id) || (n.chapter === node.chapter && n.id !== node.id))
      .map((n) => n.id),
  );

  const adjacentSections: string[] = [];
  for (const adj of allNodes.filter((n) => adjacentIds.has(n.id)).slice(0, 4)) {
    const adjPath = getLatestOutlinePath(req.courseId, adj.id);
    try {
      if (adjPath && fs.existsSync(adjPath)) {
        const content = fs.readFileSync(adjPath, 'utf-8').trim();
        if (content) {
          const label = prereqIds.has(adj.id)
            ? localMsg(req.language, '前置节点', 'prerequisite node')
            : localMsg(req.language, '同章节点', 'same-chapter node');
          adjacentSections.push(
            req.language === 'en'
              ? `### "${adj.name}" (${label}) — already covered:\n${content.slice(0, 500)}`
              : `### 「${adj.name}」（${label}）已覆盖的知识点：\n${content.slice(0, 500)}`,
          );
        }
      }
    } catch { /* non-fatal */ }
  }
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '读取相邻纲要', 'read adjacent outlines'),
    status: 'done',
    durationMs: Date.now() - adjacentStartedAt,
    detail: localMsg(req.language, `扫描课程节点 ${allNodes.length} 个，采用相邻纲要 ${adjacentSections.length} 个。`, `Scanned ${allNodes.length} course node(s), used ${adjacentSections.length} adjacent outline(s).`),
    language: req.language,
  }));

  // ── Phase 1c: Web search — two streams: curriculum structure + misconceptions ──
  let curriculumWebContext = '';
  let misconceptionWebContext = '';
  let outlineResults: Array<{ title: string; url: string; content: string; kind: 'curriculum' | 'misconception' }> = [];
  const sourceStartedAt = Date.now();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '检索纲要参考', 'retrieve outline references'),
    status: 'start',
    detail: localMsg(req.language, `模式 ${req.searchMode ?? 'auto'}；会先查本地参考库，资料不足时可能进入资料规划、搜索、质量评分和页面读取。`, `Mode ${req.searchMode ?? 'auto'}; searches local library first, and may plan sources, search, score quality, and read pages when evidence is insufficient.`),
    language: req.language,
  }));
  try {
    outlineResults = await buildOutlineSearchResults(
      node.name, node.description ?? null,
      {
        provider: req.provider as string,
        model: req.model,
        signal: req.signal,
        courseId: req.courseId,
        nodeId: req.nodeId,
        searchMode: req.searchMode ?? 'auto',
        language: req.language,
        onUsage: req.onComplete,
      },
    );
    const curriculumResults   = outlineResults.filter((r) => r.kind === 'curriculum');
    const misconceptionResults = outlineResults.filter((r) => r.kind === 'misconception');

    if (curriculumResults.length > 0) {
      curriculumWebContext = curriculumResults
        .map((r) => req.language === 'en'
          ? `[Curriculum Reference] ${r.title}\nSource: ${r.url}\n${r.content.slice(0, 400)}`
          : `[课程参考] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 400)}`)
        .join('\n\n');
    }
    if (misconceptionResults.length > 0) {
      misconceptionWebContext = misconceptionResults
        .map((r) => req.language === 'en'
          ? `[Misconception Reference] ${r.title}\nSource: ${r.url}\n${r.content.slice(0, 400)}`
          : `[误解参考] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 400)}`)
        .join('\n\n');
    }
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '检索纲要参考', 'retrieve outline references'),
      status: 'done',
      durationMs: Date.now() - sourceStartedAt,
      detail: localMsg(req.language, `采用参考 ${outlineResults.length} 条；课程结构 ${outlineResults.filter((r) => r.kind === 'curriculum').length}，误解/边界 ${outlineResults.filter((r) => r.kind === 'misconception').length}。`, `${outlineResults.length} reference(s); ${outlineResults.filter((r) => r.kind === 'curriculum').length} curriculum, ${outlineResults.filter((r) => r.kind === 'misconception').length} misconception/boundary.`),
      language: req.language,
    }));
  } catch (err) {
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '检索纲要参考', 'retrieve outline references'),
      status: 'fail',
      durationMs: Date.now() - sourceStartedAt,
      detail: localMsg(req.language, `非致命，改用节点上下文生成：${err instanceof Error ? err.message : String(err)}`, `Non-fatal; using node context: ${err instanceof Error ? err.message : String(err)}`),
      language: req.language,
    }));
  }

  // ── Phase 2: Build KC model system prompt ─────────────────────────────────
  const bloomTargetMap = req.language === 'en' ? BLOOM_TARGET_LABEL_EN : BLOOM_TARGET_LABEL_ZH;
  const bloomTarget  = node.bloom_target ? (bloomTargetMap[node.bloom_target] ?? node.bloom_target) : null;
  const isMotorSkill = node.learning_type === 'motor_skill';
  const isEn = req.language === 'en';

  const kcRange = computeKcRange(node);

  const scopeSection = nodeScope.length > 0
    ? (isEn
        ? `\n\n**Knowledge scope for this node (from chapter_scope — stay strictly within this list):**\n`
        : `\n\n**本节点知识点范围（来自路线规划 chapter_scope，严格在此范围内）：**\n`) +
      nodeScope.map((k) => `- ${k}`).join('\n') +
      (boundaryNotes ? (isEn ? `\nBoundary notes: ${boundaryNotes}` : `\n边界备注：${boundaryNotes}`) : '')
    : '';

  const adjacentSection = adjacentSections.length > 0
    ? (isEn
        ? `\n\n**Already covered in adjacent nodes (avoid repeating these topics):**\n${adjacentSections.join('\n\n')}`
        : `\n\n**相邻节点已覆盖内容（生成时避免重复下列知识点）：**\n${adjacentSections.join('\n\n')}`)
    : '';

  const strictLibraryOutline = req.searchMode === 'library';
  const curriculumSection = curriculumWebContext
    ? strictLibraryOutline
      ? (isEn
          ? `\n\n**Strict source-library references — KC selection must stay within these local-source snippets. Do not add outside curriculum topics not supported here:**\n${curriculumWebContext}`
          : `\n\n**严格参考库结构参考——KC 选题必须限制在这些本地资料片段内。不要补充这些资料没有支撑的外部课程知识点：**\n${curriculumWebContext}`)
      : (isEn
          ? `\n\n**Curriculum references — validate KC completeness against these authoritative course structures. Ensure your KC list covers the key topics identified here; add any missing core topics as KCs:**\n${curriculumWebContext}`
          : `\n\n**课程结构参考——用于校验 KC 选题的完整性和权威性。确保 KC 列表覆盖这里权威来源标识的核心话题；若有遗漏的核心知识点，补充为 KC：**\n${curriculumWebContext}`)
    : '';

  const misconceptionSection = misconceptionWebContext
    ? (isEn
        ? `\n\n**Misconception and boundary references — use them only for each KC's "Common misconception" field and the "Evidence & Diagnosis" section. Do not use them to modify the KC structure unless they expose a real missing core concept:**\n${misconceptionWebContext}`
        : `\n\n**误解与边界参考——仅用于填充各 KC 的“常见误解”和“掌握证据与诊断”章节；除非暴露真正缺失的核心概念，否则不要用它们改动 KC 结构：**\n${misconceptionWebContext}`)
    : '';

  const cognitiveGoalNote = bloomTarget
    ? (isEn
        ? `\n\n**Cognitive endpoint:** This node's bloomTarget is "${bloomTarget}". Use it as the endpoint performance level, not as a quota for every KC. Foundational concepts may still use lower cognitive actions when needed.`
        : `\n\n**认知终点：** 该节点 bloomTarget 为「${bloomTarget}」。它表示节点最终表现层级，不是每个 KC 的配额；必要的基础概念仍可使用较低认知动作。`)
    : '';
  const kcCountGuidance = formatKcCountGuidance(kcRange, req.language);

  const motorSkillNote = isMotorSkill
    ? (isEn
        ? `\n\n**Motor-skill node:** Procedural KCs must include specific operation steps ("how to do it"); conditional-strategy KCs must include observable self-check evidence ("signs of correct completion").`
        : `\n\n**动作技能节点：** 程序性 KC 的掌握证据必须包含具体操作步骤（“如何做”）；条件策略 KC 需包含可观察的自检证据（“正确完成的标志”）。`)
    : '';

  req.onProgressChunk(formatOutlineContextTrace({
    node,
    provider: req.provider,
    model: req.model,
    searchMode: req.searchMode ?? 'auto',
    currentVersion: 0,
    targetVersion: 1,
    kcTargetRange: `${kcRange.min}-${kcRange.max}`,
    nodeScopeCount: nodeScope.length,
    boundaryNotes,
    adjacentOutlineCount: adjacentSections.length,
    prerequisiteNames: (node.prerequisites ?? [])
      .map((pid) => allNodes.find((n) => n.id === pid)?.name)
      .filter(Boolean)
      .join(req.language === 'en' ? ', ' : '、'),
    learningType: node.learning_type,
    bloomTarget: node.bloom_target,
    language: req.language,
  }));
  req.onProgressChunk(formatOutlineSourceTrace({
    references: outlineResults.map((result) => ({
      title: result.title,
      url: result.url,
      kind: result.kind,
    })),
    strictLibraryMode: strictLibraryOutline,
    language: req.language,
  }));

  const systemPrompt = isEn
    ? `You are a learning-blueprint architect. Generate a concise Learning Blueprint outline v1 for the learning node "${node.name}" (${node.chapter}, ${diffLabel(node.difficulty, req.language)}).\n\n` +
      `**Output a compact blueprint for later theory, practice, and review generation — not teaching content and not a mini textbook.**` +
      scopeSection + adjacentSection + curriculumSection + misconceptionSection + cognitiveGoalNote + motorSkillNote +
      (strictLibraryOutline ? `\n\n**Strict library mode:** If source-library snippets are insufficient, create a smaller blueprint and state missing scope in "Evidence & Diagnosis"; do not invent external KCs.` : '') +
      `\n\n**Generation logic (internalise, do not write out):**\n` +
      `① Start from the endpoint performance: what can the learner do after this node?\n` +
      `② Identify prerequisites to activate, then choose the KC granularity needed to complete the node task.\n` +
      `③ Cross-check curriculum references for core topic coverage, but avoid duplicate adjacent-node content.\n` +
      `④ For each KC, provide only the fields downstream materials actually use: role, cognitive action, prerequisite links, core relation, representation/example/counterexample, misconception, and mastery evidence.\n` +
      `⑤ Plan a lightweight learning flow and an evidence model that pairs positive mastery evidence with likely errors; downstream practice/review generation should be able to use it directly.\n\n` +
      `**KC granularity principle:** ${kcCountGuidance}\n\n` +
      `**Cognitive actions:** Understand / Apply / Analyze / Evaluate / Create. Use separate actions; do not merge Analyze and Evaluate unless truly needed.\n\n` +
      `**Strict output format:**\n\n` +
      `# Learning Blueprint — ${node.name} (v1)\n\n` +
      `## 1. Learning Goals & Task Boundary\n` +
      `- Endpoint performance: ...\n` +
      `- Scope boundary: ...\n` +
      `- Out of scope / later nodes: ...\n` +
      `- Granularity rationale: one concise sentence; explain why this KC split is enough and not repetitive.\n\n` +
      `## 2. Prerequisite Preparation\n` +
      `- Required prerequisites: ...\n` +
      `- Readiness check: ...\n` +
      `- Likely stuck point if missing: ...\n\n` +
      `## 3. Core Knowledge Structure\n\n` +
      `### KC1: [Name]\n` +
      `- Learning role: foundational concept / core concept / procedure / judgment strategy / transfer bridge\n` +
      `- Cognitive action: Understand / Apply / Analyze / Evaluate / Create\n` +
      `- Prerequisites: None\n` +
      `- Core relation: ...\n` +
      `- Representation + minimal example / key counterexample: ...\n` +
      `- Common misconception: ...\n` +
      `- Mastery evidence: ...\n\n` +
      `### KC2: [Name]\n` +
      `- Learning role: ...\n` +
      `- Cognitive action: ...\n` +
      `- Prerequisites: KC1\n` +
      `- Core relation: ...\n` +
      `- Representation + minimal example / key counterexample: ...\n` +
      `- Common misconception: ...\n` +
      `- Mastery evidence: ...\n\n` +
      `...\n\n` +
      `## 4. Learning Flow\n` +
      `- Activate prior knowledge: ...\n` +
      `- Build core concept: ...\n` +
      `- Compare examples and counterexamples: ...\n` +
      `- Worked example: ...\n` +
      `- Guided practice: ...\n` +
      `- Transfer and integration: ...\n` +
      `- Self-check and correction: ...\n\n` +
      `## 5. Evidence & Diagnosis\n` +
      `| KC | Mastery evidence | Common error / misconception | Knowledge gap | Useful practice/review prompt |\n` +
      `| --- | --- | --- | --- | --- |\n` +
      `| KC1 | Observable behavior or answer that proves this KC is mastered | Likely wrong answer or misconception | What the error reveals | Question-generation hint; do not write a full exercise |\n\n` +
      `Prerequisites may reference only KC IDs defined in this blueprint (use "None" if none). Keep each field concise; do not write full explanations.`
    : `你是学习蓝图规划师，为学习节点「${node.name}」（${node.chapter}，${diffLabel(node.difficulty, req.language)}难度）生成精炼 Learning Blueprint / 学习蓝图 v1。\n\n` +
      `**只输出供后续原理资料、实践资料、复盘资料使用的轻结构蓝图，不输出教材正文，不写成长篇讲义。**` +
      scopeSection + adjacentSection + curriculumSection + misconceptionSection + cognitiveGoalNote + motorSkillNote +
      (strictLibraryOutline ? `\n\n**严格参考库模式：** 如果参考库片段不足，请生成更小的蓝图，并在“掌握证据与诊断”中说明资料缺口；不要发明外部 KC。` : '') +
      `\n\n**生成思路（内化，不要写出）：**\n` +
      `① 先从终点表现反推：学完后学生能完成什么任务，而不是只理解什么。\n` +
      `② 识别需要激活的前置，再由你自行决定 KC 数量和粒度，以完成节点任务为准。\n` +
      `③ 对照课程结构参考，覆盖核心话题；同时避开相邻节点已覆盖内容。\n` +
      `④ 每个 KC 只写后续资料真正会用到的字段：学习作用、认知动作、前置依赖、核心关系、表征/最小例/反例、误解、掌握证据。\n` +
      `⑤ 给出轻量学习推进顺序和掌握证据模型；证据模型必须同时包含“学会后的正向表现”和“常见错误暴露的缺口”，让实践/复盘后续能直接调用。\n\n` +
      `**KC 粒度原则：** ${kcCountGuidance}\n\n` +
      `**认知动作：** 理解 / 应用 / 分析 / 评估 / 创造。分析和评估尽量分开，不再强制使用合并标签。\n\n` +
      `**严格输出格式：**\n\n` +
      `# 学习蓝图 — ${node.name}（v1）\n\n` +
      `## 1. 学习目标与任务边界\n` +
      `- 终点能力：...\n` +
      `- 学习边界：...\n` +
      `- 暂不展开 / 留给后续节点：...\n` +
      `- 粒度说明：一句话说明为什么这样拆 KC 足够且不重复。\n\n` +
      `## 2. 前置准备\n` +
      `- 必要前置：...\n` +
      `- 前置自检：...\n` +
      `- 前置不足会卡在：...\n\n` +
      `## 3. 核心知识结构\n\n` +
      `### KC1: [名称]\n` +
      `- 学习作用：基础概念 / 核心概念 / 方法步骤 / 判断策略 / 迁移桥梁\n` +
      `- 认知动作：理解 / 应用 / 分析 / 评估 / 创造\n` +
      `- 前置依赖：无\n` +
      `- 核心关系：...\n` +
      `- 表征与例反例：...\n` +
      `- 常见误解：...\n` +
      `- 掌握证据：...\n\n` +
      `### KC2: [名称]\n` +
      `- 学习作用：...\n` +
      `- 认知动作：...\n` +
      `- 前置依赖：KC1\n` +
      `- 核心关系：...\n` +
      `- 表征与例反例：...\n` +
      `- 常见误解：...\n` +
      `- 掌握证据：...\n\n` +
      `...\n\n` +
      `## 4. 学习推进顺序\n` +
      `- 激活旧知：...\n` +
      `- 建立核心概念：...\n` +
      `- 例子/反例辨析：...\n` +
      `- Worked Example 演示：...\n` +
      `- 引导练习：...\n` +
      `- 迁移整合：...\n` +
      `- 自检纠错：...\n\n` +
      `## 5. 掌握证据与诊断\n` +
      `| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |\n` +
      `| --- | --- | --- | --- | --- |\n` +
      `| KC1 | 能证明该 KC 已掌握的可观察行为或答案 | 可能出现的错误答案或误解 | 该错误暴露的知识缺口 | 题目/复盘问题的生成提示，不要写完整题目 |\n\n` +
      `前置依赖只能引用本蓝图已定义的 KC 编号（无前置写“无”）。每个字段保持精炼，不要写完整教学解释。`;

  const maxTokens = resolveOutputTokenBudget({
    provider: req.provider,
    model: req.model,
    task: 'outline',
  });
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '构建纲要提示词', 'build outline prompt'),
    status: 'done',
    detail: localMsg(req.language, `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；输出上限 ${maxTokens.toLocaleString('en-US')} tokens；KC 数量由节点目标自行决定。`, `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; output cap ${maxTokens.toLocaleString('en-US')} tokens; KC count is chosen from the node goal.`),
    language: req.language,
  }));

  const userPrompt = req.language === 'en'
    ? `Node: ${node.name}, difficulty: ${node.difficulty}, description: ${node.description ?? 'none'}. Please generate the learning blueprint.`
    : `节点：${node.name}，难度：${node.difficulty}，描述：${node.description ?? '无'}。请生成学习蓝图。`;

  const generationStartedAt = Date.now();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '模型生成纲要正文', 'model drafts outline'),
    status: 'start',
    detail: localMsg(req.language, '调用模型输出完整 Markdown 纲要。', 'Calling the model to produce the complete Markdown outline.'),
    language: req.language,
  }));
  const result = await streamStructuredCompletion({
    provider: req.provider,
    model: req.model,
    messages: [{ role: 'user', content: userPrompt }],
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    kind: 'text',
    language: req.language,
    signal: req.signal,
    maxContinuations: 2,
    onProgress: (msg) => req.onProgressChunk(msg),
    onUsage: (usage) => { req.onComplete?.(usage); },
  });

  let outlineContent = result.text.trim();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '模型生成纲要正文', 'model drafts outline'),
    status: 'done',
    durationMs: Date.now() - generationStartedAt,
    detail: localMsg(req.language, `输出约 ${outlineContent.length.toLocaleString('en-US')} 字符；停止原因 ${result.stopReason}；续写 ${result.continuationCount} 次${result.hitContinuationLimit ? '；达到续写上限' : ''}。`, `Output about ${outlineContent.length.toLocaleString('en-US')} chars; stop reason ${result.stopReason}; continuations ${result.continuationCount}${result.hitContinuationLimit ? '; hit continuation limit' : ''}.`),
    language: req.language,
  }));
  if (!outlineContent) {
    throw new Error(message('outlineGenerationFailed', req.language, {
      error: localMsg(req.language, '内容为空', 'empty response'),
    }));
  }

  const validationStartedAt = Date.now();
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '结构校验', 'structure validation'),
    status: 'start',
    detail: localMsg(req.language, '检查蓝图核心章节、KC 字段、前置引用、掌握证据和明显空话；KC 数量只做软提示。', 'Checking blueprint sections, KC fields, prerequisites, mastery evidence, and vague placeholders; KC count is a soft warning only.'),
    language: req.language,
  }));
  let validation = validateOutlineStructure(outlineContent, `${kcRange.min}-${kcRange.max}`, 1);
  if (!validation.passed) {
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '结构校验', 'structure validation'),
      status: 'fail',
      durationMs: Date.now() - validationStartedAt,
      detail: localMsg(req.language, `初稿问题 ${validation.issues.length} 个，触发一次修复生成。`, `${validation.issues.length} draft issue(s); triggering one repair generation.`),
      language: req.language,
    }));
    req.onProgressChunk(localMsg(req.language,
      `- 纲要校验：初稿未通过，正在要求模型修复。\n${formatOutlineValidationIssues(validation)}\n`,
      `- Outline validation: the draft failed validation; asking the model to repair it.\n${formatOutlineValidationIssues(validation)}\n`,
    ));
    const repairStartedAt = Date.now();
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '修复生成', 'repair generation'),
      status: 'start',
      detail: localMsg(req.language, '把校验问题和初稿发回模型，要求输出完整修复版。', 'Sending validation issues and the draft back to the model for a complete repaired version.'),
      language: req.language,
    }));
    const repair = await streamStructuredCompletion({
      provider: req.provider,
      model: req.model,
      messages: [{
        role: 'user',
        content: localMsg(req.language,
          `下面这份纲要未通过结构校验。请输出一份完整修复后的纲要全文，不要解释。\n\n校验问题：\n${formatOutlineValidationIssues(validation)}\n\n原纲要：\n${outlineContent}`,
          `This outline failed structural validation. Output the complete repaired outline only, with no explanation.\n\nValidation issues:\n${formatOutlineValidationIssues(validation)}\n\nOriginal outline:\n${outlineContent}`,
        ),
      }],
      systemPrompt,
      maxTokens,
      temperature: 0.15,
      kind: 'text',
      language: req.language,
      signal: req.signal,
      maxContinuations: 1,
      onProgress: (msg) => req.onProgressChunk(msg),
      onUsage: (usage) => { req.onComplete?.(usage); },
    });
    outlineContent = repair.text.trim();
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '修复生成', 'repair generation'),
      status: 'done',
      durationMs: Date.now() - repairStartedAt,
      detail: localMsg(req.language, `修复版约 ${outlineContent.length.toLocaleString('en-US')} 字符；停止原因 ${repair.stopReason}；续写 ${repair.continuationCount} 次${repair.hitContinuationLimit ? '；达到续写上限' : ''}。`, `Repaired output about ${outlineContent.length.toLocaleString('en-US')} chars; stop reason ${repair.stopReason}; continuations ${repair.continuationCount}${repair.hitContinuationLimit ? '; hit continuation limit' : ''}.`),
      language: req.language,
    }));
    validation = validateOutlineStructure(outlineContent, `${kcRange.min}-${kcRange.max}`, 1);
  } else {
    if (validation.warnings.length > 0) {
      req.onProgressChunk(localMsg(req.language,
        `- 纲要校验提示（不阻断）：\n${formatOutlineValidationWarnings(validation)}\n`,
        `- Outline validation warnings (non-blocking):\n${formatOutlineValidationWarnings(validation)}\n`,
      ));
    }
    req.onProgressChunk(formatOutlineStepTrace({
      step: localMsg(req.language, '结构校验', 'structure validation'),
      status: 'done',
      durationMs: Date.now() - validationStartedAt,
      detail: localMsg(req.language, `初稿通过，无需二次修复生成；格式 ${validation.format}。`, `Draft passed; no repair generation needed; format ${validation.format}.`),
      language: req.language,
    }));
  }

  if (!validation.passed) {
    throw new Error(message('outlineGenerationFailed', req.language, {
      error: formatOutlineValidationIssues(validation),
    }));
  }

  const outlineWritePath = getOutlineV1WritePath(req.courseId, req.nodeId);
  req.onProgressChunk(formatOutlineVerificationTrace({
    targetVersion: 1,
    content: outlineContent,
    kcTargetRange: `${kcRange.min}-${kcRange.max}`,
    filename: path.basename(outlineWritePath),
    language: req.language,
  }));
  const persistStartedAt = Date.now();
  writeOutlineAtomically(outlineWritePath, outlineContent);
  req.onProgressChunk(formatOutlineStepTrace({
    step: localMsg(req.language, '写入纲要文件', 'persist outline file'),
    status: 'done',
    durationMs: Date.now() - persistStartedAt,
    detail: localMsg(req.language, `保存到 ${path.basename(outlineWritePath)}；总耗时 ${((Date.now() - outlineStartedAt) / 1000).toFixed(1)} 秒。`, `Saved as ${path.basename(outlineWritePath)}; total ${((Date.now() - outlineStartedAt) / 1000).toFixed(1)}s.`),
    language: req.language,
  }));
  req.onProgressChunk(behavior.startsMaterialAfter
    ? message('outlineReadyStartingMaterial', req.language)
    : message('outlineVersionGeneratedProgress', req.language, { version: 1 }));
}

// ── Request / result types ────────────────────────────────────────────────────

export interface MaterialGenerationRequest {
  sessionId: string;
  courseId:  string;
  nodeId:    string;
  provider:  LLMProvider;
  model:     string;
  targetFolder: GenerateFolder;
  userMessage:  string;
  signal?:      AbortSignal;
  /** UI language — used to instruct AI to respond in the correct language */
  language?: string;
  searchMode?: SearchMode;
  /** Specific outline version requested by the user. Omit/latest means artifact-default blueprint routing. */
  outlineVersion?: OutlineVersionSelection;
  onChunk:          (chunk: string) => void;
  /** Progress messages (tool status, compression notices) — not saved to chat history */
  onProgressChunk:  (chunk: string) => void;
  onComplete:       (usage: TokenUsage) => void;
  onError:          (errorMsg: string) => void;
  onFileGenerated:  (payload: FileGeneratedPayload) => void;
  lifecycle?:       WorkflowLifecycle;
}

interface PreparedMaterialContext {
  node: DagNode;
  outlineText: string;
  outlinePath: string | null;
  outlineVersion: string;
  kcSourceText: string;
  kcSourceVersion?: OutlineVersionSelection;
  saveOutlineVersion?: OutlineVersionSelection;
  targetFolder: GenerateFolder;
  isPractice: boolean;
  searchMode: SearchMode;
}

interface MaterialSourceBundle {
  sourceText: string;
  practiceSourceBriefText: string;
  videoText: string;
  evidencePack: EvidencePack;
  controlledSearchReason?: string;
  practiceSourceCount: number;
  videoCount: number;
}

interface MaterialLoopSetup {
  messages: ToolTurnMessage[];
  systemPrompt: string;
}

interface MaterialSaveState {
  practiceAnswerSaved: boolean;
}

type SaveHandlingResult = 'none' | 'continue' | 'complete';

function sourceKindCounts(pack: EvidencePack): { library: number; web: number } {
  return {
    library: pack.sources.filter((source) => source.kind === 'upload' || source.kind === 'generated').length,
    web: pack.sources.filter((source) => source.kind === 'web').length,
  };
}

function hasTheoryControlledSearchGap(pack: EvidencePack, searchMode: SearchMode): boolean {
  if (searchMode !== 'auto' && searchMode !== 'web') return false;
  const counts = sourceKindCounts(pack);
  const missing = new Set(pack.coverage.missing.map((item) => item.toLowerCase()));
  return counts.web === 0
    && (missing.has('example') || missing.has('application') || missing.has('exercise_pattern'));
}

function mergeEvidencePacks(base: EvidencePack, extra: EvidencePack): EvidencePack {
  const sources = new Map(base.sources.map((source) => [source.id, source]));
  for (const source of extra.sources) sources.set(source.id, source);
  const chunks = new Map<string, EvidencePack['chunks'][number]>();
  for (const chunk of [...base.chunks, ...extra.chunks]) {
    const key = chunk.chunkId ?? `${chunk.sourceId}:${chunk.text.slice(0, 80)}`;
    if (!chunks.has(key)) chunks.set(key, chunk);
  }
  return {
    ...base,
    sources: [...sources.values()],
    chunks: [...chunks.values()],
    coverage: {
      required: [...new Set([...base.coverage.required, ...extra.coverage.required])],
      covered: [...new Set([...base.coverage.covered, ...extra.coverage.covered])],
      missing: extra.coverage.missing.length < base.coverage.missing.length ? extra.coverage.missing : base.coverage.missing,
    },
    budgetUsed: {
      queries: base.budgetUsed.queries + extra.budgetUsed.queries,
      pagesFetched: base.budgetUsed.pagesFetched + extra.budgetUsed.pagesFetched,
      reflectionSearches: base.budgetUsed.reflectionSearches + extra.budgetUsed.reflectionSearches,
      llmReranks: base.budgetUsed.llmReranks + extra.budgetUsed.llmReranks,
    },
    warnings: [...base.warnings, ...extra.warnings],
  };
}

// ── Concurrency lock ──────────────────────────────────────────────────────────
// Prevents two material generation loops from running for the same node+folder at
// the same time (e.g. two chat-triggered material generation requests firing).

const activeRuns = new Set<string>();

async function ensureOutlineBundle(req: MaterialGenerationRequest, node: DagNode): Promise<boolean> {
  const bundleStatus = getOutlineBundleStatus(req.courseId, req.nodeId);
  if (bundleStatus.complete) {
    return true;
  }

  try {
    const earliestRefresh = Math.min(...bundleStatus.missingVersions, ...bundleStatus.staleVersions);
    if (Number.isFinite(earliestRefresh)) {
      removeOutlineVersionsFrom(req.courseId, req.nodeId, earliestRefresh as 1 | 2 | 3);
    }
    const refreshedStatus = getOutlineBundleStatus(req.courseId, req.nodeId);
    if (refreshedStatus.latestVersion === 0) {
      await generateOutline(req, node, { startsMaterialAfter: true });
    }
    while (getOutlineVersionNumberSafe(req.courseId, req.nodeId) < MAX_OUTLINE_VERSION) {
      await generateNextOutlineVersion(req, node);
    }
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failWorkflow(req, error);
    req.onError(message('outlineGenerationFailed', req.language, { error }));
    return false;
  }
}

async function ensureOutline(req: MaterialGenerationRequest, node: DagNode): Promise<boolean> {
  if (!req.outlineVersion || req.outlineVersion === 'latest') {
    return ensureOutlineBundle(req, node);
  }

  let selected = readSelectedOutlineText(req.courseId, req.nodeId, req.outlineVersion);
  if (selected.text.trim()) return true;

  req.onProgressChunk(localMsg(req.language,
    `- 资料生成前置：未找到用户指定的 ${req.outlineVersion} 蓝图，先自动补齐 v1-v3 三层基础蓝图。\n`,
    `- Material prerequisite: requested ${req.outlineVersion} blueprint was not found, so generating the v1-v3 foundation blueprints first.\n`,
  ));
  const ensured = await ensureOutlineBundle(req, node);
  if (!ensured) return false;

  selected = readSelectedOutlineText(req.courseId, req.nodeId, req.outlineVersion);
  if (selected.text.trim()) return true;

  const error = localMsg(req.language,
    `三层基础蓝图生成后仍找不到用户指定的 ${req.outlineVersion}，请检查纲要文件夹。`,
    `The requested ${req.outlineVersion} blueprint is still missing after generating the foundation blueprints. Please check the Outline folder.`,
  );
  failWorkflow(req, error);
  req.onError(error);
  return false;
}

function getOutlineVersionNumberSafe(courseId: string, nodeId: string): number {
  const latest = getLatestOutlinePath(courseId, nodeId);
  if (!latest) return 0;
  const match = latest.match(/_outline_v([1-3])\.md$/);
  if (match) return Number(match[1]);
  return 0;
}

function notifyCoverageUpgradeOpportunity(req: MaterialGenerationRequest, kcStatus = checkKcCoverage(req.courseId, req.nodeId)): void {
  try {
    if (!kcStatus.isFullyCovered || kcStatus.version <= 0) return;

    req.onProgressChunk(localMsg(req.language,
      `💡 三层基础蓝图已齐全。若想继续深入某个 KC、误解、题型或应用场景，可以手动生成专题分支。\n`,
      `💡 The three foundation blueprints are ready. To go deeper into a KC, misconception, exercise type, or scenario, generate a topic branch manually.\n`,
    ));
  } catch { /* non-fatal */ }
}

async function prepareMaterialContext(req: MaterialGenerationRequest): Promise<PreparedMaterialContext | null> {
  const node = nodeRepo.findById(req.nodeId);
  if (!node) {
    failWorkflow(req, `Node not found: ${req.nodeId}`);
    req.onError(message('nodeNotFound', req.language, { nodeId: req.nodeId }));
    return null;
  }

  startWorkflowPhase(req, 'prepare_context');
  const artifactKind = req.targetFolder === 'practice' || req.targetFolder === 'answer'
    ? 'practice'
    : req.targetFolder === 'theory'
      ? 'theory'
      : 'review';
  const normalizedOutlineVersion = normalizeOutlineVersionForArtifact({
    artifactKind,
    outlineVersion: req.outlineVersion,
    userMessage: req.userMessage,
  });
  if (req.outlineVersion && req.outlineVersion !== 'latest' && normalizedOutlineVersion !== req.outlineVersion) {
    req.onProgressChunk(localMsg(req.language,
      `- 蓝图选择：忽略模型传入的 ${req.outlineVersion}；用户未明确指定该版本，本次按资料类型选择默认蓝图。\n`,
      `- Blueprint routing: ignored model-supplied ${req.outlineVersion}; the user did not explicitly request that version, so this artifact uses its default blueprint routing.\n`,
    ));
  }
  const effectiveReq = normalizedOutlineVersion === req.outlineVersion
    ? req
    : { ...req, outlineVersion: normalizedOutlineVersion };
  const outlineReady = await ensureOutline(effectiveReq, node);
  if (!outlineReady) return null;

  const selectedOutline = buildMaterialOutlineContext(effectiveReq);
  const outlineText = selectedOutline.text;
  const outlinePath = selectedOutline.path;
  const kcs = parseKcsFromOutline(selectedOutline.kcSourceText);
  const selectedOutlineVersionNumber = selectedOutline.kcSourceVersion
    ? Number(selectedOutline.kcSourceVersion.replace(/^v/, '')) || undefined
    : undefined;
  const kcStatus = checkKcCoverage(req.courseId, req.nodeId, {
    outlineText: selectedOutline.kcSourceText,
    version: selectedOutlineVersionNumber,
  });
  req.onProgressChunk(formatMaterialContextTrace({
    node,
    targetFolder: req.targetFolder,
    provider: req.provider,
    model: req.model,
    searchMode: req.searchMode ?? 'auto',
    userMessage: req.userMessage,
    outlineVersion: selectedOutline.version,
    kcNames: kcs.map((kc) => `${kc.id} ${kc.name}`),
    indexEntryCount: kcStatus.coveredKcIds.length,
    prerequisiteNames: buildPrereqNames(req, node),
    language: req.language,
  }));
  completeWorkflowPhase(req, 'prepare_context');
  notifyCoverageUpgradeOpportunity(req, kcStatus);

  return {
    node,
    outlineText,
    outlinePath,
    outlineVersion: selectedOutline.version,
    kcSourceText: selectedOutline.kcSourceText,
    kcSourceVersion: selectedOutline.kcSourceVersion,
    saveOutlineVersion: selectedOutline.saveOutlineVersion,
    targetFolder: req.targetFolder,
    isPractice: req.targetFolder === 'practice' || req.targetFolder === 'answer',
    searchMode: req.searchMode ?? 'auto',
  };
}

async function retrieveMaterialSources(
  req: MaterialGenerationRequest,
  node: DagNode,
  isPractice: boolean,
  searchMode: SearchMode,
): Promise<MaterialSourceBundle> {
  req.onProgressChunk(message('authoritativeSourcesRetrieving', req.language));
  startWorkflowPhase(req, 'retrieve_sources');
  const domain = detectDomain(node.name, node.description);
  const canUseWeb = searchMode === 'auto' || searchMode === 'web';

  const [initialEvidencePack, videoResults] = await Promise.all([
    collectEvidencePack({
      query: `${node.name} ${node.description ?? ''}`.trim(),
      courseId: req.courseId,
      nodeId: req.nodeId,
      mode: searchMode,
      taskType: isPractice ? 'practice' : req.targetFolder === 'theory' ? 'theory' : 'chat',
      maxWebResults: isPractice ? 3 : 5,
      language: req.language,
      provider: req.provider as string,
      model: req.model,
      signal: req.signal,
      onProgress: (msg) => req.onProgressChunk(msg),
      onUsage: req.onComplete,
    }),
    req.targetFolder === 'theory' && canUseWeb
      ? youtubeSearch(node.name, { keywords: ['教程', '讲解'], maxResults: 3 }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const practiceBrief = isPractice
    ? await buildPracticeSourceBrief(node.name, domain, {
        signal:       req.signal,
        learningType: node.learning_type,
        bloomTarget:  node.bloom_target,
        evidencePack: initialEvidencePack,
        courseId:     req.courseId,
        nodeId:       req.nodeId,
        searchMode,
        language:     req.language,
        provider:     req.provider as string,
        model:        req.model,
        onProgress:   (msg) => req.onProgressChunk(msg),
        onUsage:      req.onComplete,
      }).catch((err) => {
        req.onProgressChunk(localMsg(req.language,
          `检索阶段：实践题源简报构建失败，已降级为仅使用本轮参考片段（${err instanceof Error ? err.message : String(err)}）。\n`,
          `Retrieval: practice source brief failed, falling back to this run's evidence snippets only (${err instanceof Error ? err.message : String(err)}).\n`,
        ));
        return null;
      })
    : null;
  let evidencePack = initialEvidencePack;
  let controlledSearchReason: string | undefined;
  if (!isPractice && hasTheoryControlledSearchGap(initialEvidencePack, searchMode)) {
    controlledSearchReason = localMsg(req.language,
      '原理资料缺少示例/应用支撑，系统执行一次受控补搜；生成模型不会再自由调用 web_search。',
      'Theory material lacks example/application support, so the system runs one controlled follow-up search; the generator will not freely call web_search.',
    );
    req.onProgressChunk(`检索阶段：${controlledSearchReason}\n`);
    const supplementalPack = await collectEvidencePack({
      query: `${node.name} 例题 应用 worked example application`.trim(),
      courseId: req.courseId,
      nodeId: req.nodeId,
      mode: 'web',
      taskType: 'theory',
      maxWebResults: 2,
      language: req.language,
      provider: req.provider as string,
      model: req.model,
      signal: req.signal,
      onProgress: (msg) => req.onProgressChunk(msg),
      onUsage: req.onComplete,
    });
    evidencePack = mergeEvidencePacks(initialEvidencePack, supplementalPack);
  }
  req.onProgressChunk(summarizeEvidencePack(evidencePack, req.language));
  req.onProgressChunk(formatMaterialSourceTrace({
    query: `${node.name} ${node.description ?? ''}`.trim(),
    searchMode,
    isPractice,
    evidencePack,
    practiceSourceCount: (practiceBrief?.sources.length ?? 0) + (practiceBrief?.exercises.length ?? 0),
    videoCount: videoResults.length,
    language: req.language,
  }));
  completeWorkflowPhase(req, 'retrieve_sources');

  const evidenceText = formatEvidencePack(evidencePack, req.language);
  const sourceText = evidencePack.sources.length > 0 || evidencePack.chunks.length > 0
    ? evidenceText
    : practiceBrief?.sources.length
      ? practiceBrief.sources
          .map((s, index) => `### [Practice Source ${index + 1}] ${s.title}\n${req.language === 'en' ? 'Source' : '来源'}：${s.url}\n${s.snippet.slice(0, 700)}`)
          .join('\n\n')
      : '';

  if (searchMode === 'library' && !sourceText.trim()) {
    req.onProgressChunk(localMsg(req.language,
      '⚠️ 当前为严格参考库模式，但没有检索到可用参考库片段；本次生成应说明资料不足，不应凭空补写。\n',
      '⚠️ Strict library mode is active, but no usable source-library snippets were found; generation should state insufficient sources instead of inventing content.\n',
    ));
  }

  return {
    sourceText,
    practiceSourceBriefText: practiceBrief ? formatPracticeSourceBrief(practiceBrief, req.language) : '',
    videoText: videoResults.length > 0
      ? videoResults.map((v) => `- [${v.title}](${v.url}) — ${v.channelTitle}`).join('\n')
      : '',
    evidencePack,
    controlledSearchReason,
    practiceSourceCount: (practiceBrief?.sources.length ?? 0) + (practiceBrief?.exercises.length ?? 0),
    videoCount: videoResults.length,
  };
}

function buildPrereqNames(req: MaterialGenerationRequest, node: DagNode): string {
  const allNodes = nodeRepo.findByCourse(req.courseId);
  return (node.prerequisites ?? [])
    .map((pid) => allNodes.find((n) => n.id === pid)?.name ?? pid)
    .join(req.language === 'en' ? ', ' : '、');
}

function buildMotorSkillPracticeNote(node: DagNode, isPractice: boolean): string {
  return isPractice && node.learning_type === 'motor_skill'
    ? '\n\n**动作技能节点（motor_skill）实践题格式要求：**\n' +
      '第三层（应用）题目必须以"操作任务"格式为主（占应用层 70% 以上），不得以选择题或填空题替代：\n' +
      '- 描述学员需要完成的具体操作动作（而非"选出正确步骤"）\n' +
      '- 给出操作正确的自检标准（"完成后应看到 / 感受到什么"）\n' +
      '- 标注常见操作错误和注意事项\n' +
      '选择题和简答题只出现在第一层（记忆/理解）和第二层（分析/评估），应用层不出选择题。'
    : '';
}

function buildGuideSection(req: MaterialGenerationRequest): string {
  const folderGuide = getMaterialWorkflowPrompt(req.targetFolder, req.language);
  const defaultPrefixes = getGenerationDefaultPrefixes();
  const trimmed = req.userMessage?.trim() ?? '';
  const hasCustom = !!trimmed && !defaultPrefixes.some((prefix) => trimmed.startsWith(prefix));

  if (hasCustom) {
    return req.language === 'en'
      ? `**Custom user requirements (highest priority):**\n${req.userMessage}\n\n**Reference format (follow unless it conflicts with the above):**\n${folderGuide}`
      : `**用户自定义要求（优先级最高，格式要求以此为准）：**\n${req.userMessage}\n\n**参考格式（在不违背用户要求的前提下参考）：**\n${folderGuide}`;
  }

  return req.language === 'en'
    ? `User request: ${req.userMessage}\n\n${folderGuide}`
    : `用户要求：${req.userMessage}\n\n${folderGuide}`;
}

function strictLibraryMaterialInstruction(language?: string): string {
  return localMsg(language,
    `\n\n**严格参考库模式要求（优先级高）：**\n` +
    `- 本次资料生成只能依据上方参考库来源、节点纲要和当前节点信息。\n` +
    `- 不要联网，不要使用 YouTube/网页题源，不要用通用教材知识补写参考库未覆盖的大段内容。\n` +
    `- 如果参考库片段不足以支撑完整资料，请直接说明“参考库资料不足”，并列出缺少哪些页/章节/知识点，而不是自行补齐。\n` +
    `- 可以做解释、整理和改写，但所有核心概念、步骤、例题风格和练习范围都必须能回到参考库片段。`,
    `\n\n**Strict library mode requirements (high priority):**\n` +
    `- Generate only from the source-library references above, the node outline, and the current node context.\n` +
    `- Do not use web, YouTube, external exercise sources, or generic textbook knowledge to fill material not covered by the library.\n` +
    `- If the source-library snippets are insufficient for a complete artifact, state that the library sources are insufficient and list the missing pages/chapters/topics instead of inventing them.\n` +
    `- You may explain, organize, and rewrite, but core concepts, steps, example patterns, and practice scope must trace back to the library snippets.`,
  );
}

function strictLibraryMaterialSystemLayer(searchMode: SearchMode, hasSources: boolean, language?: string) {
  return () => searchMode === 'library'
    ? localMsg(language,
        `# 严格参考库模式\n本轮只允许使用参考库资料生成。${hasSources ? '参考库片段已提供；请严格围绕这些片段。' : '未提供可用参考库片段；请说明资料不足，不要凭空生成。'}`,
        `# Strict Library Mode\nThis turn may only use source-library material. ${hasSources ? 'Source-library snippets are provided; stay strictly within them.' : 'No usable source-library snippets are provided; state insufficient sources instead of inventing content.'}`,
      )
    : '';
}

async function buildMaterialLoopSetup(
  req: MaterialGenerationRequest,
  prepared: PreparedMaterialContext,
  sources: MaterialSourceBundle,
): Promise<MaterialLoopSetup> {
  const indexText = prepared.isPractice || req.targetFolder === 'theory'
    ? readIndexMd(req.courseId, req.nodeId, req.targetFolder)
    : '';
  const materialContext = buildMaterialGenerationContext({
    node: prepared.node,
    prereqNames: buildPrereqNames(req, prepared.node),
    targetFolder: req.targetFolder,
    outlineText: prepared.outlineText,
    indexText,
    guideSection: buildGuideSection(req)
      + buildPracticeHistoryGuide(req, indexText)
      + (prepared.searchMode === 'library' ? strictLibraryMaterialInstruction(req.language) : ''),
    motorSkillPracticeNote: buildMotorSkillPracticeNote(prepared.node, prepared.isPractice),
    sourceText: sources.sourceText,
    practiceSourceBrief: sources.practiceSourceBriefText,
    videoText: sources.videoText,
    language: req.language,
  });

  return {
    messages: buildMaterialToolMessages(materialContext.content),
    systemPrompt: await buildSystemPrompt(
      roleLayer('subtutor', req.language),
      languageLayer(req.language),
      sourcesLayer(sources.sourceText, req.language),
      strictLibraryMaterialSystemLayer(prepared.searchMode, Boolean(sources.sourceText.trim()), req.language),
    ),
  };
}

function createMaterialToolContext(
  req: MaterialGenerationRequest,
  searchMode: SearchMode,
  outlineVersion: OutlineVersionSelection | undefined,
  accUsage: TokenUsage,
  markFileSaved: () => void,
): ToolContext {
  return {
    sessionId: req.sessionId,
    courseId:  req.courseId,
    nodeId:    req.nodeId,
    provider:  req.provider,
    model:     req.model,
    signal:    req.signal,
    language:  req.language,
    searchMode,
    outlineVersion,
    onProgress: (msg) => req.onProgressChunk(msg + '\n'),
    onFileGenerated: (payload) => {
      markFileSaved();
      completeWorkflowPhase(req, 'persist_artifacts', [payload.filePath]);
      startWorkflowPhase(req, 'emit_result');
      req.onFileGenerated({ ...payload, usage: { ...accUsage } });
      completeWorkflowPhase(req, 'emit_result', [payload.filePath]);
    },
  };
}

function emitSavedFileOverview(
  req: MaterialGenerationRequest,
  folderName: GenerateFolder,
  filename: string,
  content: string,
): void {
  const folderLabel = getArtifactDisplayName(folderName, req.language);
  const headings = content
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .slice(0, 5)
    .map((line) => line.replace(/^#{1,3}\s+/, '').trim())
    .join('、');
  const overview =
    message('fileSavedOverview', req.language, { folder: folderLabel, filename }) +
    (headings ? message('fileSavedOverviewCovers', req.language, { headings }) : '');
  req.onChunk(overview + '\n');
}

function buildAnswerRepairPrompt(
  req: MaterialGenerationRequest,
  answerVerification: ReturnType<typeof verifyPracticeHasAnswer>,
  answerFilename: string,
): string {
  return req.language === 'en'
    ? `${formatVerificationIssues(answerVerification, req.language)}\n\nExercise file saved. Now call save_file (folderName: "answer") to save the corresponding answer key.` +
      (answerFilename ? ` Filename: ${answerFilename}` : '') +
      `\nStart the file with: > ⚠️ AI-generated answer key — for reference only, please verify before use.` +
      `\nFor each question Q1/Q2…: reasoning → full answer → common mistakes; coding questions include test cases; Tier 4 creative questions provide evaluation rubrics.`
    : `${formatVerificationIssues(answerVerification, req.language)}\n\n题目文件已保存。现在请调用 save_file（folderName: "answer"）保存对应的参考答案文件。` +
      (answerFilename ? `文件名：${answerFilename}` : '') +
      `\n文件顶部加声明：> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。` +
      `\n按 Q1/Q2… 逐题给出：解题思路 → 完整答案 → 常见错误提示；编程题加测试用例；创造层题给评分维度。`;
}

function buildUnsavedDraftSavePrompt(req: MaterialGenerationRequest, draftChars: number): string {
  const folderLabel = getArtifactDisplayName(req.targetFolder, req.language);
  if (req.targetFolder === 'practice') {
    return localMsg(
      req.language,
      `内部保存校验：上一条助手消息已经生成了约 ${draftChars.toLocaleString('en-US')} 字符的实践资料草稿，但没有调用 save_file，所以内容还没有落盘。不要重新检索、不要重写一份新资料、不要总结；请立刻调用 save_file，把上一条助手消息中的题目正文原样作为 content 保存到 folderName: "practice"。如果上一条草稿里已经包含参考答案，请随后再调用一次 save_file 保存 folderName: "answer"；如果没有参考答案，请按题目生成对应答案并保存。filename 只填简短描述词。`,
      `Internal save check: the previous assistant message already produced a practice-material draft of about ${draftChars.toLocaleString('en-US')} characters, but save_file was not called, so it has not been persisted. Do not search again, do not rewrite a new artifact, and do not summarize; call save_file now and use the previous assistant message's exercise body as content with folderName: "practice". If that draft already contains an answer key, then call save_file again with folderName: "answer"; otherwise generate the matching answer key and save it. Use only a short descriptor as filename.`,
    );
  }
  return localMsg(
    req.language,
    `内部保存校验：上一条助手消息已经生成了约 ${draftChars.toLocaleString('en-US')} 字符的${folderLabel}正文草稿，但没有调用 save_file，所以内容还没有保存。不要重新检索、不要重写一份新资料、不要总结；请立刻调用 save_file，把上一条助手消息中的完整正文原样作为 content，folderName: "${req.targetFolder}"。filename 只填简短描述词。`,
    `Internal save check: the previous assistant message already produced a ${folderLabel} draft of about ${draftChars.toLocaleString('en-US')} characters, but save_file was not called, so it has not been saved. Do not search again, do not rewrite a new artifact, and do not summarize; call save_file now and use the complete previous assistant message as content with folderName: "${req.targetFolder}". Use only a short descriptor as filename.`,
  );
}

function handleSaveToolResults(
  req: MaterialGenerationRequest,
  prepared: PreparedMaterialContext,
  messages: ToolTurnMessage[],
  toolCalls: ToolCallBlock[],
  toolResults: ToolResultBlock[],
  state: MaterialSaveState,
): SaveHandlingResult {
  const toolResultById = new Map(toolResults.map((result) => [result.toolCallId, result]));
  const failedPracticeSaveCalls = toolCalls.filter((tc) =>
    tc.name === 'save_file' &&
    toolResultById.get(tc.id)?.isError &&
    (tc.input as { folderName?: string }).folderName === 'practice',
  );
  if (req.targetFolder === 'practice' && failedPracticeSaveCalls.length > 0) {
    req.onProgressChunk(message('practiceVerifierRepairTriggered', req.language));
    req.onProgressChunk(formatMaterialVerificationTrace(
      localMsg(req.language, '实践资料结构未通过确定性校验，要求模型按 save_file 返回的问题修复后重存。', 'Practice artifact failed deterministic verification; asking the model to repair according to save_file feedback and save again.'),
      req.language,
    ));
    messages.push({
      role:    'user',
      content: req.language === 'en'
        ? 'The practice material failed deterministic verification. Repair the issues reported by the save_file tool, then call save_file again with folderName: "practice". Do not save the answer key until the practice file saves successfully.'
        : '实践资料未通过确定性校验。请根据 save_file 工具返回的问题修复内容，然后重新调用 save_file（folderName: "practice"）。题目文件成功保存前，不要保存参考答案。',
    });
    return 'continue';
  }

  const saveCalls = toolCalls.filter((tc) =>
    tc.name === 'save_file' && !toolResultById.get(tc.id)?.isError,
  );
  if (saveCalls.length === 0) return 'none';

  let practiceFilename = '';
  for (const saveCall of saveCalls) {
    const savedContent    = (saveCall.input as { content?: string }).content ?? '';
    const savedFilename   = (saveCall.input as { filename?: string }).filename ?? '';
    const savedFolderName = (saveCall.input as { folderName?: string }).folderName ?? '';
    const savedFolderKey = isGenerateFolder(savedFolderName) ? savedFolderName : undefined;

    if (savedFilename && (savedFolderKey === 'theory' || savedFolderKey === 'practice' || savedFolderKey === 'answer')) {
      appendToIndexMd(
        req.courseId,
        req.nodeId,
        savedFolderKey,
        savedFilename,
        savedContent,
        req.language,
        prepared.kcSourceText,
        prepared.saveOutlineVersion ?? prepared.kcSourceVersion,
      );
    }
    if (savedFolderKey === 'answer') state.practiceAnswerSaved = true;
    if (savedFolderKey === 'practice' && savedFilename) practiceFilename = savedFilename;
    if (savedFilename && savedFolderKey) {
      req.onProgressChunk(formatMaterialSaveTrace({
        folderName: savedFolderKey,
        filename: savedFilename,
        content: savedContent,
        language: req.language,
      }));
      emitSavedFileOverview(req, savedFolderKey, savedFilename, savedContent);
    }
  }

  const answerVerification = verifyPracticeHasAnswer(state.practiceAnswerSaved);
  if (req.targetFolder === 'practice' && !answerVerification.passed) {
    const answerFilename = getPairedAnswerFilename(practiceFilename, req.language);
    req.onProgressChunk(message('practiceAnswerMissingRepairTriggered', req.language));
    req.onProgressChunk(formatMaterialVerificationTrace(
      localMsg(req.language, '题目已保存，但还没有参考答案文件，已追加补生成答案的指令。', 'Practice file is saved, but the answer key is missing; appended an instruction to generate it.'),
      req.language,
    ));
    messages.push({
      role: 'user',
      content: buildAnswerRepairPrompt(req, answerVerification, answerFilename),
    });
    req.onProgressChunk(message('answerGenerating', req.language));
    return 'continue';
  }

  return 'complete';
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * Run the agentic material generation loop using the provider-neutral LLMAdapter.
 * Returns true if a file was successfully saved, false otherwise.
 */
export async function runMaterialGenerationLoop(req: MaterialGenerationRequest): Promise<boolean> {
  const lockKey = `${req.nodeId}:${req.targetFolder}`;
  if (activeRuns.has(lockKey)) {
    log.warn('Duplicate material generation request skipped', { nodeId: req.nodeId, folder: req.targetFolder });
    return false;
  }
  activeRuns.add(lockKey);
  try {
  const workflowStartedAt = Date.now();
  const materialKind = getArtifactDisplayName(req.targetFolder, req.language);

  const prepareStartedAt = Date.now();
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '准备上下文', 'prepare context'),
    status: 'start',
    detail: localMsg(req.language, '读取节点、纲要、KC 覆盖和前置节点。', 'Reading node, outline, KC coverage, and prerequisites.'),
    language: req.language,
  }));
  const prepared = await prepareMaterialContext(req);
  if (!prepared) {
    req.onProgressChunk(formatGenerationStepTrace({
      kind: materialKind,
      step: localMsg(req.language, '准备上下文', 'prepare context'),
      status: 'fail',
      durationMs: Date.now() - prepareStartedAt,
      detail: localMsg(req.language, '上下文准备失败，生成终止。', 'Context preparation failed; generation stopped.'),
      language: req.language,
    }));
    return false;
  }
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '准备上下文', 'prepare context'),
    status: 'done',
    durationMs: Date.now() - prepareStartedAt,
    detail: localMsg(req.language, `使用纲要 ${prepared.outlineVersion}；正文纲要约 ${prepared.outlineText.length.toLocaleString('en-US')} 字符。`, `Using outline ${prepared.outlineVersion}; outline body about ${prepared.outlineText.length.toLocaleString('en-US')} chars.`),
    language: req.language,
  }));

  const retrieveStartedAt = Date.now();
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '检索资料来源', 'retrieve sources'),
    status: 'start',
    detail: localMsg(req.language, `搜索模式 ${prepared.searchMode}；收集参考库、网页、题源或视频。`, `Search mode ${prepared.searchMode}; collecting library, web, practice-source, or video references.`),
    language: req.language,
  }));
  const sources = await retrieveMaterialSources(req, prepared.node, prepared.isPractice, prepared.searchMode);
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '检索资料来源', 'retrieve sources'),
    status: 'done',
    durationMs: Date.now() - retrieveStartedAt,
    detail: localMsg(req.language, `来源正文约 ${sources.sourceText.length.toLocaleString('en-US')} 字符；实践题源 ${sources.practiceSourceBriefText ? '有' : '无'}；视频 ${sources.videoText ? '有' : '无'}。`, `Source text about ${sources.sourceText.length.toLocaleString('en-US')} chars; practice sources ${sources.practiceSourceBriefText ? 'yes' : 'no'}; videos ${sources.videoText ? 'yes' : 'no'}.`),
    language: req.language,
  }));

  const setupStartedAt = Date.now();
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '构建生成上下文', 'build generation context'),
    status: 'start',
    detail: localMsg(req.language, '组合系统提示词、来源包、工具策略和初始消息。', 'Composing the system prompt, source pack, tool policy, and initial messages.'),
    language: req.language,
  }));
  const setup = await buildMaterialLoopSetup(req, prepared, sources);
  let { messages } = setup;
  const { systemPrompt } = setup;
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '构建生成上下文', 'build generation context'),
    status: 'done',
    durationMs: Date.now() - setupStartedAt,
    detail: localMsg(req.language, `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；初始消息 ${messages.length} 条。`, `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; ${messages.length} initial message(s).`),
    language: req.language,
  }));

  // Accumulate token usage across all turns
  const accUsage = createEmptyUsage();
  let fileSaved = false;

  const windowBudget = resolveContextWindowBudget({
    provider: req.provider,
    model: req.model,
    taskKind: 'material',
  });
  const maxOutputTokens = resolveOutputTokenBudget({
    provider: req.provider,
    model: req.model,
    task: materialOutputTask(req.targetFolder),
  });
  // Token budget: model-aware cumulative usage; triggers history compression at 85%/90%
  const budget = createBudget(windowBudget.inputBudget);
  const compactMessages = async (currentMessages: ToolTurnMessage[]): Promise<ToolTurnMessage[]> => {
    const beforeMessages = currentMessages.length;
    const collapse = budget.shouldCollapse();
    const { messages: compacted, applied } = await compactByDecision(currentMessages, {
      compress: budget.shouldCompress(),
      collapse,
      provider: req.provider,
      model: req.model,
      signal: req.signal,
      language: req.language,
      onProgress: (msg) => req.onProgressChunk(msg),
      onUsage: (usage) => req.onComplete(usage),
      preserveFirstMessage: true,
    });
    // Reset the cumulative budget after a semantic collapse so it doesn't re-trigger immediately.
    if (applied === 'collapse') budget.reset();
    if (compacted.length !== beforeMessages) {
      req.onProgressChunk(formatMaterialCompactionTrace({
        beforeMessages,
        afterMessages: compacted.length,
        budgetUsed: budget.used,
        budgetLimit: budget.limit,
        language: req.language,
      }));
    }
    return compacted;
  };

  // Tool execution context
  const ctx = createMaterialToolContext(req, prepared.searchMode, prepared.saveOutlineVersion, accUsage, () => {
    fileSaved = true;
  });

  const allowWebSearch = shouldAllowMaterialWebSearch(prepared);
  const allowRagRetrieve = hasGeneratedMarkdownFiles(req.courseId, req.nodeId, req.targetFolder);
  const allowReadNodeMaterials = hasGeneratedMarkdownFiles(req.courseId, req.nodeId, req.targetFolder)
    || (req.targetFolder === 'practice' && hasGeneratedMarkdownFiles(req.courseId, req.nodeId, 'theory'));
  req.onProgressChunk(buildMaterialToolPolicyTrace({
    prepared,
    sources,
    allowWebSearch,
    allowRagRetrieve,
    allowReadNodeMaterials,
    maxTokens: maxOutputTokens,
    language: req.language,
  }));
  const toolRegistry = buildTutorToolRegistry({
    targetFolder: req.targetFolder,
    allowWebSearch,
    allowRagRetrieve,
    allowReadNodeMaterials,
  });
  const loopContext = createMaterialLoopContext(req, accUsage, (usage) => {
    budget.add(usage.inputTokens, usage.outputTokens);
  });

  log.info('资料生成循环开始', { nodeId: req.nodeId, provider: req.provider, model: req.model, folder: req.targetFolder });
  req.onProgressChunk(localMsg(req.language, '\n### 生成与工具循环\n', '\n### Generation and tool loop\n'));

  // Counts how many times we've injected a "please continue" message after max_tokens truncation
  let continuationCount = 0;
  let unsavedDraftRepairCount = 0;
  let networkRetryCount = 0;
  const maxOutputContinuations = prepared.isPractice ? 2 : 1;
  const maxNetworkRetries = prepared.isPractice ? 2 : 1;
  const toolStartedAt = new Map<string, number>();
  const hiddenDraftProgress = createHiddenDraftProgress(req);

  // For practice requests: track whether the answer file has been saved yet
  const saveState: MaterialSaveState = { practiceAnswerSaved: false };

  const loopStartedAt = Date.now();
  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '模型与工具循环', 'model/tool loop'),
    status: 'start',
    detail: localMsg(req.language, `输出上限 ${maxOutputTokens.toLocaleString('en-US')} tokens；context 输入预算 ${windowBudget.inputBudget.toLocaleString('en-US')} tokens。`, `output cap ${maxOutputTokens.toLocaleString('en-US')} tokens; context input budget ${windowBudget.inputBudget.toLocaleString('en-US')} tokens.`),
    language: req.language,
  }));
  await runToolChatLoop({
    provider: req.provider,
    model: req.model,
    systemPrompt,
    messages,
    toolRegistry,
    toolContext: ctx,
    runContext: loopContext,
    maxTurns: MAX_TURNS,
    maxTokens: maxOutputTokens,
    signal: req.signal,
    language: req.language,
    emitTerminalEvent: false,
    onChunk: hiddenDraftProgress, // file content stays in files; progress is summarized without streaming the full artifact
    onTurnStart: () => {
      startWorkflowPhase(req, 'generate_content');
    },
    beforeTurn: async (_turn, currentMessages) => {
      messages = await compactMessages(currentMessages);
      return messages;
    },
    afterLlmResponse: async (turn, response, currentMessages) => {
      req.onProgressChunk(formatMaterialTurnTrace({
        turn,
        stopReason: response.stopReason,
        toolNames: response.toolCalls.map((call) => call.name),
        usage: response.usage,
        messageCount: currentMessages.length,
        budgetUsed: budget.used,
        budgetLimit: budget.limit,
        language: req.language,
      }));
      messages = await compactMessages(currentMessages);
      return messages;
    },
    onMaxTokens: (_turn, _response, currentMessages) => {
      if (continuationCount < maxOutputContinuations) {
        continuationCount++;
        req.onProgressChunk(localMsg(req.language,
          `- 输出上限：本轮触达模型单次输出上限 ${maxOutputTokens.toLocaleString('en-US')} tokens，不是 context window 已满。\n`,
          `- Output cap: this turn hit the model's per-response output cap (${maxOutputTokens.toLocaleString('en-US')} tokens), not the context window limit.\n`,
        ));
        req.onProgressChunk(message('outputContinuation', req.language, { attempt: continuationCount, max: maxOutputContinuations }));
        currentMessages.push({ role: 'user', content: localMsg(req.language, '请继续，从刚才中断的地方接着写，不要重复已有内容。', 'Please continue from where you left off. Do not repeat content already written.') });
        return 'continue';
      }
      req.onProgressChunk(message('outputContinuationLimit', req.language));
      completeWorkflowPhase(req, 'generate_content');
      req.onComplete(accUsage);
      return 'complete';
    },
    onEndTurn: (_turn, response, currentMessages) => {
      const draftText = response.text.trim();
      if (!fileSaved && draftText.length > 500 && unsavedDraftRepairCount < 1) {
        unsavedDraftRepairCount += 1;
        req.onProgressChunk(localMsg(req.language,
          `- 保存校验：模型输出了约 ${draftText.length.toLocaleString('en-US')} 字符正文但未调用 save_file，已要求它直接保存上一条正文，不重新检索。\n`,
          `- Save guard: the model produced about ${draftText.length.toLocaleString('en-US')} chars but did not call save_file; asking it to save the previous draft directly without re-retrieval.\n`,
        ));
        currentMessages.push({ role: 'user', content: buildUnsavedDraftSavePrompt(req, draftText.length) });
        return 'continue';
      }
      completeWorkflowPhase(req, 'generate_content');
      req.onComplete(accUsage);
      return 'complete';
    },
    afterToolResults: (_turn, response, toolResults, currentMessages) => {
      const hasSaveCall = response.toolCalls.some((call) => call.name === 'save_file');
      if (hasSaveCall) startWorkflowPhase(req, 'verify');
      const saveHandling = handleSaveToolResults(req, prepared, currentMessages, response.toolCalls, toolResults, saveState);
      if (hasSaveCall) completeWorkflowPhase(req, 'verify');
      if (saveHandling === 'continue') return 'continue';
      if (saveHandling === 'complete') {
        completeWorkflowPhase(req, 'generate_content');
        req.onComplete(accUsage);
        return 'complete';
      }
      return 'continue';
    },
    onLlmError: async (err, turn, currentMessages) => {
      if (req.signal?.aborted) return 'complete';

      const classified = classifyError(err);

      if (classified.type === 'context_too_long') {
        log.warn('Context too long; compressing before retry', { turn, nodeId: req.nodeId });
        req.onProgressChunk(message('contextTooLongCompressing', req.language));
        const [init, ...rest] = currentMessages;
        currentMessages.splice(0, currentMessages.length, init, ...compressToolHistory(rest, req.language));
        messages = currentMessages;
        return 'continue';
      }

      if (classified.type === 'rate_limit') {
        log.warn('请求频率超限，退避重试', { turn, nodeId: req.nodeId });
        req.onProgressChunk(message('rateLimitRetrying', req.language));
        await exponentialBackoff(turn);
        return 'continue';
      }

      if (classified.type === 'network_error' && networkRetryCount < maxNetworkRetries) {
        networkRetryCount += 1;
        log.warn('模型流式连接中断，准备重试', {
          turn,
          nodeId: req.nodeId,
          attempt: networkRetryCount,
          max: maxNetworkRetries,
        });
        req.onProgressChunk(localMsg(req.language,
          `\n⚠️ 模型流式连接中断，正在重试（第 ${networkRetryCount}/${maxNetworkRetries} 次）。\n`,
          `\n⚠️ Model stream connection dropped, retrying (${networkRetryCount}/${maxNetworkRetries}).\n`,
        ));
        await exponentialBackoff(networkRetryCount);
        return 'continue';
      }

      if (classified.type === 'abort') return 'complete';

      log.error('循环终止', { type: classified.type, error: classified.message, nodeId: req.nodeId });
      failWorkflow(req, classified.message);
      req.onError(classified.message);
      return 'complete';
    },
    onMaxTurns: () => {
      log.warn('超出最大轮次', { maxTurns: MAX_TURNS, nodeId: req.nodeId });
      req.onError(message('maxTurnsExceeded', req.language));
    },
    toolRunOptions: {
      auditContext: {
        sessionId: req.sessionId,
        courseId: req.courseId,
        nodeId: req.nodeId,
        agent: 'sub_tutor',
      },
      onProgress:  (msg) => req.onProgressChunk(msg),
      onToolError: (tool, error) => log.warn('Tool execution failed', { tool, error }),
      onToolStart:    (call) => {
        toolStartedAt.set(call.id, Date.now());
        req.onProgressChunk(formatMaterialToolStartTrace(call, req.language));
      },
      onToolComplete: (call, result) => {
        const started = toolStartedAt.get(call.id);
        req.onProgressChunk(formatMaterialToolResultTrace({
          call,
          result,
          durationMs: started ? Date.now() - started : undefined,
          language: req.language,
        }));
      },
      onToolFailure:  (call, error) => {
        const started = toolStartedAt.get(call.id);
        req.onProgressChunk(formatMaterialToolResultTrace({
          call,
          result: { toolCallId: call.id, content: error, isError: true },
          durationMs: started ? Date.now() - started : undefined,
          language: req.language,
        }));
      },
    },
  });

  req.onProgressChunk(formatGenerationStepTrace({
    kind: materialKind,
    step: localMsg(req.language, '模型与工具循环', 'model/tool loop'),
    status: fileSaved ? 'done' : 'fail',
    durationMs: Date.now() - loopStartedAt,
    detail: localMsg(req.language, `保存结果：${fileSaved ? '已保存' : '未保存'}；总耗时 ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)} 秒。`, `save result: ${fileSaved ? 'saved' : 'not saved'}; total ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)}s.`),
    language: req.language,
  }));

  return fileSaved;

  } finally {
    activeRuns.delete(lockKey);
  }
}
