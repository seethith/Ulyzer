import type {
  DagNode,
  EvidencePack,
  FolderKey,
  GenerateFolder,
  LearningSourcePlan,
  SearchMode,
  SourceRecord,
  TokenUsage,
} from '@shared/types';
import type { ToolCallBlock, ToolResultBlock } from '../../llm/adapter';
import { getArtifactDisplayName } from '../../agent-i18n/artifact-names';
import { getDifficultyLabel, localMsg } from '../../agent-i18n/messages';

const MAX_LINE_CHARS = 180;

export interface MaterialContextTraceInput {
  node: DagNode;
  targetFolder: GenerateFolder;
  provider: string;
  model: string;
  searchMode: SearchMode;
  userMessage: string;
  outlineVersion: string;
  kcNames: string[];
  indexEntryCount: number;
  prerequisiteNames: string;
  language?: string;
}

export interface MaterialSourceTraceInput {
  query: string;
  searchMode: SearchMode;
  isPractice: boolean;
  evidencePack: EvidencePack;
  practiceSourceCount?: number;
  videoCount?: number;
  language?: string;
}

export interface MaterialTurnTraceInput {
  turn: number;
  stopReason: string;
  toolNames: string[];
  usage?: TokenUsage;
  messageCount: number;
  budgetUsed: number;
  budgetLimit: number;
  language?: string;
}

export interface MaterialCompactionTraceInput {
  beforeMessages: number;
  afterMessages: number;
  budgetUsed: number;
  budgetLimit: number;
  language?: string;
}

export interface MaterialToolResultTraceInput {
  call: ToolCallBlock;
  result: ToolResultBlock;
  durationMs?: number;
  language?: string;
}

export interface MaterialSaveTraceInput {
  folderName: GenerateFolder;
  filename: string;
  content: string;
  language?: string;
}

export interface OutlineReferenceTrace {
  title: string;
  url: string;
  kind: 'curriculum' | 'misconception';
}

export interface OutlineTraceInput {
  node: DagNode;
  provider: string;
  model: string;
  searchMode?: SearchMode;
  currentVersion: number;
  targetVersion: number;
  kcTargetRange: string;
  nodeScopeCount?: number;
  boundaryNotes?: string;
  adjacentOutlineCount?: number;
  prerequisiteNames?: string;
  learningType?: string | null;
  bloomTarget?: string | null;
  baseOutlineChars?: number;
  coveredKcCount?: number;
  uncoveredKcCount?: number;
  language?: string;
}

export interface OutlineSourceTraceInput {
  references: OutlineReferenceTrace[];
  strictLibraryMode?: boolean;
  language?: string;
}

export interface OutlineStats {
  kcCount: number;
  bloomTagCount: number;
  cognitiveActionCount: number;
  masteryEvidenceCount: number;
  misconceptionCount: number;
  edgeConditionCount: number;
  learningFlowItemCount: number;
  prerequisiteIssueCount: number;
}

export interface OutlineVerificationTraceInput {
  targetVersion: number;
  content: string;
  kcTargetRange: string;
  filename?: string;
  language?: string;
}

export interface OutlineStepTraceInput {
  step: string;
  status: 'start' | 'done' | 'skip' | 'fail';
  detail?: string;
  durationMs?: number;
  language?: string;
}

export interface GenerationStepTraceInput {
  kind: string;
  step: string;
  status: 'start' | 'done' | 'skip' | 'fail';
  detail?: string;
  durationMs?: number;
  language?: string;
}

export interface FeynmanTraceInput {
  node: DagNode;
  provider: string;
  model: string;
  outlineVersion: string;
  outlineText: string;
  prerequisiteNames: string;
  language?: string;
}

export interface FeynmanSaveTraceInput {
  filename: string;
  content: string;
  indexed: boolean;
  indexUpdated: boolean;
  language?: string;
}

function isEn(language?: string): boolean {
  return language === 'en';
}

function truncate(value: string, max = MAX_LINE_CHARS): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value)));
}

function formatPercent(used: number, limit: number): string {
  if (limit <= 0) return '0%';
  return `${Math.round((used / limit) * 100)}%`;
}

