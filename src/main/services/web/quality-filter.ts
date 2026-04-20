import type { TavilyResult } from './tavily';

// ── Domain trust scores ───────────────────────────────────────────────────────
// Higher = more authoritative. Applied as a multiplier on Tavily's own score.

const TRUSTED_DOMAINS: Array<[RegExp, number]> = [
  // Official language / framework docs
  [/\.(dev|io)$/, 0.9],
  [/developer\.mozilla\.org/, 1.0],
  [/docs\.python\.org/, 1.0],
  [/react\.dev/, 1.0],
  [/vuejs\.org/, 1.0],
  [/docs\.rs/, 1.0],
  [/golang\.org|go\.dev/, 1.0],
  [/developer\.apple\.com/, 0.95],
  [/developer\.android\.com/, 0.95],
  [/docs\.microsoft\.com|learn\.microsoft\.com/, 0.95],
  [/docs\.github\.com|github\.com/, 0.85],
  // Practice platforms with server-rendered content (Tavily-friendly)
  [/geeksforgeeks\.org/, 0.88],
  [/w3schools\.com/, 0.82],
  [/programiz\.com/, 0.80],
  [/khanacademy\.org/, 0.85],
  [/brilliant\.org/, 0.82],
  // Q&A / community
  [/stackoverflow\.com/, 0.82],
  [/stackexchange\.com/, 0.78],
  // Tech blogs
  [/dev\.to/, 0.65],
  [/css-tricks\.com/, 0.7],
  [/smashingmagazine\.com/, 0.7],
  // Creative / lifestyle skills
  [/instructables\.com/, 0.85],
  [/wikihow\.com/, 0.80],
  [/domestika\.org/, 0.85],
  [/musictheory\.net/, 0.88],
  [/ultimate-guitar\.com/, 0.82],
  [/digital-photography-school\.com/, 0.80],
  [/drawabox\.com/, 0.82],
  // Business / management
  [/hbr\.org/, 0.92],
  [/mckinsey\.com/, 0.90],
  [/investopedia\.com/, 0.88],
  [/mindtools\.com/, 0.82],
  // Sports / fitness
  [/nasm\.org/, 0.90],
  [/acefitness\.org/, 0.90],
  [/runnersworld\.com/, 0.82],
  [/mayoclinic\.org/, 0.92],
  [/verywellfit\.com/, 0.80],
  // Social sciences / humanities
  [/britannica\.com/, 0.90],
  [/plato\.stanford\.edu/, 0.95],
  [/simplypsychology\.org/, 0.82],
  [/philosophybasics\.com/, 0.78],
  // General quality education
  [/coursera\.org/, 0.85],
  [/ocw\.mit\.edu/, 0.92],
  // Generic blog platforms (lower trust)
  [/medium\.com/, 0.52],
  [/substack\.com/, 0.5],
  [/zhihu\.com/, 0.55],
  [/juejin\.cn/, 0.6],
  [/segmentfault\.com/, 0.6],
  // Video
  [/youtube\.com|youtu\.be/, 0.7],
];

function domainScore(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const [pattern, score] of TRUSTED_DOMAINS) {
      if (pattern.test(host)) return score;
    }
    return 0.5; // unknown domain — neutral
  } catch {
    return 0.3;
  }
}

export interface FilteredResult {
  title: string;
  url: string;
  content: string;
  /** Combined trust score (0-1). Higher = more reliable. */
  trustScore: number;
  publishedDate?: string;
}

// Answer-keyword detection for practice mode
const ANSWER_KEYWORDS_RE = /answer[:\s]|solution[:\s]|答案|解析|解答|explanation[:\s]|step.by.step/i;

/**
 * Score and filter Tavily results by domain trust × relevance score.
 * Results below minTrustScore are discarded.
 *
 * mode='practice': boosts results containing answers/solutions (+30%),
 * penalises question-only results without answers (-30%).
 */
export function filterByQuality(
  results: TavilyResult[],
  minTrustScore = 0.35,
  mode: 'standard' | 'practice' = 'standard',
): FilteredResult[] {
  return results
    .map((r) => {
      let trust = domainScore(r.url) * (r.score ?? 1);
      if (mode === 'practice') {
        trust *= ANSWER_KEYWORDS_RE.test(r.content) ? 1.3 : 0.7;
      }
      return {
        title: r.title,
        url: r.url,
        content: r.content,
        trustScore: trust,
        publishedDate: r.publishedDate,
      };
    })
    .filter((r) => r.trustScore >= minTrustScore)
    .sort((a, b) => b.trustScore - a.trustScore);
}
