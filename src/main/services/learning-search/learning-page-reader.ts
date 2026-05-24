import type { EvidenceChunk, LearningSearchCandidate, LearningSourceEvaluation, ResearchTaskType, SourceRecord } from '@shared/types';
import {
  findWebSourceByUrl,
  getSourceChunkCount,
  getSourceChunks,
  upsertWebSource,
} from '../source/source-library';
import { ingestUrlSource, shouldRefreshUrlSource } from '../source/url-ingestion';
import { scheduleSourceSemanticProfile } from '../source/source-semantic-profile';
import { classifyEvidenceSlot } from '../web/evidence-coverage';
import { dedupeAndRankSources } from '../web/source-dedupe';
import { assessSourceRisk, classifyTrustLevel, normalizeUrl, type ScoredSourceCandidate } from '../web/source-authority';
import { persistSourceLearningMetadata } from './learning-source-metadata';
import type { LearningCandidateReadInput, LearningCandidateReadResult } from './types';

function sourceCandidate(candidate: LearningSearchCandidate): ScoredSourceCandidate {
  return {
    title: candidate.title,
    url: candidate.url,
    content: candidate.excerpt,
    score: candidate.rawScore,
    provider: candidate.provider === 'tavily' || candidate.provider === 'exa' ? candidate.provider : 'reflection',
    publishedDate: candidate.publishedDate,
  };
}

function evidenceSlot(candidate: LearningSearchCandidate | undefined, text: string, taskType: ResearchTaskType): string | undefined {
  const haystack = `${candidate?.slotId ?? ''} ${candidate?.query ?? ''} ${candidate?.title ?? ''} ${text}`.toLowerCase();
  if (taskType === 'roadmap') {
    if (/curriculum|syllabus|course|outline|structure|路线|结构|课程|大纲/.test(haystack)) return 'curriculum';
    if (/prerequisite|prior|前置|先修|依赖/.test(haystack)) return 'prerequisites';
    if (/objective|outcome|goal|目标|成果/.test(haystack)) return 'learning_objectives';
    if (/project|practice|assignment|lab|case|项目|实践|作业|案例/.test(haystack)) return 'practice_or_project';
    if (/assessment|exam|rubric|quiz|评估|评分|考核|考试/.test(haystack)) return 'assessment';
  }
  if (taskType === 'practice' || taskType === 'answer') {
    if (/exercise|problem|practice|练习|题目|习题/.test(haystack)) return 'exercise_pattern';
    if (/worked|solution|answer|解析|答案/.test(haystack)) return 'worked_example';
    if (/rubric|assessment|grading|评分|评价/.test(haystack)) return 'rubric';
    if (/beginner|intermediate|advanced|easy|hard|难度|进阶/.test(haystack)) return 'difficulty_progression';
    if (/project|case|real|项目|案例|真实|场景/.test(haystack)) return 'real_world_task';
  }
  if (taskType === 'theory') {
    if (/definition|concept|概念|定义/.test(haystack)) return 'definition';
    if (/principle|fundamental|mechanism|framework|原理|机制|框架/.test(haystack)) return 'principle';
    if (/example|case|示例|例子|案例/.test(haystack)) return 'example';
    if (/mistake|misconception|pitfall|误区|错误/.test(haystack)) return 'common_mistake';
    if (/application|use case|应用|场景/.test(haystack)) return 'application';
  }
  return classifyEvidenceSlot(text, taskType);
}

function annotateChunk(chunk: EvidenceChunk, input: {
  source: SourceRecord;
  candidate?: LearningSearchCandidate;
  taskType: ResearchTaskType;
}): EvidenceChunk {
  return {
    ...chunk,
    slot: chunk.slot ?? evidenceSlot(input.candidate, chunk.text, input.taskType),
    trustLevel: chunk.trustLevel ?? classifyTrustLevel({
      kind: input.source.kind,
      host: input.source.host,
      url: input.source.url,
      trustScore: input.source.trustScore,
    }),
    retrievalMethod: chunk.retrievalMethod ?? 'web',
  };
}

function fallbackChunk(source: SourceRecord, candidate: LearningSearchCandidate, text: string, taskType: ResearchTaskType): EvidenceChunk {
  return annotateChunk({
    sourceId: source.id,
    text: text.slice(0, 1100),
    locator: candidate.provider === 'exa' ? 'semantic excerpt' : 'web excerpt',
    score: source.trustScore,
    sourceKind: source.kind,
    retrievalMethod: 'web',
  }, { source, candidate, taskType });
}