function formatUsage(usage?: TokenUsage, language?: string): string {
  if (!usage) return localMsg(language, '本轮无 token 回传', 'no token usage returned');
  const input = usage.inputTokens ?? (usage.inputCacheHitTokens ?? 0) + (usage.inputCacheMissTokens ?? 0);
  const output = usage.outputTokens ?? 0;
  return localMsg(
    language,
    `输入 ${formatCount(input)} / 输出 ${formatCount(output)} tokens`,
    `input ${formatCount(input)} / output ${formatCount(output)} tokens`,
  );
}

function formatDuration(durationMs?: number, language?: string): string {
  if (durationMs === undefined) return '';
  if (durationMs < 1000) return localMsg(language, `${durationMs}ms`, `${durationMs}ms`);
  return localMsg(language, `${(durationMs / 1000).toFixed(1)}秒`, `${(durationMs / 1000).toFixed(1)}s`);
}

function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}\n`;
}

function bullet(label: string, value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return '';
  return `- ${label}：${value}\n`;
}

function sourceName(source: SourceRecord): string {
  return source.host ?? source.url ?? source.filePath ?? source.kind;
}

function summarizeSource(source: SourceRecord, index: number): string {
  const score = Number.isFinite(source.trustScore) ? source.trustScore.toFixed(2) : 'n/a';
  return `${index + 1}. ${truncate(source.title, 72)} (${source.kind}, ${sourceName(source)}, trust ${score})`;
}

function summarizePlan(plan: LearningSourcePlan | undefined, language?: string): string[] {
  if (!plan) return [];
  const slotSummary = plan.slots.slice(0, 6).map((slot) =>
    `${slot.name}${slot.mustHave ? '*' : ''}/${slot.priority}`,
  ).join(isEn(language) ? ', ' : '、');
  return [
    bullet(localMsg(language, '资料需求形态', 'source plan shape'), plan.learningShape).trimEnd(),
    bullet(localMsg(language, '资料槽位', 'source slots'), slotSummary).trimEnd(),
    bullet(localMsg(language, '规划依据', 'planning rationale'), truncate(plan.planningRationale, 160)).trimEnd(),
  ].filter(Boolean);
}

function contentStats(content: string, language?: string): string {
  const headings = content
    .split('\n')
    .filter((line) => /^#{1,3}\s+/.test(line))
    .slice(0, 5)
    .map((line) => line.replace(/^#{1,3}\s+/, '').trim())
    .join(isEn(language) ? ', ' : '、');
  const mermaidBlocks = (content.match(/```mermaid/gi) ?? []).length;
  const parts = [
    localMsg(language, `正文约 ${formatCount(content.length)} 字符`, `about ${formatCount(content.length)} chars`),
    mermaidBlocks > 0 ? localMsg(language, `Mermaid ${mermaidBlocks} 个`, `${mermaidBlocks} Mermaid block(s)`) : '',
    headings ? localMsg(language, `标题：${truncate(headings, 140)}`, `headings: ${truncate(headings, 140)}`) : '',
  ].filter(Boolean);
  return parts.join(isEn(language) ? '; ' : '；');
}

function countSectionLines(content: string, sectionPattern: RegExp, linePattern: RegExp): number {
  const sectionMatch = sectionPattern.exec(content);
  if (!sectionMatch || sectionMatch.index === undefined) return 0;
  const tail = content.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = tail.search(/\n##\s+/);
  const body = nextSection >= 0 ? tail.slice(0, nextSection) : tail;
  return body.split('\n').filter((line) => linePattern.test(line.trim())).length;
}

function countListItems(content: string): number {
  return content.split('\n').filter((line) => /^(?:[-*]|\d+[.)、])\s+/.test(line.trim())).length;
}

