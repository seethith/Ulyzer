import type {
  EvidenceChunk,
  EvidencePack,
  ResearchBudgetUsed,
  ResearchTaskType,
  SearchMode,
  SourceRecord,
} from '@shared/types';
import { hybridRetrieve } from '../retrieval/hybrid-retriever';
import { classifyEvidenceSlot, evaluateEvidenceCoverage, formatCoverageWarning } from '../web/evidence-coverage';
import { buildResearchBudget, inferResearchTaskType, type ResearchBudget } from '../web/research-budget';
import { assessSourceRisk, classifySourceTier, classifyTrustLevel, normalizeUrl } from '../web/source-authority';
import { executeLearningSearchPlan } from './learning-search-executor';
import { readLearningSearchCandidates } from './learning-page-reader';
import { readLearningSearchSettings, type LearningSearchRuntimeSettings } from './learning-search-settings';
import { evaluateLearningCandidates } from './learning-source-evaluator';
import { runLearningGapSearch } from './learning-gap-search';
import { planLearningSources } from './learning-source-planner';
import type { CollectLearningSourcesInput, LearningSearchResult } from './types';

function annotateLocalChunk(chunk: EvidenceChunk, taskType: ResearchTaskType, source?: SourceRecord): EvidenceChunk {
  return {
    ...chunk,
    slot: chunk.slot ?? classifyEvidenceSlot(chunk.text, taskType),
    trustLevel: chunk.trustLevel ?? classifyTrustLevel({
      kind: source?.kind ?? chunk.sourceKind,
      host: source?.host,
      url: source?.url,
      trustScore: source?.trustScore ?? chunk.score,
    }),
  };
}

function makePack(input: {
  query: string;
  taskType: ResearchTaskType;
  sources: SourceRecord[];
  chunks: EvidenceChunk[];
  warnings: string[];
  budgetUsed: ResearchBudgetUsed;
  language?: string;
  plan?: LearningSearchResult['plan'];
}): LearningSearchResult {
  const coverage = evaluateEvidenceCoverage(input.taskType, input.chunks);
  const coverageWarning = formatCoverageWarning(coverage, input.language);
  return {
    query: input.query,
    taskType: input.taskType,
    sources: input.sources,
    chunks: input.chunks,
    coverage,
    budgetUsed: input.budgetUsed,
    warnings: coverageWarning ? [...input.warnings, coverageWarning] : input.warnings,
    plan: input.plan,
  };
}

function localEvidenceIsEnough(input: {
  mode: CollectLearningSourcesInput['mode'];
  chunks: EvidenceChunk[];
  missingCount: number;
  sources: Map<string, SourceRecord>;
}): boolean {
  if (input.mode !== 'auto') return false;
  if (input.chunks.length < 3) return false;
  const trustedChunks = input.chunks.filter((chunk) => {
    const source = input.sources.get(chunk.sourceId);
    if (!source) return false;
    if (source.kind === 'generated' || source.origin === 'ai_generated') return false;
    const risk = assessSourceRisk({
      title: source.title,
      url: source.url,
      kind: source.kind,
      origin: source.origin,
      host: source.host,
      filePath: source.filePath,
      originalPath: source.originalPath,
      trustScore: source.trustScore,
    });
    if (risk.level === 'blocked' || risk.level === 'high') return false;
    const tier = classifySourceTier(source);
    return source.trustScore >= 0.72
      || tier === 'canonical'
      || tier === 'vetted_education'
      || tier === 'scholarly';
  });
  const topScore = Math.max(...trustedChunks.map((chunk) => chunk.score ?? 0), 0);
  const trustedSourceCount = new Set(trustedChunks.map((chunk) => chunk.sourceId)).size;
  return trustedChunks.length >= 2
    && trustedSourceCount >= 1
    && topScore >= 0.7
    && input.missingCount <= 1;
}

function normalizeSourceTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\da-z\u4e00-\u9fff]+/gi, '')
    .slice(0, 80);
}

function sourceDedupeKeys(source: SourceRecord): string[] {
  const keys: string[] = [];
  if (source.url) keys.push(`url:${normalizeUrl(source.url)}`);
  const titleKey = normalizeSourceTitle(source.title);
  if (titleKey.length >= 8) keys.push(`title:${titleKey}`);
  return keys;
}