function metaByNormalizedUrl(candidates: LearningSearchCandidate[]): Map<string, LearningSearchCandidate> {
  const map = new Map<string, LearningSearchCandidate>();
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    const existing = map.get(url);
    if (!existing || candidate.rawScore > existing.rawScore || candidate.excerpt.length > existing.excerpt.length) {
      map.set(url, candidate);
    }
  }
  return map;
}

function evaluationByNormalizedUrl(candidates: LearningSearchCandidate[], evaluations: LearningSourceEvaluation[]): Map<string, LearningSourceEvaluation> {
  const out = new Map<string, LearningSourceEvaluation>();
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const evaluation = evaluations[index];
    if (!candidate || !evaluation) continue;
    out.set(normalizeUrl(candidate.url), evaluation);
  }
  return out;
}

function ingestPolicy(evaluation: LearningSourceEvaluation): string {
  if (!evaluation.shouldIngest) return 'discarded';
  if (evaluation.mainEvidence) return 'main_evidence';
  if (evaluation.qualityScore >= 0.55) return 'supplement';
  return 'disabled_low_quality';
}

function riskSummary(candidate: LearningSearchCandidate): string {
  const risk = assessSourceRisk({
    title: candidate.title,
    url: candidate.url,
    content: candidate.excerpt,
    trustScore: candidate.rawScore,
  });
  return risk.reasons.join('；') || risk.level;
}

function fallbackAllowed(input: {
  candidate: LearningSearchCandidate;
  evaluation?: LearningSourceEvaluation;
  rankedTrustScore: number;
}): boolean {
  const risk = assessSourceRisk({
    title: input.candidate.title,
    url: input.candidate.url,
    content: input.candidate.excerpt,
    trustScore: input.rankedTrustScore,
  });
  if (risk.level !== 'low') return false;
  if (!input.evaluation) return input.rankedTrustScore >= 0.78;
  return input.evaluation.mainEvidence
    || input.evaluation.trustLevel === 'official'
    || input.evaluation.trustLevel === 'academic'
    || input.evaluation.trustLevel === 'educational';
}

function metadataSlot(input: LearningCandidateReadInput, evaluation: LearningSourceEvaluation) {
  return input.plan.slots.find((slot) => slot.id === evaluation.slotId);
}

function persistMetadata(input: {
  readInput: LearningCandidateReadInput;
  source: SourceRecord;
  candidate: LearningSearchCandidate;
  evaluation: LearningSourceEvaluation;
}): void {
  persistSourceLearningMetadata({
    source: input.source,
    slot: metadataSlot(input.readInput, input.evaluation),
    evaluation: { ...input.evaluation, sourceId: input.source.id },
    plan: input.readInput.plan,
    query: input.candidate.query,
    ingestPolicy: ingestPolicy(input.evaluation),
  });
}