export function analyzeOutlineContentForTrace(content: string): OutlineStats {
  const kcIds = [...content.matchAll(/^###\s+(KC\d+):/mg)].map((match) => match[1]);
  const defined = new Set(kcIds);
  const prerequisiteIssueCount = [...content.matchAll(/(?:前置KC|前置依赖|Prerequisite KCs|Prerequisites)\s*[:：]\s*(.+)$/gmi)]
    .flatMap((match) => [...match[1].matchAll(/KC\d+/g)].map((ref) => ref[0]))
    .filter((ref) => !defined.has(ref))
    .length;
  return {
    kcCount: kcIds.length,
    bloomTagCount: (content.match(/(?:布鲁姆层级|Bloom\s*Level)\s*[:：]/gi) ?? []).length,
    cognitiveActionCount: (content.match(/(?:认知动作|Cognitive Action|Cognitive Process)\s*[:：]/gi) ?? []).length,
    masteryEvidenceCount: (content.match(/(?:掌握证据|可观察证据|Mastery Evidence|Observable Evidence|Mastery Indicator|掌握指标)\s*[:：]/gi) ?? []).length,
    misconceptionCount: Math.max(
      countSectionLines(content, /##\s+(?:常见误解|Common Misconceptions)[^\n]*\n/i, /^(?:\d+[.)、]\s+|-)/),
      (content.match(/(?:常见误解|常见错误|Misconception|Common Error)\s*[:：]/gi) ?? []).length,
    ),
    edgeConditionCount: countSectionLines(content, /##\s+(?:边界条件|Edge Conditions)[^\n]*\n/i, /^-/),
    learningFlowItemCount: countSectionLines(content, /##\s+\d*[.、]?\s*(?:学习推进|学习流程|Learning Flow|Learning Sequence)[^\n]*\n/i, /^-/),
    prerequisiteIssueCount,
  };
}

export function formatOutlineContextTrace(input: OutlineTraceInput): string {
  const versionText = input.currentVersion === 0
    ? localMsg(input.language, `新建 v${input.targetVersion}`, `create v${input.targetVersion}`)
    : localMsg(input.language, `v${input.currentVersion} → v${input.targetVersion}`, `v${input.currentVersion} -> v${input.targetVersion}`);
  return '\n' +
    heading(3, localMsg(input.language, '纲要生成过程', 'Outline generation trace')) +
    bullet(localMsg(input.language, '请求', 'request'), `${versionText} / ${input.provider}/${input.model}`) +
    bullet(localMsg(input.language, '节点', 'node'), `${input.node.name}（${input.node.chapter}，${getDifficultyLabel(input.node.difficulty, input.language)}）`) +
    bullet(localMsg(input.language, '搜索模式', 'search mode'), input.searchMode) +
    bullet(localMsg(input.language, '学习类型', 'learning type'), input.learningType || localMsg(input.language, '未标注', 'not set')) +
    bullet(localMsg(input.language, '认知终点', 'cognitive endpoint'), input.bloomTarget || localMsg(input.language, '未标注', 'not set')) +
    bullet(localMsg(input.language, 'chapter_scope 范围', 'chapter_scope items'), input.nodeScopeCount) +
    bullet(localMsg(input.language, '边界备注', 'boundary notes'), input.boundaryNotes ? truncate(input.boundaryNotes, 160) : undefined) +
    bullet(localMsg(input.language, '相邻纲要', 'adjacent outlines'), input.adjacentOutlineCount) +
    bullet(localMsg(input.language, '前置节点', 'prerequisites'), input.prerequisiteNames || localMsg(input.language, '无', 'none')) +
    bullet(localMsg(input.language, '基础纲要', 'base outline'), input.baseOutlineChars ? localMsg(input.language, `约 ${formatCount(input.baseOutlineChars)} 字符`, `about ${formatCount(input.baseOutlineChars)} chars`) : undefined) +
    bullet(localMsg(input.language, '覆盖情况', 'coverage'), input.coveredKcCount !== undefined && input.uncoveredKcCount !== undefined
      ? localMsg(input.language, `已覆盖 ${input.coveredKcCount}，未覆盖 ${input.uncoveredKcCount}`, `${input.coveredKcCount} covered, ${input.uncoveredKcCount} uncovered`)
      : undefined) +
    '\n';
}

export function formatOutlineSourceTrace(input: OutlineSourceTraceInput): string {
  const curriculum = input.references.filter((ref) => ref.kind === 'curriculum');
  const misconception = input.references.filter((ref) => ref.kind === 'misconception');
  const refs = input.references.slice(0, 6).map((ref, index) =>
    `  ${index + 1}. [${ref.kind}] ${truncate(ref.title, 72)}${ref.url ? ` (${truncate(ref.url, 90)})` : ''}`,
  );
  return '\n' +
    heading(3, localMsg(input.language, '纲要参考来源', 'Outline references')) +
    bullet(localMsg(input.language, '来源统计', 'reference stats'), localMsg(
      input.language,
      `课程结构 ${curriculum.length}，误解/边界 ${misconception.length}`,
      `${curriculum.length} curriculum, ${misconception.length} misconception/boundary`,
    )) +
    bullet(localMsg(input.language, '严格参考库', 'strict library'), input.strictLibraryMode === undefined ? undefined : input.strictLibraryMode ? localMsg(input.language, '开启', 'on') : localMsg(input.language, '关闭', 'off')) +
    (refs.length > 0
      ? `${localMsg(input.language, '已采用参考', 'references used')}：\n${refs.join('\n')}\n`
      : bullet(localMsg(input.language, '已采用参考', 'references used'), localMsg(input.language, '无；将按节点和相邻纲要生成', 'none; using node context and adjacent outlines'))) +
    '\n';
}

export function formatOutlineVerificationTrace(input: OutlineVerificationTraceInput): string {
  const stats = analyzeOutlineContentForTrace(input.content);
  const issues = [
    stats.masteryEvidenceCount >= Math.max(1, stats.kcCount) ? '' : localMsg(input.language, '部分 KC 缺少掌握证据', 'some KCs are missing mastery evidence'),
    stats.prerequisiteIssueCount === 0 ? '' : localMsg(input.language, `发现 ${stats.prerequisiteIssueCount} 个未定义前置 KC 引用`, `${stats.prerequisiteIssueCount} undefined prerequisite KC reference(s)`),
  ].filter(Boolean);
  const status = issues.length === 0
    ? localMsg(input.language, '通过', 'passed')
    : localMsg(input.language, `有提示：${issues.join('；')}`, `warnings: ${issues.join('; ')}`);
  return localMsg(
    input.language,
    `- 纲要校验：v${input.targetVersion} ${status}；KC ${stats.kcCount} 个，认知动作 ${stats.cognitiveActionCount} 个，掌握证据 ${stats.masteryEvidenceCount} 个，误解 ${stats.misconceptionCount} 条，学习流程项 ${stats.learningFlowItemCount} 条${input.filename ? `；保存为 ${input.filename}` : ''}\n`,
    `- Outline check: v${input.targetVersion} ${status}; ${stats.kcCount} KCs, ${stats.cognitiveActionCount} cognitive actions, ${stats.masteryEvidenceCount} evidence fields, ${stats.misconceptionCount} misconceptions, ${stats.learningFlowItemCount} flow items${input.filename ? `; saved as ${input.filename}` : ''}\n`,
  );
}

export function formatOutlineStepTrace(input: OutlineStepTraceInput): string {
  return formatGenerationStepTrace({
    kind: localMsg(input.language, '纲要', 'outline'),
    step: input.step,
    status: input.status,
    detail: input.detail,
    durationMs: input.durationMs,
    language: input.language,
  });
}

export function formatGenerationStepTrace(input: GenerationStepTraceInput): string {
  const statusText = (() => {
    if (input.status === 'start') return localMsg(input.language, '开始', 'started');
    if (input.status === 'done') return localMsg(input.language, '完成', 'done');
    if (input.status === 'skip') return localMsg(input.language, '跳过', 'skipped');
    return localMsg(input.language, '失败', 'failed');
  })();
  const duration = formatDuration(input.durationMs, input.language);
  const parts = [
    localMsg(input.language, `${input.kind}阶段：${input.step} ${statusText}`, `${input.kind} stage: ${input.step} ${statusText}`),
    duration ? localMsg(input.language, `耗时 ${duration}`, duration) : '',
    input.detail ? truncate(input.detail, 220) : '',
  ].filter(Boolean);
  return `- ${parts.join(localMsg(input.language, '；', '; '))}\n`;
}

export function formatFeynmanContextTrace(input: FeynmanTraceInput): string {
  const outlineStats = analyzeOutlineContentForTrace(input.outlineText);
  return '\n' +
    heading(3, localMsg(input.language, '费曼复盘生成过程', 'Feynman review trace')) +
    bullet(localMsg(input.language, '请求', 'request'), `${input.provider}/${input.model}`) +
    bullet(localMsg(input.language, '节点', 'node'), `${input.node.name}（${input.node.chapter}，${getDifficultyLabel(input.node.difficulty, input.language)}）`) +
    bullet(localMsg(input.language, '纲要版本', 'outline version'), input.outlineVersion) +
    bullet(localMsg(input.language, '纲要结构', 'outline structure'), localMsg(
      input.language,
      `KC ${outlineStats.kcCount} 个，掌握证据 ${outlineStats.masteryEvidenceCount} 个，误解 ${outlineStats.misconceptionCount} 条`,
      `${outlineStats.kcCount} KCs, ${outlineStats.masteryEvidenceCount} evidence fields, ${outlineStats.misconceptionCount} misconceptions`,
    )) +
    bullet(localMsg(input.language, '学习类型', 'learning type'), input.node.learning_type || localMsg(input.language, '未标注', 'not set')) +
    bullet(localMsg(input.language, '认知终点', 'cognitive endpoint'), input.node.bloom_target || localMsg(input.language, '未标注', 'not set')) +
    bullet(localMsg(input.language, '前置节点', 'prerequisites'), input.prerequisiteNames || localMsg(input.language, '无', 'none')) +
    '\n';
}

export function formatFeynmanSaveTrace(input: FeynmanSaveTraceInput): string {
  const itemCount = countListItems(input.content);
  return localMsg(
    input.language,
    `- 费曼复盘保存：${input.filename}；${contentStats(input.content, input.language)}；清单项约 ${itemCount} 条；RAG 索引${input.indexed ? '成功' : '未完成'}；目录索引${input.indexUpdated ? '已更新' : '未更新'}\n`,
    `- Feynman review saved: ${input.filename}; ${contentStats(input.content, input.language)}; about ${itemCount} checklist items; RAG index ${input.indexed ? 'ok' : 'not completed'}; folder index ${input.indexUpdated ? 'updated' : 'not updated'}\n`,
  );
}

export function formatMaterialContextTrace(input: MaterialContextTraceInput): string {
  const folder = getArtifactDisplayName(input.targetFolder, input.language);
  const kcSummary = input.kcNames.length > 0
    ? input.kcNames.slice(0, 8).join(isEn(input.language) ? ', ' : '、') +
      (input.kcNames.length > 8 ? localMsg(input.language, ` 等 ${input.kcNames.length} 个`, ` and ${input.kcNames.length} total`) : '')
    : localMsg(input.language, '未从 v1 学习蓝图解析到 KC，按节点描述兜底', 'no KCs parsed from v1 blueprint; falling back to node description');

  return '\n' +
    heading(3, localMsg(input.language, '资料生成过程', 'Material generation trace')) +
    bullet(localMsg(input.language, '请求', 'request'), `${folder} / ${input.provider}/${input.model}`) +
    bullet(localMsg(input.language, '节点', 'node'), `${input.node.name}（${input.node.chapter}，${getDifficultyLabel(input.node.difficulty, input.language)}）`) +
    bullet(localMsg(input.language, '搜索模式', 'search mode'), input.searchMode) +
    bullet(localMsg(input.language, '用户要求', 'user request'), truncate(input.userMessage, 160)) +
    bullet(localMsg(input.language, '纲要', 'outline'), `${input.outlineVersion}，KC ${input.kcNames.length} 个`) +
    bullet(localMsg(input.language, 'KC 范围', 'KC scope'), kcSummary) +
    bullet(
      localMsg(input.language, '已覆盖KC', 'covered KCs'),
      input.kcNames.length > 0 ? `${input.indexEntryCount}/${input.kcNames.length}` : input.indexEntryCount,
    ) +
    bullet(localMsg(input.language, '前置节点', 'prerequisites'), input.prerequisiteNames || localMsg(input.language, '无', 'none')) +
    '\n';
}

export function formatMaterialSourceTrace(input: MaterialSourceTraceInput): string {
  const plan = (input.evidencePack as EvidencePack & { plan?: LearningSourcePlan }).plan;
  const libraryCount = input.evidencePack.sources.filter((s) => s.kind === 'upload' || s.kind === 'generated').length;
  const webCount = input.evidencePack.sources.filter((s) => s.kind === 'web').length;
  const sourceLines = input.evidencePack.sources.slice(0, 8).map(summarizeSource);
  const gapText = input.evidencePack.coverage.missing.length > 0
    ? input.evidencePack.coverage.missing.slice(0, 6).join(isEn(input.language) ? ', ' : '、')
    : localMsg(input.language, '无明显缺口', 'no obvious gaps');
  const budget = input.evidencePack.budgetUsed;
  const planLines = summarizePlan(plan, input.language);

  return '\n' +
    heading(3, localMsg(input.language, '检索与资料来源', 'Retrieval and sources')) +
    bullet(localMsg(input.language, '查询', 'query'), truncate(input.query, 140)) +
    bullet(localMsg(input.language, '搜索模式', 'search mode'), input.searchMode) +
    bullet(localMsg(input.language, '任务类型', 'task'), input.isPractice ? localMsg(input.language, '实践题/答案', 'practice/answer') : localMsg(input.language, '原理资料', 'theory')) +
    bullet(localMsg(input.language, '来源统计', 'source stats'), localMsg(
      input.language,
      `参考库 ${libraryCount}，网页 ${webCount}，证据片段 ${input.evidencePack.chunks.length}，题源 ${input.practiceSourceCount ?? 0}，视频 ${input.videoCount ?? 0}`,
      `library ${libraryCount}, web ${webCount}, snippets ${input.evidencePack.chunks.length}, practice sources ${input.practiceSourceCount ?? 0}, videos ${input.videoCount ?? 0}`,
    )) +
    bullet(localMsg(input.language, '检索预算', 'search budget'), localMsg(
      input.language,
      `查询 ${budget.queries} 次，抓取 ${budget.pagesFetched} 页，补搜 ${budget.reflectionSearches} 次，LLM 重排 ${budget.llmReranks} 次`,
      `${budget.queries} queries, ${budget.pagesFetched} pages, ${budget.reflectionSearches} follow-up, ${budget.llmReranks} LLM rerank(s)`,
    )) +
    (planLines.length > 0 ? planLines.map((line) => `${line}\n`).join('') : '') +
    bullet(localMsg(input.language, '覆盖缺口', 'coverage gaps'), truncate(gapText, 180)) +
    (sourceLines.length > 0
      ? `${localMsg(input.language, '已选来源', 'selected sources')}：\n${sourceLines.map((line) => `  ${line}`).join('\n')}\n`
      : bullet(localMsg(input.language, '已选来源', 'selected sources'), localMsg(input.language, '无', 'none'))) +
    (input.evidencePack.warnings.length > 0
      ? `${localMsg(input.language, '检索提示', 'retrieval notes')}：\n${input.evidencePack.warnings.slice(0, 4).map((w) => `  - ${truncate(w, 160)}`).join('\n')}\n`
      : '') +
    '\n';
}

export function formatMaterialTurnTrace(input: MaterialTurnTraceInput): string {
  const tools = input.toolNames.length > 0
    ? input.toolNames.join(', ')
    : localMsg(input.language, '无工具调用', 'no tool call');
  return localMsg(
    input.language,
    `- 第 ${input.turn + 1} 轮模型返回：${input.stopReason}；工具：${tools}；${formatUsage(input.usage, input.language)}；上下文预算 ${formatPercent(input.budgetUsed, input.budgetLimit)}（${formatCount(input.budgetUsed)} / ${formatCount(input.budgetLimit)} tokens）；消息 ${input.messageCount} 条\n`,
    `- Turn ${input.turn + 1}: ${input.stopReason}; tools: ${tools}; ${formatUsage(input.usage, input.language)}; context budget ${formatPercent(input.budgetUsed, input.budgetLimit)} (${formatCount(input.budgetUsed)} / ${formatCount(input.budgetLimit)} tokens); ${input.messageCount} messages\n`,
  );
}

export function formatMaterialCompactionTrace(input: MaterialCompactionTraceInput): string {
  return localMsg(
    input.language,
    `- 上下文压缩：消息 ${input.beforeMessages} → ${input.afterMessages}；预算 ${formatPercent(input.budgetUsed, input.budgetLimit)}（${formatCount(input.budgetUsed)} / ${formatCount(input.budgetLimit)} tokens）\n`,
    `- Context compaction: messages ${input.beforeMessages} -> ${input.afterMessages}; budget ${formatPercent(input.budgetUsed, input.budgetLimit)} (${formatCount(input.budgetUsed)} / ${formatCount(input.budgetLimit)} tokens)\n`,
  );
}

function summarizeToolInput(call: ToolCallBlock, language?: string): string {
  const input = call.input ?? {};
  if (call.name === 'save_file') {
    const file = typeof input.filename === 'string' ? input.filename : '';
    const folder = typeof input.folderName === 'string' ? input.folderName : '';
    const content = typeof input.content === 'string' ? input.content : '';
    return [
      folder ? `folder=${folder}` : '',
      file ? `filename=${file}` : '',
      content ? contentStats(content, language) : '',
    ].filter(Boolean).join('; ');
  }
  if (call.name === 'rag_retrieve' || call.name === 'web_search') {
    return Object.entries(input)
      .filter(([_, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 6)
      .map(([key, value]) => `${key}=${truncate(String(value), 80)}`)
      .join('; ');
  }
  if (call.name === 'generate_quiz') {
    return Object.entries(input)
      .filter(([_, value]) => value !== undefined && value !== null)
      .slice(0, 8)
      .map(([key, value]) => `${key}=${truncate(String(value), 80)}`)
      .join('; ');
  }
  return Object.entries(input)
    .slice(0, 6)
    .map(([key, value]) => {
      if (typeof value === 'string') return `${key}=${truncate(value, 80)}`;
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}=${value}`;
      if (Array.isArray(value)) return `${key}=[${value.length} items]`;
      return `${key}={...}`;
    })
    .join('; ');
}

function summarizeToolResult(result: ToolResultBlock, language?: string): string {
  const firstLines = result.content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(isEn(language) ? ' | ' : '；');
  return truncate(firstLines || result.content, 240);
}

export function formatMaterialToolStartTrace(call: ToolCallBlock, language?: string): string {
  const summary = summarizeToolInput(call, language);
  return localMsg(
    language,
    `- 工具开始：${call.name}${summary ? `（${summary}）` : ''}\n`,
    `- Tool start: ${call.name}${summary ? ` (${summary})` : ''}\n`,
  );
}

export function formatMaterialToolResultTrace(input: MaterialToolResultTraceInput): string {
  const status = input.result.isError
    ? localMsg(input.language, '失败', 'failed')
    : localMsg(input.language, '成功', 'ok');
  const duration = formatDuration(input.durationMs, input.language);
  return localMsg(
    input.language,
    `- 工具结果：${input.call.name} ${status}${duration ? `，耗时 ${duration}` : ''}；${summarizeToolResult(input.result, input.language)}\n`,
    `- Tool result: ${input.call.name} ${status}${duration ? `, ${duration}` : ''}; ${summarizeToolResult(input.result, input.language)}\n`,
  );
}

export function formatMaterialSaveTrace(input: MaterialSaveTraceInput): string {
  const folder = getArtifactDisplayName(input.folderName, input.language);
  return localMsg(
    input.language,
    `- 保存产物：${folder}/${input.filename}；${contentStats(input.content, input.language)}\n`,
    `- Artifact saved: ${folder}/${input.filename}; ${contentStats(input.content, input.language)}\n`,
  );
}

export function formatMaterialVerificationTrace(message: string, language?: string): string {
  return localMsg(language, `- 校验/修复：${message}\n`, `- Verification/repair: ${message}\n`);
}

export function formatSimpleGenerationTrace(input: {
  kind: string;
  nodeName: string;
  targetFolder: FolderKey;
  model: string;
  outlineVersion?: string;
  sourceCount?: number;
  content?: string;
  filename?: string;
  language?: string;
}): string {
  const folder = getArtifactDisplayName(input.targetFolder, input.language);
  if (input.filename) {
    return localMsg(
      input.language,
      `- 生成完成：${input.kind} → ${folder}/${input.filename}${input.content ? `；${contentStats(input.content, input.language)}` : ''}\n`,
      `- Generation complete: ${input.kind} -> ${folder}/${input.filename}${input.content ? `; ${contentStats(input.content, input.language)}` : ''}\n`,
    );
  }
  return '\n' +
    heading(3, localMsg(input.language, '资料生成过程', 'Material generation trace')) +
    bullet(localMsg(input.language, '类型', 'type'), input.kind) +
    bullet(localMsg(input.language, '节点', 'node'), input.nodeName) +
    bullet(localMsg(input.language, '目标文件夹', 'target folder'), folder) +
    bullet(localMsg(input.language, '模型', 'model'), input.model) +
    bullet(localMsg(input.language, '纲要版本', 'outline version'), input.outlineVersion) +
    bullet(localMsg(input.language, '读取资料数', 'materials read'), input.sourceCount) +
    '\n';
}