function sortSources(sources: SourceRecord[]): SourceRecord[] {
  const tierWeight: Record<ReturnType<typeof classifySourceTier>, number> = {
    canonical: 8,
    vetted_education: 7,
    scholarly: 6,
    library_upload: 5,
    supplemental: 4,
    community: 2,
    library_generated: 1,
    unknown: 0,
    risky: -4,
  };
  const ranked = [...sources]
    .filter((source) => assessSourceRisk({
      title: source.title,
      url: source.url,
      kind: source.kind,
      origin: source.origin,
      host: source.host,
      filePath: source.filePath,
      originalPath: source.originalPath,
      trustScore: source.trustScore,
    }).level !== 'blocked')
    .sort((a, b) => {
      const tierDelta = tierWeight[classifySourceTier(b)] - tierWeight[classifySourceTier(a)];
      return tierDelta || b.trustScore - a.trustScore;
    });

  const seen = new Set<string>();
  const deduped: SourceRecord[] = [];
  for (const source of ranked) {
    const keys = sourceDedupeKeys(source);
    if (keys.length > 0 && keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    deduped.push(source);
    if (deduped.length >= 10) break;
  }
  return deduped;
}

function applySearchSettings(input: {
  budget: ResearchBudget;
  settings: LearningSearchRuntimeSettings;
  taskType: ResearchTaskType;
}): ResearchBudget {
  const { budget, settings, taskType } = input;
  if (budget.maxQueries <= 0 || budget.maxPagesToFetch <= 0) return budget;

  const deepQueries = taskType === 'roadmap' || taskType === 'practice' || taskType === 'answer' ? 6 : 5;
  const deepPages = taskType === 'roadmap' || taskType === 'practice' || taskType === 'answer' ? 6 : 5;
  const desiredQueries = settings.depth === 'economy'
    ? 2
    : settings.depth === 'deep'
      ? Math.max(budget.maxQueries, deepQueries)
      : budget.maxQueries;
  const desiredPages = settings.depth === 'economy'
    ? 2
    : settings.depth === 'deep'
      ? Math.max(budget.maxPagesToFetch, deepPages)
      : budget.maxPagesToFetch;
  const maxResultsPerQuery = settings.depth === 'economy'
    ? Math.min(budget.maxResultsPerQuery, 2)
    : settings.depth === 'deep'
      ? Math.max(budget.maxResultsPerQuery, 4)
      : budget.maxResultsPerQuery;

  return {
    ...budget,
    maxQueries: Math.max(0, Math.min(desiredQueries, settings.maxQueries)),
    maxPagesToFetch: Math.max(0, Math.min(desiredPages, settings.maxPages)),
    maxResultsPerQuery: Math.max(1, Math.min(maxResultsPerQuery, settings.depth === 'deep' ? 5 : 4)),
    maxEvidenceChunks: settings.depth === 'economy'
      ? Math.min(budget.maxEvidenceChunks, 6)
      : settings.depth === 'deep'
        ? Math.max(budget.maxEvidenceChunks, 14)
        : budget.maxEvidenceChunks,
    allowReflectionSearch: budget.allowReflectionSearch || settings.depth === 'deep',
  };
}

function resolveSearchDepth(mode: SearchMode, settings: LearningSearchRuntimeSettings): 'basic' | 'advanced' {
  if (settings.depth === 'economy') return 'basic';
  if (settings.tavilyAdvanced || settings.depth === 'deep') return 'advanced';
  return mode === 'web' ? 'advanced' : 'basic';
}

function formatPlanTrace(plan: LearningSearchResult['plan'], settings: LearningSearchRuntimeSettings, budget: ResearchBudget, language?: string): string | null {
  if (!plan) return null;
  const slots = plan.slots.map((slot) => `${slot.name}${slot.mustHave ? '*' : ''}`).join(language === 'en' ? ', ' : '、');
  return language === 'en'
    ? `Learning source plan: ${plan.learningShape}; slots ${slots}; budget ${settings.depth}, up to ${budget.maxQueries} queries / ${budget.maxPagesToFetch} pages.`
    : `学习资料规划：${plan.learningShape}；槽位 ${slots}；预算 ${settings.depth}，最多 ${budget.maxQueries} 次查询 / ${budget.maxPagesToFetch} 页读取。`;
}

function emitProgress(input: CollectLearningSourcesInput, zh: string, en: string): void {
  input.onProgress?.((input.language === 'en' ? en : zh) + '\n');
}

export async function collectLearningSources(input: CollectLearningSourcesInput): Promise<EvidencePack> {
  const mode = input.mode ?? 'auto';
  const taskType = input.taskType ?? inferResearchTaskType(input.query);
  const searchSettings = readLearningSearchSettings();
  const budget = applySearchSettings({
    budget: buildResearchBudget({ mode, taskType, maxWebResults: input.maxWebResults }),
    settings: searchSettings,
    taskType,
  });
  const sourceMap = new Map<string, SourceRecord>();
  const chunks: EvidenceChunk[] = [];
  const warnings: string[] = [];
  const budgetUsed: ResearchBudgetUsed = {
    queries: 0,
    pagesFetched: 0,
    reflectionSearches: 0,
    llmReranks: 0,
  };

  if (mode === 'auto' || mode === 'library') {
    emitProgress(input, '检索阶段：正在查询本地参考库/已导入资料…', 'Retrieval: searching local source library/imported material...');
    const library = await hybridRetrieve({
      courseId: input.courseId,
      nodeId: input.nodeId,
      agentType: input.nodeId ? 'sub_tutor' : 'main_tutor',
      query: input.query,
      taskType,
      limit: Math.min(6, budget.maxEvidenceChunks),
      llmRerank: taskType === 'roadmap' || mode === 'library',
      rerankProvider: input.provider,
      rerankModel: input.model,
      signal: input.signal,
      onUsage: input.onUsage,
    });
    const sourceById = new Map(library.sources.map((source) => [source.id, source]));
    library.sources.forEach((source) => sourceMap.set(source.id, source));
    chunks.push(...library.candidates.map((chunk) => annotateLocalChunk(chunk, taskType, sourceById.get(chunk.sourceId))));
    emitProgress(input,
      `检索阶段：本地参考库命中 ${library.sources.length} 个来源、${library.candidates.length} 个片段。`,
      `Retrieval: local library matched ${library.sources.length} source(s), ${library.candidates.length} snippet(s).`,
    );
  }

  if (mode === 'off') {
    warnings.push('Search is off for this request.');
    return makePack({ query: input.query, taskType, sources: [], chunks: [], warnings, budgetUsed, language: input.language });
  }

  if (mode === 'library') {
    if (sourceMap.size === 0) warnings.push('No enabled library sources matched this request.');
    return makePack({
      query: input.query,
      taskType,
      sources: sortSources([...sourceMap.values()]),
      chunks: chunks.slice(0, budget.maxEvidenceChunks),
      warnings,
      budgetUsed,
      language: input.language,
    });
  }

  const localCoverage = evaluateEvidenceCoverage(taskType, chunks);
  if (localEvidenceIsEnough({ mode, chunks, sources: sourceMap, missingCount: localCoverage.missing.length })) {
    warnings.push(input.language === 'en'
      ? 'Local source library evidence was sufficient; web search was skipped to save cost.'
      : '参考库证据已足够，自动模式已跳过联网以节省开销。');
    return makePack({
      query: input.query,
      taskType,
      sources: sortSources([...sourceMap.values()]),
      chunks: chunks.slice(0, budget.maxEvidenceChunks),
      warnings,
      budgetUsed,
      language: input.language,
    });
  }

  emitProgress(input,
    '检索阶段：正在规划资料槽位和查询词…',
    'Retrieval: planning source slots and queries...',
  );
  const plan = await planLearningSources({
    courseId: input.courseId,
    nodeId: input.nodeId,
    taskType,
    userGoal: input.userGoal || input.query,
    searchMode: mode,
    language: input.language,
    provider: input.provider,
    model: input.model,
    plannedQueries: input.plannedQueries,
    signal: input.signal,
    onUsage: input.onUsage,
  });
  const planTrace = formatPlanTrace(plan, searchSettings, budget, input.language);
  if (planTrace) warnings.push(planTrace);
  emitProgress(input,
    `检索阶段：资料需求规划完成，准备执行最多 ${budget.maxQueries} 个查询。`,
    `Retrieval: source plan ready, running up to ${budget.maxQueries} query(s).`,
  );

  const execution = await executeLearningSearchPlan({
    plan,
    taskType,
    maxQueries: budget.maxQueries,
    maxResultsPerQuery: budget.maxResultsPerQuery,
    searchDepth: resolveSearchDepth(mode, searchSettings),
    useExa: searchSettings.useExa,
    signal: input.signal,
  });
  budgetUsed.queries += execution.queriesUsed.length;
  warnings.push(input.language === 'en'
    ? `Search execution: ${execution.queriesUsed.length} queries, ${execution.candidates.length} candidates; Exa ${searchSettings.useExa ? 'on' : 'off'}, Tavily ${resolveSearchDepth(mode, searchSettings)}.`
    : `搜索执行：${execution.queriesUsed.length} 个查询，获得 ${execution.candidates.length} 个候选；Exa ${searchSettings.useExa ? '开启' : '关闭'}，Tavily ${resolveSearchDepth(mode, searchSettings)}。`);
  warnings.push(...execution.warnings);
  emitProgress(input,
    `检索阶段：搜索返回 ${execution.candidates.length} 个候选，开始质量评分。`,
    `Retrieval: search returned ${execution.candidates.length} candidate(s), scoring quality.`,
  );
  if (mode === 'web' && execution.queriesUsed.length > 0 && execution.candidates.length === 0) {
    warnings.push('Forced web search returned no web candidates. Check Tavily/Exa API keys or query wording.');
  }
  const evaluated = await evaluateLearningCandidates({
    candidates: execution.candidates,
    plan,
    taskType,
    provider: input.provider,
    model: input.model,
    allowCommunityAutoImport: searchSettings.allowCommunityAutoImport,
    language: input.language,
    signal: input.signal,
    onUsage: input.onUsage,
  });
  warnings.push(...evaluated.warnings);
  warnings.push(input.language === 'en'
    ? `Quality scoring: ${evaluated.evaluations.filter((item) => item.mainEvidence).length} main, ${evaluated.evaluations.filter((item) => item.shouldIngest).length} ingestible, ${evaluated.evaluations.filter((item) => !item.shouldIngest).length} skipped.`
    : `质量评分：主依据 ${evaluated.evaluations.filter((item) => item.mainEvidence).length} 条，可入库 ${evaluated.evaluations.filter((item) => item.shouldIngest).length} 条，跳过 ${evaluated.evaluations.filter((item) => !item.shouldIngest).length} 条。`);
  if (input.provider && input.model && execution.candidates.length > 0) budgetUsed.llmReranks += 1;
  emitProgress(input,
    `检索阶段：质量评分完成，主依据 ${evaluated.evaluations.filter((item) => item.mainEvidence).length} 条，开始读取页面。`,
    `Retrieval: quality scoring complete, ${evaluated.evaluations.filter((item) => item.mainEvidence).length} main source(s), reading pages.`,
  );

  const allowGapSearch = mode === 'web'
    || budget.allowReflectionSearch
    || taskType === 'roadmap'
    || taskType === 'practice'
    || taskType === 'answer';
  const reservePagesForGap = allowGapSearch ? 1 : 0;
  const initialMaxPages = Math.max(0, budget.maxPagesToFetch - reservePagesForGap);

  const read = await readLearningSearchCandidates({
    candidates: execution.candidates,
    evaluations: evaluated.evaluations,
    plan,
    courseId: input.courseId,
    nodeId: input.nodeId,
    taskType,
    maxPagesToFetch: initialMaxPages,
    maxEvidenceChunks: Math.max(0, budget.maxEvidenceChunks - chunks.length),
    autoIngest: searchSettings.autoIngest,
  });
  budgetUsed.pagesFetched += read.pagesFetched;
  emitProgress(input,
    `检索阶段：读取 ${read.pagesFetched}/${budget.maxPagesToFetch} 页，形成 ${read.chunks.length} 个片段。`,
    `Retrieval: fetched ${read.pagesFetched}/${budget.maxPagesToFetch} pages, produced ${read.chunks.length} snippet(s).`,
  );
  warnings.push(input.language === 'en'
    ? `Page reading: fetched ${read.pagesFetched}/${budget.maxPagesToFetch} pages, produced ${read.chunks.length} snippets.`
    : `网页读取：读取 ${read.pagesFetched}/${budget.maxPagesToFetch} 页，形成 ${read.chunks.length} 个片段。`);
  warnings.push(...read.warnings);
  read.sources.forEach((source) => sourceMap.set(source.id, source));
  chunks.push(...read.chunks);

  let allEvaluations = evaluated.evaluations;
  if (allowGapSearch && budgetUsed.pagesFetched < budget.maxPagesToFetch) {
    const remainingQueries = Math.max(0, Math.min(2, budget.maxQueries - budgetUsed.queries));
    const gap = await runLearningGapSearch({
      plan,
      evaluations: allEvaluations,
      taskType,
      maxQueries: remainingQueries,
      maxResultsPerQuery: Math.min(3, budget.maxResultsPerQuery),
      searchDepth: resolveSearchDepth(mode, searchSettings),
      useExa: searchSettings.useExa,
      signal: input.signal,
    });
    if (gap.queriesUsed.length > 0) {
      budgetUsed.reflectionSearches += gap.queriesUsed.length;
      budgetUsed.queries += gap.queriesUsed.length;
      warnings.push(input.language === 'en'
        ? `Follow-up search for gaps: ${gap.missingSlots.map((slot) => slot.name).join(', ')}`
        : `已针对资料缺口补搜：${gap.missingSlots.map((slot) => slot.name).join('、')}`);
      warnings.push(...gap.warnings);
      const gapEvaluated = await evaluateLearningCandidates({
        candidates: gap.candidates,
        plan,
        taskType,
        provider: input.provider,
        model: input.model,
        allowCommunityAutoImport: searchSettings.allowCommunityAutoImport,
        language: input.language,
        signal: input.signal,
        onUsage: input.onUsage,
      });
      warnings.push(...gapEvaluated.warnings);
      if (input.provider && input.model && gap.candidates.length > 0) budgetUsed.llmReranks += 1;
      allEvaluations = [...allEvaluations, ...gapEvaluated.evaluations];
      const gapRead = await readLearningSearchCandidates({
        candidates: gap.candidates,
        evaluations: gapEvaluated.evaluations,
        plan,
        courseId: input.courseId,
        nodeId: input.nodeId,
        taskType,
        maxPagesToFetch: Math.max(0, budget.maxPagesToFetch - budgetUsed.pagesFetched),
        maxEvidenceChunks: Math.max(0, budget.maxEvidenceChunks - chunks.length),
        autoIngest: searchSettings.autoIngest,
      });
      budgetUsed.pagesFetched += gapRead.pagesFetched;
      emitProgress(input,
        `检索阶段：补搜读取 ${gapRead.pagesFetched} 页，新增 ${gapRead.chunks.length} 个片段。`,
        `Retrieval: follow-up fetched ${gapRead.pagesFetched} page(s), added ${gapRead.chunks.length} snippet(s).`,
      );
      warnings.push(input.language === 'en'
        ? `Gap reading: fetched ${gapRead.pagesFetched} page(s), produced ${gapRead.chunks.length} snippets.`
        : `缺口补搜读取：读取 ${gapRead.pagesFetched} 页，形成 ${gapRead.chunks.length} 个片段。`);
      warnings.push(...gapRead.warnings);
      gapRead.sources.forEach((source) => sourceMap.set(source.id, source));
      chunks.push(...gapRead.chunks);
    }
  }

  if (mode === 'web' && read.sources.length === 0) {
    warnings.push('Forced web search returned no usable sources.');
  }

  const sortedSources = sortSources([...sourceMap.values()]);
  const selectedSourceIds = new Set(sortedSources.map((source) => source.id));
  return makePack({
    query: input.query,
    taskType,
    sources: sortedSources,
    chunks: chunks.filter((chunk) => selectedSourceIds.has(chunk.sourceId)).slice(0, budget.maxEvidenceChunks),
    warnings,
    budgetUsed,
    language: input.language,
    plan,
  });
}
