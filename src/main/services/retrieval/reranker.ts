import type { ResearchTaskType, SourceRecord } from '@shared/types';
import { classifyEvidenceSlot } from '../web/evidence-coverage';
import type { RetrievalCandidate } from './types';

function tokenOverlap(query: string, text: string): number {
  const qTokens = new Set(query.toLowerCase().split(/\s+/).filter((token) => token.length > 2));
  if (qTokens.size === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const token of qTokens) if (haystack.includes(token)) hits++;
  return hits / qTokens.size;
}

function originWeight(source: SourceRecord | undefined): number {
  if (!source) return 0;
  if (source.linkedToNode || source.scope === 'node_private') return 0.08;
  switch (source.origin) {
    case 'user_import': return 0.07;
    case 'chat_attachment': return 0.04;
    case 'ai_generated': return -0.01;
    case 'web_collected': return source.enabled ? -0.03 : -0.08;
    default: return 0;
  }
}

export function rerankCandidates(input: {
  query: string;
  taskType: ResearchTaskType;
  candidates: RetrievalCandidate[];
  sources: Map<string, SourceRecord>;
  limit: number;
}): RetrievalCandidate[] {
  const sourceCounts = new Map<string, number>();
  return input.candidates
    .map((candidate) => {
      const source = input.sources.get(candidate.sourceId);
      const lexical = candidate.lexicalScore ?? 0;
      const vector = candidate.vectorScore ?? 0;
      const sourceTrust = source?.trustScore ?? 0.5;
      const overlap = tokenOverlap(input.query, `${candidate.headingPath?.join(' ') ?? ''}\n${candidate.text.slice(0, 1000)}`);
      const slot = candidate.slot ?? classifyEvidenceSlot(candidate.text, input.taskType);
      const slotBonus = slot ? 0.08 : 0;
      const lengthPenalty = candidate.text.length < 120 ? -0.05 : 0;
      const hitCount = source?.hitCount ?? 0;
      const hotSourceBonus =
        source?.linkedToNode || source?.scope === 'node_private'
          ? 0.05
          : hitCount >= 3
            ? 0.04
            : sourceTrust >= 0.88
              ? 0.02
              : 0;
      const coldSourcePenalty =
        hitCount === 0
        && (source?.kind === 'web' || source?.origin === 'web_collected')
        && sourceTrust < 0.72
          ? -0.05
          : 0;
      const rerankScore = overlap * 0.1 + slotBonus + lengthPenalty + hotSourceBonus + coldSourcePenalty + originWeight(source);
      return {
        ...candidate,
        slot,
        rerankScore,
        finalScore: lexical * 0.42 + vector * 0.42 + sourceTrust * 0.12 + rerankScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .filter((candidate) => {
      const count = sourceCounts.get(candidate.sourceId) ?? 0;
      if (count >= 3) return false;
      sourceCounts.set(candidate.sourceId, count + 1);
      return true;
    })
    .slice(0, input.limit);
}
