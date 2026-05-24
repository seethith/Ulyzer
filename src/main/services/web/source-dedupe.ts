import type { ResearchTaskType } from '@shared/types';
import { normalizeUrl, scoreSourceCandidate, type ScoredSourceCandidate } from './source-authority';

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .slice(0, 80),
  );
}

function overlap(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function dedupeAndRankSources(
  candidates: ScoredSourceCandidate[],
  input: { query: string; taskType: ResearchTaskType; maxResults: number },
): Array<ScoredSourceCandidate & { normalizedUrl: string; trustLevel: ReturnType<typeof scoreSourceCandidate>['trustLevel']; trustScore: number }> {
  const byUrl = new Map<string, ScoredSourceCandidate>();
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    const normalizedUrl = normalizeUrl(candidate.url);
    const existing = byUrl.get(normalizedUrl);
    if (!existing || candidate.score > existing.score || candidate.content.length > existing.content.length) {
      byUrl.set(normalizedUrl, candidate);
    }
  }

  const scored = [...byUrl.entries()].map(([normalizedUrl, candidate]) => {
    const scoredCandidate = scoreSourceCandidate(candidate, input.taskType, input.query);
    return {
      ...candidate,
      normalizedUrl,
      trustLevel: scoredCandidate.trustLevel,
      trustScore: scoredCandidate.score,
    };
  }).sort((a, b) => b.trustScore - a.trustScore);

  const selected: typeof scored = [];
  const hostCounts = new Map<string, number>();
  for (const candidate of scored) {
    const candidateHost = host(candidate.normalizedUrl);
    const hostLimit = candidate.trustLevel === 'official' ? 3 : 2;
    if ((hostCounts.get(candidateHost) ?? 0) >= hostLimit) continue;
    const isNearDuplicate = selected.some((item) =>
      overlap(`${item.title}\n${item.content.slice(0, 1000)}`, `${candidate.title}\n${candidate.content.slice(0, 1000)}`) > 0.75,
    );
    if (isNearDuplicate) continue;
    selected.push(candidate);
    hostCounts.set(candidateHost, (hostCounts.get(candidateHost) ?? 0) + 1);
    if (selected.length >= input.maxResults) break;
  }
  return selected;
}