export async function readLearningSearchCandidates(input: LearningCandidateReadInput): Promise<LearningCandidateReadResult> {
  const warnings: string[] = [];
  const sources = new Map<string, SourceRecord>();
  const chunks: EvidenceChunk[] = [];
  const meta = metaByNormalizedUrl(input.candidates);
  const evals = evaluationByNormalizedUrl(input.candidates, input.evaluations);
  const ranked = dedupeAndRankSources(input.candidates.map(sourceCandidate), {
    query: input.plan.userGoal,
    taskType: input.taskType,
    maxResults: input.maxPagesToFetch + 4,
  });

  let pagesFetched = 0;
  for (const rankedCandidate of ranked) {
    if (chunks.length >= input.maxEvidenceChunks) break;
    const normalizedUrl = normalizeUrl(rankedCandidate.url);
    const candidate = meta.get(normalizedUrl) ?? {
      slotId: input.plan.slots[0]?.id ?? 'general',
      query: input.plan.userGoal,
      title: rankedCandidate.title,
      url: rankedCandidate.url,
      excerpt: rankedCandidate.content,
      provider: rankedCandidate.provider === 'exa' ? 'exa' : 'tavily',
      rawScore: rankedCandidate.score,
      publishedDate: rankedCandidate.publishedDate,
    } satisfies LearningSearchCandidate;
    const evaluation = evals.get(normalizedUrl);
    const risk = assessSourceRisk({
      title: candidate.title,
      url: candidate.url,
      content: candidate.excerpt,
      trustScore: rankedCandidate.trustScore,
    });
    if (risk.level === 'blocked' || risk.level === 'high') {
      warnings.push(`已跳过风险搜索资料：${candidate.title}（${risk.reasons.join('；') || risk.level}）`);
      continue;
    }
    if (evaluation && !evaluation.shouldIngest) {
      warnings.push(`已跳过低质量搜索资料：${candidate.title}（${evaluation.qualityScore.toFixed(2)}，${evaluation.limitations || '不适合自动入库'}）`);
      continue;
    }
    if (input.autoIngest === false && evaluation && !evaluation.mainEvidence) {
      warnings.push(`已按设置跳过补充型搜索资料自动入库：${candidate.title}（${evaluation.qualityScore.toFixed(2)}）`);
      continue;
    }

    const existing = findWebSourceByUrl(input.courseId, normalizedUrl, {
      nodeId: input.nodeId,
      agentType: input.nodeId ? 'sub_tutor' : 'main_tutor',
    });

    if (existing && getSourceChunkCount(existing.id) > 0 && !shouldRefreshUrlSource(existing)) {
      if (evaluation) persistMetadata({ readInput: input, source: existing, candidate, evaluation });
      sources.set(existing.id, existing);
      chunks.push(...getSourceChunks(existing.id, 2).map((chunk) =>
        annotateChunk(chunk, { source: existing, candidate, taskType: input.taskType }),
      ));
      continue;
    }

    if (pagesFetched >= input.maxPagesToFetch) continue;
    pagesFetched++;

    try {
      const outcome = await ingestUrlSource({
        courseId: input.courseId,
        nodeId: input.nodeId,
        scope: input.taskType === 'roadmap' && !input.nodeId ? 'main_private' : undefined,
        origin: 'web_collected',
        title: candidate.title,
        url: normalizedUrl,
        searchExcerpt: candidate.excerpt,
        trustScore: rankedCandidate.trustScore,
        query: candidate.query,
        renderFallback: true,
      });
      warnings.push(...outcome.warnings);
      if (evaluation) persistMetadata({ readInput: input, source: outcome.record, candidate, evaluation });
      sources.set(outcome.record.id, outcome.record);
      const indexedChunks = getSourceChunks(outcome.record.id, 2);
      if (indexedChunks.length > 0) {
        chunks.push(...indexedChunks.map((chunk) =>
          annotateChunk(chunk, { source: outcome.record, candidate, taskType: input.taskType }),
        ));
      } else {
        chunks.push(fallbackChunk(outcome.record, candidate, outcome.content || candidate.excerpt, input.taskType));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!fallbackAllowed({ candidate, evaluation, rankedTrustScore: rankedCandidate.trustScore })) {
        warnings.push(`网页正文读取失败，已跳过搜索摘要 fallback：${candidate.url}（${message}；${riskSummary(candidate)}）`);
        continue;
      }
      warnings.push(`网页正文读取失败，已使用可信搜索摘要：${candidate.url}（${message}）`);
      const source = upsertWebSource({
        courseId: input.courseId,
        nodeId: input.nodeId ?? null,
        scope: input.taskType === 'roadmap' && !input.nodeId ? 'main_private' : undefined,
        origin: 'web_collected',
        title: candidate.title,
        url: normalizedUrl,
        content: [
          `网页资料：${candidate.title}`,
          `来源：${normalizedUrl}`,
          '解析方式：search_excerpt',
          `资料槽位：${candidate.slotId}`,
          '',
          '## 搜索摘要',
          candidate.excerpt,
        ].join('\n'),
        trustScore: Math.min(rankedCandidate.trustScore, 0.62),
      });
      scheduleSourceSemanticProfile(source.id, { delayMs: 250 });
      if (evaluation) persistMetadata({ readInput: input, source, candidate, evaluation });
      sources.set(source.id, source);
      chunks.push(fallbackChunk(source, candidate, candidate.excerpt, input.taskType));
    }
  }

  return {
    sources: [...sources.values()],
    chunks: chunks.slice(0, input.maxEvidenceChunks),
    pagesFetched,
    warnings,
  };
}
