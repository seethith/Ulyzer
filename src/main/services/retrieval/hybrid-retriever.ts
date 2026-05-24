import type { ResearchTaskType, SourceRecord } from '@shared/types';
import { classifyTrustLevel } from '../web/source-authority';
import { markSourcesUsed } from '../source/source-library';
import { lexicalRetrieve } from './lexical-retriever';
import { rerankCandidates } from './reranker';
import { rerankWithLlm } from './llm-reranker';
import type { RetrievalCandidate, RetrievalQuery, RetrievalResult } from './types';
import { vectorRetrieve } from './vector-retriever';

function mergeCandidates(lexical: RetrievalCandidate[], vector: RetrievalCandidate[]): RetrievalCandidate[] {
  const byChunk = new Map<string, RetrievalCandidate>();
  for (const candidate of lexical) byChunk.set(candidate.chunkId, { ...candidate });
  for (const candidate of vector) {
    const existing = byChunk.get(candidate.chunkId);
    if (existing) {
      byChunk.set(candidate.chunkId, {
        ...existing,
        vectorScore: candidate.vectorScore,
        retrievalMethod: 'hybrid',
      });
    } else {
      byChunk.set(candidate.chunkId, { ...candidate });
    }
  }
  return [...byChunk.values()];
}

export async function hybridRetrieve(input: RetrievalQuery): Promise<RetrievalResult> {
  const taskType: ResearchTaskType = input.taskType ?? 'chat';
  const limit = Math.min(input.limit ?? 8, 20);
  const candidateLimit = input.llmRerank ? Math.min(40, Math.max(30, limit * 4)) : limit;
  const lexical = lexicalRetrieve({ ...input, limit: candidateLimit });
  const vector = await vectorRetrieve({ ...input, limit: candidateLimit });
  const sourceMap = new Map<string, SourceRecord>();
  for (const source of [...lexical.sources, ...vector.sources]) sourceMap.set(source.id, source);

  const merged = mergeCandidates(lexical.candidates, vector.candidates);
  let reranked: RetrievalCandidate[] = rerankCandidates({
    query: input.query,
    taskType,
    candidates: merged,
    sources: sourceMap,
    limit: candidateLimit,
  }).map((candidate) => {
    const source = sourceMap.get(candidate.sourceId);
    return {
      ...candidate,
      score: candidate.finalScore,
      retrievalMethod: candidate.lexicalScore !== undefined && candidate.vectorScore !== undefined
        ? 'hybrid'
        : candidate.retrievalMethod,
      trustLevel: classifyTrustLevel({
        kind: source?.kind ?? candidate.sourceKind,
        host: source?.host,
        url: source?.url,
        trustScore: source?.trustScore ?? candidate.score,
      }),
    } satisfies RetrievalCandidate;
  });

  if (input.llmRerank && input.rerankProvider && input.rerankModel && reranked.length > limit) {
    const llmReranked = await rerankWithLlm({
      query: input.query,
      taskType,
      candidates: reranked,
      sources: sourceMap,
      limit,
      provider: input.rerankProvider,
      model: input.rerankModel,
      signal: input.signal,
      onUsage: input.onUsage,
    });
    reranked = llmReranked.length > 0 ? llmReranked : reranked.slice(0, limit);
  } else {
    reranked = reranked.slice(0, limit);
  }

  const usedSourceIds = reranked.map((candidate) => candidate.sourceId);
  markSourcesUsed(usedSourceIds);

  return {
    candidates: reranked,
    sources: [...sourceMap.values()].filter((source) => reranked.some((candidate) => candidate.sourceId === source.id)),
    method: vector.candidates.length > 0 ? 'hybrid' : 'lexical',
  };
}
