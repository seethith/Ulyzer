import type { EvidenceChunk, EvidencePack, SearchMode, SourceRecord, TokenUsage, TrustLevel } from '@shared/types';
import { localMsg } from '../../agent-i18n/messages';
import { LLMAdapter, type LLMUsageContext } from '../../llm/adapter';
import { classifyTrustLevel } from '../../web/source-authority';
import { collectEvidencePack, summarizeEvidencePack } from '../../web/research-pipeline';
import type { PlannedQuery } from '../../web/query-planner';
import { collectLibraryRoadmapEvidence } from './library-roadmap-evidence';

export interface RouteEvidencePlan {
  needs_external_evidence: boolean;
  library_query: string;
  web_queries: PlannedQuery[];
  evidence_goals: string[];
  rationale?: string;
}

export interface RouteEvidenceResult {
  plan: RouteEvidencePlan;
  digest: string;
  summary: string;
  pack: EvidencePack | null;
}

export interface RouteEvidenceInput {
  topic: string;
  profileText: string;
  courseId: string;
  provider: string;
  model: string;
  searchMode: SearchMode;
  language?: string;
  signal?: AbortSignal;
  usageContext?: LLMUsageContext;
  onProgress?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

const DEFAULT_GOALS = ['curriculum', 'prerequisites', 'learning_objectives', 'assessment'];
const ROUTE_EVIDENCE_DIGEST_BUDGET = 24_000;
const STRICT_LIBRARY_EVIDENCE_DIGEST_BUDGET = 72_000;
const ROUTE_EVIDENCE_WARNING_RESERVE = 1_400;

export async function collectRouteEvidence(input: RouteEvidenceInput): Promise<RouteEvidenceResult> {
  const mode = input.searchMode;
  if (mode === 'off') {
    const plan = fallbackPlan(input.topic, false);
    return {
      plan,
      pack: null,
      summary: localMsg(input.language, '搜索已关闭，路线图将主要依据模型内生知识生成。\n', 'Search is off; the roadmap will rely on model knowledge.\n'),
      digest: formatNoEvidenceDigest(input.language, 'search_off'),
    };
  }

  input.onProgress?.(localMsg(input.language, '🧭 正在规划路线图证据检索目标…\n', '🧭 Planning roadmap evidence goals…\n'));
  const plan = await planRouteEvidence(input).catch(() => fallbackPlan(input.topic, true));

  if (mode === 'auto' && !plan.needs_external_evidence) {
    return {
      plan,
      pack: null,
      summary: localMsg(input.language, '模型判断该主题暂不需要外部资料，已跳过检索。\n', 'The model judged external evidence unnecessary and skipped retrieval.\n'),
      digest: formatNoEvidenceDigest(input.language, 'planner_skipped', plan),
    };
  }

  input.onProgress?.(searchProgressMessage(mode, input.language));

  if (mode === 'library') {
    input.onProgress?.(localMsg(input.language, '📖 正在读取参考库文档结构、目录和章节线索…\n', '📖 Reading source-library document structure, tables of contents, and chapter cues…\n'));
    const pack = await collectLibraryRoadmapEvidence({
      courseId: input.courseId,
      query: plan.library_query || input.topic,
      language: input.language,
      provider: input.provider,
      model: input.model,
      signal: input.signal,
      onUsage: input.onUsage,
    });
    const summary = formatRouteEvidenceSummary(pack, input.language);
    input.onProgress?.(summary);
    return {
      plan,
      pack,
      summary,
      digest: formatRouteEvidenceDigest(pack, plan, input.language, { strictLibrary: true }),
    };
  }

  let pack: EvidencePack;
  try {
    pack = await collectEvidencePack({
      query: plan.library_query || input.topic,
      courseId: input.courseId,
      mode,
      taskType: 'roadmap',
      maxWebResults: 4,
      plannedQueries: plan.web_queries,
      language: input.language,
      provider: input.provider,
      model: input.model,
      signal: input.signal,
      onUsage: input.onUsage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      plan,
      pack: null,
      summary: localMsg(input.language, `证据检索失败，已退回模型内生知识：${message}\n`, `Evidence retrieval failed; falling back to model knowledge: ${message}\n`),
      digest: [
        formatNoEvidenceDigest(input.language, 'planner_skipped', plan),
        input.language === 'en' ? `Evidence retrieval failed: ${message}` : `证据检索失败：${message}`,
      ].join('\n'),
    };
  }
  const summary = formatRouteEvidenceSummary(pack, input.language);
  input.onProgress?.(summary);

  return {
    plan,
    pack,
    summary,
    digest: formatRouteEvidenceDigest(pack, plan, input.language),
  };
}

async function planRouteEvidence(input: RouteEvidenceInput): Promise<RouteEvidencePlan> {
  let raw = '';
  await LLMAdapter.stream({
    provider: input.provider,
    model: input.model,
    systemPrompt: localMsg(
      input.language,
      '你是路线图证据检索规划器。只输出合法 JSON，不要输出 Markdown。你的任务是判断生成学习路线图前需要查哪些资料。',
      'You are a roadmap evidence planning tool. Output valid JSON only, no Markdown. Decide what evidence should be retrieved before generating a learning roadmap.',
    ),
    messages: [{
      role: 'user',
      content: localMsg(
        input.language,
        `学习主题：${input.topic}\n${input.profileText ? `学习档案：\n${input.profileText}\n` : ''}` +
        `搜索模式：${input.searchMode}\n\n` +
        `请输出 JSON：\n` +
        `{\n` +
        `  "needs_external_evidence": true,\n` +
        `  "library_query": "用于检索本地参考库的一句话查询",\n` +
        `  "web_queries": [\n` +
        `    { "query": "course syllabus learning objectives curriculum", "purpose": "curriculum" }\n` +
        `  ],\n` +
        `  "evidence_goals": ["curriculum", "prerequisites", "learning_objectives", "assessment"],\n` +
        `  "rationale": "一句话说明为什么这样查"\n` +
        `}\n\n` +
        `规则：web_queries 最多 3 条；优先找课程大纲、先修要求、学习目标、实践/考核结构；通识常识主题也可设置 needs_external_evidence=false。`,
        `Topic: ${input.topic}\n${input.profileText ? `Learner profile:\n${input.profileText}\n` : ''}` +
        `Search mode: ${input.searchMode}\n\n` +
        `Output JSON:\n` +
        `{\n` +
        `  "needs_external_evidence": true,\n` +
        `  "library_query": "one query for the local source library",\n` +
        `  "web_queries": [\n` +
        `    { "query": "course syllabus learning objectives curriculum", "purpose": "curriculum" }\n` +
        `  ],\n` +
        `  "evidence_goals": ["curriculum", "prerequisites", "learning_objectives", "assessment"],\n` +
        `  "rationale": "one sentence rationale"\n` +
        `}\n\n` +
        `Rules: web_queries max 3; prefer syllabi, prerequisites, learning objectives, practice/assessment structure; for common topics you may set needs_external_evidence=false.`,
      ),
    }],
    maxTokens: 600,
    temperature: 0,
    jsonMode: true,
    usageContext: input.usageContext,
    signal: input.signal,
    onChunk: (chunk) => { raw += chunk; },
    onComplete: (usage) => input.onUsage?.(usage),
    onError: () => {},
  });
  return normalizePlan(parsePlanJson(raw), input.topic);
}

function parsePlanJson(raw: string): unknown {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  return JSON.parse(raw);
}

function normalizePlan(value: unknown, topic: string): RouteEvidencePlan {
  const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const webQueries = Array.isArray(obj.web_queries) ? obj.web_queries : [];
  return {
    needs_external_evidence: typeof obj.needs_external_evidence === 'boolean'
      ? obj.needs_external_evidence
      : true,
    library_query: typeof obj.library_query === 'string' && obj.library_query.trim()
      ? obj.library_query.trim()
      : `${topic} curriculum learning objectives prerequisites`,
    web_queries: webQueries
      .map((item): PlannedQuery | null => {
        if (typeof item === 'string') return { query: item, purpose: 'model_planned' };
        if (!item || typeof item !== 'object') return null;
        const rec = item as Record<string, unknown>;
        if (typeof rec.query !== 'string' || !rec.query.trim()) return null;
        return {
          query: rec.query.trim(),
          purpose: typeof rec.purpose === 'string' && rec.purpose.trim() ? rec.purpose.trim() : 'model_planned',
        };
      })
      .filter((item): item is PlannedQuery => Boolean(item))
      .slice(0, 3),
    evidence_goals: Array.isArray(obj.evidence_goals)
      ? obj.evidence_goals.filter((goal): goal is string => typeof goal === 'string' && goal.trim().length > 0).slice(0, 6)
      : [...DEFAULT_GOALS],
    rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
  };
}

function fallbackPlan(topic: string, needsExternal: boolean): RouteEvidencePlan {
  return {
    needs_external_evidence: needsExternal,
    library_query: `${topic} curriculum learning objectives prerequisites assessment`,
    web_queries: [
      { query: `${topic} course syllabus learning objectives curriculum`, purpose: 'curriculum' },
      { query: `${topic} prerequisites learning path`, purpose: 'prerequisites' },
      { query: `${topic} project assignment assessment`, purpose: 'assessment' },
    ],
    evidence_goals: [...DEFAULT_GOALS],
    rationale: 'fallback evidence plan',
  };
}

function searchProgressMessage(mode: SearchMode, language?: string): string {
  if (mode === 'library') {
    return localMsg(language, '📚 正在严格读取参考库（本轮不会联网，也不会用外部知识补齐）…\n', '📚 Strictly reading the source library; web and outside knowledge will not be used to fill gaps…\n');
  }
  if (mode === 'web') {
    return localMsg(language, '📚 正在联网检索权威资料（本轮不会读取参考库）…\n', '📚 Searching the web for authoritative evidence; the source library will not be read this turn…\n');
  }
  return localMsg(language, '📚 正在检索参考库；如证据不足，将自动联网补充…\n', '📚 Searching the source library; web will be used automatically if evidence is insufficient…\n');
}

function formatNoEvidenceDigest(language?: string, reason?: 'search_off' | 'planner_skipped', plan?: RouteEvidencePlan): string {
  if (language === 'en') {
    return [
      '[Roadmap Evidence]',
      reason === 'search_off'
        ? 'Search is off. Generate the roadmap from the learner request, profile, and general model knowledge.'
        : 'The evidence planner judged external retrieval unnecessary for this topic.',
      plan?.rationale ? `Planner rationale: ${plan.rationale}` : '',
      'For unsupported but necessary domain details, leave source_ids empty; rationale should describe learning value or sequencing, not provenance.',
    ].filter(Boolean).join('\n');
  }
  return [
    '[路线图证据]',
    reason === 'search_off'
      ? '本轮搜索已关闭。请根据用户请求、学习档案和模型通用知识生成路线图。'
      : '证据规划器判断该主题暂不需要外部检索。',
    plan?.rationale ? `规划理由：${plan.rationale}` : '',
    '缺少直接来源但必要的领域细节可以补充，source_ids 置为空；rationale 只说明学习价值或编排理由，不要写来源说明。',
  ].filter(Boolean).join('\n');
}

function formatRouteEvidenceSummary(pack: EvidencePack, language?: string): string {
  const libraryCount = pack.sources.filter((source) => source.kind === 'upload' || source.kind === 'generated').length;
  const webCount = pack.sources.filter((source) => source.kind === 'web').length;
  const officialCount = pack.sources.filter((source) => sourceTrust(source) === 'official').length;
  const gaps = pack.coverage.missing.length > 0
    ? language === 'en' ? ` · gaps: ${pack.coverage.missing.join(', ')}` : ` · 缺口：${pack.coverage.missing.join('、')}`
    : '';
  const budget = language === 'en'
    ? ` · queries ${pack.budgetUsed.queries}, pages ${pack.budgetUsed.pagesFetched}`
    : ` · 查询 ${pack.budgetUsed.queries} 次，读取 ${pack.budgetUsed.pagesFetched} 页`;
  return language === 'en'
    ? `🧾 Evidence ready: library ${libraryCount}, web ${webCount}, official ${officialCount}${budget}${gaps}\n`
    : `🧾 证据包已整理：参考库 ${libraryCount} 条，网页 ${webCount} 条，官方来源 ${officialCount} 条${budget}${gaps}\n`;
}

function formatRouteEvidenceDigest(
  pack: EvidencePack,
  plan: RouteEvidencePlan,
  language?: string,
  options: { strictLibrary?: boolean } = {},
): string {
  if (pack.sources.length === 0 && pack.chunks.length === 0) {
    if (options.strictLibrary) {
      return [
        language === 'en' ? '[Strict Source-Library Roadmap Evidence]' : '[严格参考库路线图证据]',
        language === 'en'
          ? 'No enabled source-library evidence matched this request. Do not generate unsupported chapters; state that the enabled library sources are insufficient.'
          : '未找到可用于本次请求的已启用参考库证据。不要生成无资料支撑的章节；请说明已启用参考库资料不足。',
        ...pack.warnings,
      ].filter(Boolean).join('\n');
    }
    return [
      formatNoEvidenceDigest(language, 'planner_skipped', plan),
      language === 'en' ? 'No matching library or web evidence was found.' : '未找到匹配的参考库或网页证据。',
      ...pack.warnings,
    ].filter(Boolean).join('\n');
  }

  const sourceIndex = new Map(pack.sources.map((source, index) => [source.id, index + 1]));
  const lines: string[] = [];
  let charBudget = options.strictLibrary ? STRICT_LIBRARY_EVIDENCE_DIGEST_BUDGET : ROUTE_EVIDENCE_DIGEST_BUDGET;
  const pushLine = (text: string) => {
    lines.push(text);
    charBudget -= text.length + 2;
  };
  lines.push(options.strictLibrary
    ? language === 'en' ? '[Strict Source-Library Roadmap Evidence Digest]' : '[严格参考库路线图证据摘要]'
    : language === 'en' ? '[Roadmap Evidence Digest]' : '[路线图证据摘要]');
  charBudget -= lines[0].length + 2;
  if (options.strictLibrary) {
    pushLine(language === 'en'
      ? 'Strict library mode: generate only what the enabled source library supports. Do not use web search or outside curriculum knowledge to add unsupported chapters. If coverage is limited, output a narrower but faithful roadmap.'
      : '严格参考库模式：最终路线图只能覆盖已启用参考库资料支持的内容。不得联网，不得用外部课程体系补出资料中没有的章节；资料覆盖有限时，请生成较窄但忠实的路线图。');
  }
  pushLine(summarizeEvidencePack(pack, language).trim());
  if (plan.evidence_goals.length > 0) {
    pushLine(language === 'en'
      ? `Evidence goals: ${plan.evidence_goals.join(', ')}`
      : `证据目标：${plan.evidence_goals.join('、')}`);
  }
  if (plan.rationale) {
    pushLine(language === 'en' ? `Planner rationale: ${plan.rationale}` : `规划理由：${plan.rationale}`);
  }

  pushLine(language === 'en'
    ? '\nSources (use source_id values in node.source_ids; max 2 per node):'
    : '\n来源（节点 source_ids 请填写这里的 source_id，每个节点最多 2 个）：');
  pack.sources.slice(0, options.strictLibrary ? 20 : 12).forEach((source, index) => {
    pushLine([
      `[S${index + 1}] ${source.title}`,
      `source_id: ${source.id}`,
      `${language === 'en' ? 'kind' : '类型'}: ${source.kind}`,
      `${language === 'en' ? 'trust' : '可信度'}: ${sourceTrust(source)} · ${source.trustScore.toFixed(2)}`,
      `${language === 'en' ? 'source' : '来源'}: ${source.url ?? source.filePath ?? source.kind}`,
    ].join('\n'));
  });

  pushLine(language === 'en' ? '\nEvidence excerpts under budget:' : '\n预算内证据摘录：');
  const orderedChunks = orderRoadmapEvidenceChunks(pack.chunks);
  let included = 0;
  let omitted = 0;
  for (const chunk of orderedChunks) {
    const sourceNo = sourceIndex.get(chunk.sourceId) ?? '?';
    const slot = chunk.slot ? ` · ${chunk.slot}` : '';
    const maxChars = evidenceChunkMaxChars(chunk);
    const text = compactEvidenceText(chunk.text, maxChars);
    const snippet = `[E${included + 1}] source_id=${chunk.sourceId} [S${sourceNo}]${slot}${chunk.locator ? ` · ${chunk.locator}` : ''}\n${text}`;
    if (snippet.length + ROUTE_EVIDENCE_WARNING_RESERVE > charBudget) {
      omitted++;
      continue;
    }
    pushLine(snippet);
    included++;
  }
  if (omitted > 0) {
    pushLine(language === 'en'
      ? `Omitted ${omitted} lower-priority evidence excerpts due to the digest budget; use read_source for exact pages when needed.`
      : `因证据预算限制，已省略 ${omitted} 条低优先级摘录；需要精读时可用 read_source 指定页码/单元。`);
  }

  if (included === 0 && pack.chunks.length > 0) {
    const chunk = pack.chunks[0];
    const sourceNo = sourceIndex.get(chunk.sourceId) ?? '?';
    const slot = chunk.slot ? ` · ${chunk.slot}` : '';
    pushLine(`[E1] source_id=${chunk.sourceId} [S${sourceNo}]${slot}\n${compactEvidenceText(chunk.text, 900)}`);
  }

  if (pack.coverage.missing.length > 0) {
    if (options.strictLibrary) {
      pushLine(language === 'en'
        ? `\nStrict-library coverage gaps: ${pack.coverage.missing.join(', ')}. Do not fill these gaps with outside knowledge; either omit unsupported roadmap parts or mark the library coverage as insufficient in the final summary.`
        : `\n严格参考库证据缺口：${pack.coverage.missing.join('、')}。不要用外部知识补齐这些缺口；请省略无资料支撑的路线内容，或在最终总结说明参考库覆盖不足。`);
    } else {
      pushLine(language === 'en'
        ? `\nCoverage gaps: ${pack.coverage.missing.join(', ')}. You may fill necessary route parts from expert knowledge; leave source_ids empty when no direct source supports them.`
        : `\n证据缺口：${pack.coverage.missing.join('、')}。必要路线内容可用专业知识补齐；没有直接来源支持时 source_ids 置为空。`);
    }
  }
  if (pack.warnings.length > 0) {
    pushLine(language === 'en' ? '\nRetrieval notes:' : '\n检索提示：');
    pack.warnings.slice(0, 6).forEach((warning) => pushLine(`- ${warning}`));
  }
  return lines.join('\n\n');
}

function evidenceChunkMaxChars(chunk: EvidenceChunk): number {
  if (chunk.locator === 'document map' || chunk.chunkId?.endsWith(':document-map')) return 2600;
  if (chunk.slot === 'curriculum') return 850;
  if (chunk.slot === 'practice_or_project') return 750;
  return 620;
}

function compactEvidenceText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n').trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.72);
  const tail = Math.max(120, maxChars - head - 18);
  return `${normalized.slice(0, head).trim()}\n...\n${normalized.slice(-tail).trim()}`;
}

function orderRoadmapEvidenceChunks(chunks: EvidenceChunk[]): EvidenceChunk[] {
  const documentMaps = chunks.filter((chunk) => chunk.locator === 'document map' || chunk.chunkId?.endsWith(':document-map'));
  const remaining = chunks.filter((chunk) => !documentMaps.includes(chunk));
  const slotWeight = (chunk: EvidenceChunk): number => {
    if (chunk.slot === 'curriculum') return 3;
    if (chunk.slot === 'practice_or_project') return 2;
    return 1;
  };
  return [
    ...documentMaps,
    ...remaining.sort((a, b) => slotWeight(b) - slotWeight(a) || b.score - a.score),
  ];
}

function sourceTrust(source: SourceRecord): TrustLevel {
  return classifyTrustLevel({
    kind: source.kind,
    host: source.host,
    url: source.url,
    trustScore: source.trustScore,
  });
}
