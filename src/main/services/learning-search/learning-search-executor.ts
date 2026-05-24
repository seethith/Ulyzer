import type { LearningSearchCandidate, LearningSourceSlot } from '@shared/types';
import { exaSearch } from '../web/exa';
import { lowQualityDomainsFor } from '../web/source-authority';
import { tavilySearch } from '../web/tavily';
import type { LearningSearchExecutionInput, LearningSearchExecutionResult } from './types';
import { sortSlotsForSearch } from './types';

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function candidateKey(candidate: Pick<LearningSearchCandidate, 'url'>): string {
  try {
    const parsed = new URL(candidate.url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^mc_/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return candidate.url.trim();
  }
}

function chooseQueries(slots: LearningSourceSlot[], maxQueries: number): Array<{ slot: LearningSourceSlot; query: string }> {
  if (maxQueries <= 0) return [];
  const ordered = sortSlotsForSearch(slots);
  const out: Array<{ slot: LearningSourceSlot; query: string }> = [];

  for (const slot of ordered) {
    const query = normalizeQuery(slot.queryIntents[0] ?? '');
    if (!query) continue;
    out.push({ slot, query });
    if (out.length >= maxQueries) return out;
  }

  for (const slot of ordered) {
    for (const queryText of slot.queryIntents.slice(1)) {
      const query = normalizeQuery(queryText);
      if (!query || out.some((item) => item.query.toLowerCase() === query.toLowerCase())) continue;
      out.push({ slot, query });
      if (out.length >= maxQueries) return out;
    }
  }

  return out;
}

function pushCandidate(target: LearningSearchCandidate[], candidate: LearningSearchCandidate): void {
  if (!candidate.url) return;
  const key = candidateKey(candidate);
  const existingIndex = target.findIndex((item) => candidateKey(item) === key);
  if (existingIndex < 0) {
    target.push(candidate);
    return;
  }
  if (candidate.rawScore > target[existingIndex].rawScore || candidate.excerpt.length > target[existingIndex].excerpt.length) {
    target[existingIndex] = candidate;
  }
}

export async function executeLearningSearchPlan(input: LearningSearchExecutionInput): Promise<LearningSearchExecutionResult> {
  const selectedQueries = chooseQueries(input.plan.slots, input.maxQueries);
  const warnings: string[] = [];
  const candidates: LearningSearchCandidate[] = [];

  await Promise.all(selectedQueries.map(async ({ slot, query }) => {
    const excludeDomains = lowQualityDomainsFor(query);
    const [tavilyRes, exaRes] = await Promise.all([
      tavilySearch(query, {
        searchDepth: input.searchDepth,
        excludeDomains,
        maxResults: input.maxResultsPerQuery,
      }).catch((err) => {
        warnings.push(`Tavily search unavailable for "${query}": ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] };
      }),
      input.useExa === false
        ? Promise.resolve({ results: [] })
        : exaSearch(query, {
          numResults: input.maxResultsPerQuery,
          useAutoprompt: true,
          excludeDomains,
        }).catch((err) => {
          warnings.push(`Exa search unavailable for "${query}": ${err instanceof Error ? err.message : String(err)}`);
          return { results: [] };
        }),
    ]);

    for (const result of tavilyRes.results) {
      if (!result.url) continue;
      pushCandidate(candidates, {
        slotId: slot.id,
        query,
        title: result.title,
        url: result.url,
        excerpt: result.content,
        provider: 'tavily',
        rawScore: result.score,
        publishedDate: result.publishedDate,
      });
    }

    for (const result of exaRes.results) {
      if (!result.url) continue;
      pushCandidate(candidates, {
        slotId: slot.id,
        query,
        title: result.title,
        url: result.url,
        excerpt: result.text,
        provider: 'exa',
        rawScore: result.score,
        publishedDate: result.publishedDate,
      });
    }
  }));

  return {
    candidates,
    queriesUsed: selectedQueries.map(({ slot, query }) => ({ slotId: slot.id, slotName: slot.name, query })),
    warnings,
  };
}
