import { tavilySearch } from './tavily';
import { exaSearch } from './exa';
import { LLMAdapter } from '../llm/adapter';

// ── Domain detection ──────────────────────────────────────────────────────────

export type Domain =
  | 'programming'
  | 'math'
  | 'science'
  | 'language'
  | 'creative'
  | 'business'
  | 'sports_fitness'
  | 'social_humanities'
  | 'general';

const DOMAIN_RE: [Domain, RegExp][] = [
  ['programming',       /python|javascript|typescript|react|vue|angular|svelte|sql|mysql|postgres|mongodb|git|linux|docker|kubernetes|api|rest|graphql|算法|数据结构|编程|代码|框架|库|node\.?js|express|fastapi|django|spring|rust|golang|swift|kotlin|flutter/i],
  ['math',              /数学|微积分|线代|线性代数|概率|统计|代数|几何|微分|积分|矩阵|向量|calculus|algebra|statistics|probability|geometry|linear/i],
  ['science',           /物理|化学|生物|地理|天文|力学|电磁|热力学|量子|physics|chemistry|biology|astronomy/i],
  ['language',          /英语|日语|法语|德语|西班牙语|韩语|spanish|japanese|french|german|grammar|vocabulary|pronunciation|语法|口语|听力|词汇/i],
  ['creative',          /cosplay|绘画|素描|插画|摄影|乐器|钢琴|吉他|小提琴|二胡|古筝|舞蹈|街舞|芭蕾|手工|编织|陶艺|书法|服装|平面设计|ui设计|ux|视频剪辑|剪辑|配音|唱歌|声乐|烹饪|料理|花艺|化妆|美妆|美发|nail|指甲|刺绣|珠宝|雕塑|动画|漫画|manga|音乐制作|编曲|作词/i],
  ['business',          /管理|营销|市场|创业|投资|会计|经济|战略|运营|商业|财务|项目管理|产品经理|品牌|供应链|人力资源|consulting|management|marketing|finance|accounting|entrepreneurship|mba/i],
  ['sports_fitness',    /健身|瑜伽|跑步|游泳|篮球|足球|羽毛球|乒乓|拳击|武术|训练|体育|运动|减肥|增肌|体能|fitness|yoga|running|swimming|crossfit/i],
  ['social_humanities', /历史|心理|哲学|社会学|文化|政治|经济学|法律|教育学|语言学|人类学|伦理|逻辑学|文学|history|psychology|philosophy|sociology|politics|ethics|literature/i],
];

export function detectDomain(nodeName: string, nodeDescription: string | null): Domain {
  const text = `${nodeName} ${nodeDescription ?? ''}`;
  for (const [domain, re] of DOMAIN_RE) {
    if (re.test(text)) return domain;
  }
  return 'general';
}

// ── Official documentation domains ───────────────────────────────────────────

const OFFICIAL_DOC_DOMAINS: Record<string, string[]> = {
  python:       ['docs.python.org'],
  react:        ['react.dev'],
  javascript:   ['developer.mozilla.org'],
  typescript:   ['www.typescriptlang.org'],
  'node.js':    ['nodejs.org'],
  nodejs:       ['nodejs.org'],
  vue:          ['vuejs.org'],
  angular:      ['angular.dev'],
  svelte:       ['svelte.dev'],
  sql:          ['www.postgresql.org', 'dev.mysql.com'],
  postgres:     ['www.postgresql.org'],
  mysql:        ['dev.mysql.com'],
  mongodb:      ['www.mongodb.com'],
  git:          ['git-scm.com'],
  docker:       ['docs.docker.com'],
  kubernetes:   ['kubernetes.io'],
  linux:        ['www.kernel.org', 'linuxcommand.org'],
  rust:         ['doc.rust-lang.org'],
  go:           ['go.dev'],
  java:         ['docs.oracle.com'],
  swift:        ['swift.org', 'developer.apple.com'],
};

export function getOfficialDocDomains(nodeName: string): string[] {
  const lower = nodeName.toLowerCase();
  for (const [keyword, domains] of Object.entries(OFFICIAL_DOC_DOMAINS)) {
    if (lower.includes(keyword)) return domains;
  }
  return [];
}

// ── Domain-specific Tier 2 authoritative domains ─────────────────────────────

const DOMAIN_TIER2_DOMAINS: Record<Domain, string[]> = {
  programming:       ['developer.mozilla.org', 'freecodecamp.org', 'web.dev', 'learn.microsoft.com', 'docs.github.com', 'geeksforgeeks.org', 'realpython.com'],
  math:              ['khanacademy.org', 'betterexplained.com', 'brilliant.org', 'mathsisfun.com', 'purplemath.com'],
  science:           ['khanacademy.org', 'ocw.mit.edu', 'hyperphysics.phy-astr.gsu.edu', 'phet.colorado.edu', 'sciencebuddies.org'],
  language:          ['bbc.co.uk', 'lingoda.com', 'fluentu.com', 'britishcouncil.org', 'cambridgeenglish.org'],
  creative:          ['instructables.com', 'wikihow.com', 'domestika.org', 'musictheory.net', 'ultimate-guitar.com', 'digital-photography-school.com', 'drawabox.com', 'skillshare.com'],
  business:          ['hbr.org', 'mckinsey.com', 'investopedia.com', 'coursera.org', 'mindtools.com', 'bdc.ca'],
  sports_fitness:    ['nasm.org', 'acefitness.org', 'runnersworld.com', 'mayoclinic.org', 'verywellfit.com'],
  social_humanities: ['britannica.com', 'plato.stanford.edu', 'ocw.mit.edu', 'coursera.org', 'simplypsychology.org'],
  general:           ['khanacademy.org', 'ocw.mit.edu', 'coursera.org', 'britannica.com', 'instructables.com', 'wikihow.com'],
};

// ── General quality fallback + low-quality blocklist ─────────────────────────

const GENERAL_QUALITY_DOMAINS = [
  'wikipedia.org', 'britannica.com', 'ocw.mit.edu', 'coursera.org',
  'khanacademy.org', 'instructables.com', 'wikihow.com', 'skillshare.com',
];

const LOW_QUALITY_DOMAINS = [
  'answers.com', 'ehow.com', 'blurtit.com', 'weknowtheanswer.com',
  'ask.com', 'chacha.com',
];

// ── Query generation (Priority 1) ────────────────────────────────────────────

/**
 * Generate 2-3 complementary search queries for a node based on its metadata.
 * Rule-based — zero latency, zero cost, still far better than fixed templates.
 */
export function generateSearchQueries(
  nodeName: string,
  _domain: Domain,
  difficulty: string,
  learningType?: string | null,
  bloomTarget?: string | null,
): string[] {
  const level =
    difficulty === 'beginner' ? 'beginner introduction' :
    difficulty === 'advanced' ? 'advanced in-depth'     : 'guide';

  // Query A: tutorial angle + quality signal
  const qA = `${nodeName} ${level} tutorial popular recommended`;

  // Query B: course/curriculum angle
  const qB = `${nodeName} course how to learn overview`;

  // Query C: content-type specific by learning_type / bloom_target
  let qC: string;
  if (learningType === 'motor_skill') {
    qC = `${nodeName} step by step hands-on practice guide`;
  } else if (learningType === 'verbal_info') {
    qC = `${nodeName} explained concepts fundamentals principles`;
  } else if (learningType === 'intellectual_skill') {
    qC = `${nodeName} methods techniques solved examples`;
  } else if (learningType === 'cognitive_strategy') {
    qC = `${nodeName} best practices workflow methodology`;
  } else if (bloomTarget === 'apply' || bloomTarget === 'create') {
    qC = `${nodeName} practical project examples`;
  } else {
    qC = `${nodeName} comprehensive guide overview`;
  }

  return [qA, qB, qC];
}

// ── LLM quality filter (Priority 2) ──────────────────────────────────────────

/**
 * Use a single cheap LLM call to batch-score up to 6 search results.
 * Returns one quality score per result: 1.0 = authoritative, 0.6 = ok, 0.2 = junk.
 * Fully non-fatal: on any error returns neutral scores (0.6) for all results.
 */
async function llmFilterResults(
  results: Array<{ title: string; url: string; content: string }>,
  nodeName: string,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<number[]> {
  if (results.length === 0) return [];

  const itemsText = results
    .map((r, i) =>
      `[${i}] 标题：${r.title}\nURL：${r.url}\n摘要：${r.content.slice(0, 150)}`,
    )
    .join('\n\n');

  const prompt =
    `评估以下 ${results.length} 条搜索结果是否适合作为「${nodeName}」的学习参考资料。\n\n` +
    `评分标准：\n` +
    `- 1.0：权威教程 / 官方文档 / 知名教育平台 / 有专业背景的系统讲解\n` +
    `- 0.6：一般质量，内容有参考价值但非权威\n` +
    `- 0.2：个人随笔 / 广告 / 论坛闲聊 / 内容与主题无关\n\n` +
    `只输出 JSON 数组，如 [1.0, 0.6, 0.2]，长度必须等于 ${results.length}：\n\n` +
    itemsText;

  let raw = '';
  await LLMAdapter.stream({
    provider, model,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: '你是搜索结果质量评估器。只输出 JSON 数字数组，不输出任何其他内容。',
    maxTokens: 120,
    temperature: 0,
    signal,
    onChunk:    (c) => { raw += c; },
    onComplete: () => {},
    onError:    () => {},
  });

  try {
    const match = raw.match(/\[[\d.,\s]+\]/);
    if (match) {
      const scores = JSON.parse(match[0]) as number[];
      if (scores.length === results.length) return scores;
    }
  } catch { /* non-fatal */ }

  return results.map(() => 0.6); // neutral fallback
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface SourceResult {
  tier: 1 | 2 | 3 | 4;
  title: string;
  url: string;
  content: string;
}

// ── Tiered source search ──────────────────────────────────────────────────────

/**
 * Fetch learning sources in priority order with multi-query parallel search,
 * LLM quality filtering, and follow-up補搜 logic.
 *
 * Tier 1 — official documentation (most authoritative)
 * Tier 2 — domain-specific authority sites (multi-query merged)
 * Tier 3 — general quality fallback / follow-up search
 */
export async function buildTieredSources(
  nodeName: string,
  nodeDescription: string | null,
  difficulty: string,
  nodeExtra?: { learning_type?: string | null; bloom_target?: string | null },
  options?: { provider?: string; model?: string; signal?: AbortSignal },
): Promise<SourceResult[]> {
  const domain = detectDomain(nodeName, nodeDescription);
  const results: SourceResult[] = [];

  // ── Tier 1: Official documentation ────────────────────────────────────────
  const officialDomains = getOfficialDocDomains(nodeName);
  if (officialDomains.length > 0) {
    try {
      const res = await tavilySearch(`${nodeName} official documentation`, {
        searchDepth: 'advanced',
        includeDomains: officialDomains,
        maxResults: 2,
      });
      for (const r of res.results) {
        results.push({ tier: 1, title: r.title, url: r.url, content: r.content });
      }
    } catch { /* degrade */ }
  }

  // ── Tier 2: Multi-query parallel search on domain-specific sites ──────────
  const queries = generateSearchQueries(
    nodeName, domain, difficulty,
    nodeExtra?.learning_type, nodeExtra?.bloom_target,
  );
  const tier2Domains = DOMAIN_TIER2_DOMAINS[domain] ?? DOMAIN_TIER2_DOMAINS.general;

  const [searchResults, exaRes] = await Promise.all([
    Promise.allSettled(
      queries.map((q) =>
        tavilySearch(q, { searchDepth: 'basic', includeDomains: tier2Domains, maxResults: 3 }),
      ),
    ),
    exaSearch(queries[0], { numResults: 4, useAutoprompt: true }).catch(() => ({ results: [] })),
  ]);

  // Merge by URL, keep highest score per URL
  const byUrl = new Map<string, { title: string; url: string; content: string; score: number }>();
  for (const settled of searchResults) {
    if (settled.status !== 'fulfilled') continue;
    for (const r of settled.value.results) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) {
        byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: r.score });
      }
    }
  }
  for (const r of exaRes.results) {
    const content = r.text.slice(0, 600);
    const existing = byUrl.get(r.url);
    if (!existing || r.score > existing.score) {
      byUrl.set(r.url, { title: r.title, url: r.url, content, score: r.score });
    }
  }

  const tier2Candidates = [...byUrl.values()]
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // LLM quality filter when provider is available
  let qualityScores: number[] = tier2Candidates.map(() => 0.6);
  if (options?.provider && options.model && tier2Candidates.length > 0) {
    qualityScores = await llmFilterResults(
      tier2Candidates,
      nodeName,
      options.provider,
      options.model,
      options.signal,
    );
  }

  for (let i = 0; i < tier2Candidates.length; i++) {
    if ((qualityScores[i] ?? 0.6) >= 0.5) {
      results.push({ tier: 2, ...tier2Candidates[i] });
    }
  }

  // ── Tier 3: General quality fallback ──────────────────────────────────────
  if (results.length < 2) {
    try {
      const res = await tavilySearch(queries[0], {
        searchDepth: 'basic',
        includeDomains: GENERAL_QUALITY_DOMAINS,
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: 4,
      });
      const seen = new Set(results.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.5 && !seen.has(r.url))) {
        results.push({ tier: 3, title: r.title, url: r.url, content: r.content });
      }
    } catch { /* degrade */ }
  }

  // ── Fallback 补搜：open general search if still lacking ───────────────────
  if (results.length < 2) {
    try {
      const res = await tavilySearch(`${nodeName} tutorial guide`, {
        searchDepth: 'basic',
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: 4,
      });
      const seen = new Set(results.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.6 && !seen.has(r.url))) {
        results.push({ tier: 3, title: r.title, url: r.url, content: r.content });
      }
    } catch { /* degrade */ }
  }

  return results.sort((a, b) => a.tier - b.tier).slice(0, 6);
}

// ── DAG planning search ───────────────────────────────────────────────────────

/**
 * Multi-query parallel search optimised for DAG roadmap planning.
 * Generates 2 complementary queries, merges results by URL, applies LLM
 * quality filter when provider/model are available.
 *
 * Returns up to `maxResults` results (default 3), answer string included.
 */
export async function buildDagSearchResults(
  query: string,
  options?: { provider?: string; model?: string; signal?: AbortSignal; maxResults?: number },
): Promise<{ answer?: string; results: Array<{ title: string; url: string; content: string }> }> {
  const domain = detectDomain(query, null);
  const domainDomains = DOMAIN_TIER2_DOMAINS[domain] ?? DOMAIN_TIER2_DOMAINS.general;
  // Combine domain-specific + general quality domains, deduplicated
  const includeDomains = [...new Set([...domainDomains, ...GENERAL_QUALITY_DOMAINS])];
  const maxR = Math.min(options?.maxResults ?? 3, 5);

  const queries = [
    `${query} popular recommended course overview`,
    `${query} official curriculum syllabus beginner guide`,
  ];

  const [settled, exaDagRes] = await Promise.all([
    Promise.allSettled(
      queries.map((q) =>
        tavilySearch(q, {
          searchDepth: 'basic',
          includeDomains,
          excludeDomains: LOW_QUALITY_DOMAINS,
          maxResults: 4,
        }),
      ),
    ),
    exaSearch(`${query} learning guide curriculum`, { numResults: 4, useAutoprompt: true }).catch(() => ({ results: [] })),
  ]);

  // Collect Tavily answer from first successful call
  let answer: string | undefined;
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.answer) { answer = s.value.answer; break; }
  }

  // Merge by URL, keep highest score
  const byUrl = new Map<string, { title: string; url: string; content: string; score: number }>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value.results) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) {
        byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: r.score });
      }
    }
  }
  for (const r of exaDagRes.results) {
    const content = r.text.slice(0, 600);
    const existing = byUrl.get(r.url);
    if (!existing || r.score > existing.score) {
      byUrl.set(r.url, { title: r.title, url: r.url, content, score: r.score });
    }
  }

  let candidates = [...byUrl.values()]
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Fallback: open search without domain restriction when results are sparse
  if (candidates.length < 2) {
    try {
      const res = await tavilySearch(query, {
        searchDepth: 'basic',
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: maxR + 2,
      });
      if (!answer && res.answer) answer = res.answer;
      const seen = new Set(candidates.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.5 && !seen.has(r.url))) {
        candidates.push({ title: r.title, url: r.url, content: r.content, score: r.score });
      }
    } catch { /* degrade */ }
  }

  candidates = candidates.slice(0, maxR + 2);

  // LLM quality filter when provider/model available
  let qualityScores: number[] = candidates.map(() => 0.6);
  if (options?.provider && options.model && candidates.length > 0) {
    qualityScores = await llmFilterResults(
      candidates, query, options.provider, options.model, options.signal,
    );
  }

  const results = candidates
    .filter((_, i) => (qualityScores[i] ?? 0.6) >= 0.5)
    .slice(0, maxR);

  return { answer, results };
}

// ── Outline (KC model) search ─────────────────────────────────────────────────

/**
 * Multi-query search optimised for KC outline generation.
 * Three outline-specific angles: misconceptions, learning prerequisites, beginner mistakes.
 * Uses domain-aware authority domains + LLM quality filter.
 *
 * Returns up to 4 results (title, url, content) for injection into the outline prompt.
 */
export async function buildOutlineSearchResults(
  nodeName: string,
  nodeDescription: string | null,
  options?: { provider?: string; model?: string; signal?: AbortSignal },
): Promise<Array<{ title: string; url: string; content: string }>> {
  const domain = detectDomain(nodeName, nodeDescription);
  const domainDomains = DOMAIN_TIER2_DOMAINS[domain] ?? DOMAIN_TIER2_DOMAINS.general;
  const includeDomains = [...new Set([...domainDomains, ...GENERAL_QUALITY_DOMAINS])];

  const queries = [
    `common misconceptions about ${nodeName}`,
    `${nodeName} learning objectives prerequisites what to know before`,
    `${nodeName} beginner mistakes to avoid`,
  ];

  const [settled, exaOutlineRes] = await Promise.all([
    Promise.allSettled(
      queries.map((q) =>
        tavilySearch(q, {
          searchDepth: 'basic',
          includeDomains,
          excludeDomains: LOW_QUALITY_DOMAINS,
          maxResults: 3,
        }),
      ),
    ),
    exaSearch(`${nodeName} common misconceptions prerequisites to learn`, { numResults: 3, useAutoprompt: true }).catch(() => ({ results: [] })),
  ]);

  // Merge by URL, keep highest score
  const byUrl = new Map<string, { title: string; url: string; content: string; score: number }>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value.results) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) {
        byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: r.score });
      }
    }
  }
  for (const r of exaOutlineRes.results) {
    const content = r.text.slice(0, 600);
    const existing = byUrl.get(r.url);
    if (!existing || r.score > existing.score) {
      byUrl.set(r.url, { title: r.title, url: r.url, content, score: r.score });
    }
  }

  let candidates = [...byUrl.values()]
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Fallback: open search without domain restriction
  if (candidates.length < 2) {
    try {
      const res = await tavilySearch(queries[0], {
        searchDepth: 'basic',
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: 4,
      });
      const seen = new Set(candidates.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.5 && !seen.has(r.url))) {
        candidates.push({ title: r.title, url: r.url, content: r.content, score: r.score });
      }
    } catch { /* degrade */ }
  }

  candidates = candidates.slice(0, 6);

  // LLM quality filter when provider/model available
  let qualityScores: number[] = candidates.map(() => 0.6);
  if (options?.provider && options.model && candidates.length > 0) {
    qualityScores = await llmFilterResults(
      candidates, nodeName, options.provider, options.model, options.signal,
    );
  }

  return candidates
    .filter((_, i) => (qualityScores[i] ?? 0.6) >= 0.5)
    .slice(0, 4);
}

// ── Practice exercise domain lists ───────────────────────────────────────────

const PRACTICE_DOMAINS: Record<string, Record<Domain, string[]>> = {
  academic_qa: {
    programming:       ['geeksforgeeks.org', 'exercism.org', 'programiz.com', 'codingbat.com', 'pintia.cn', 'acwing.com'],
    math:              ['khanacademy.org', 'openstax.org', 'mathsisfun.com', 'brilliant.org', 'purplemath.com'],
    science:           ['khanacademy.org', 'openstax.org', 'physicsclassroom.com', 'sciencebuddies.org'],
    language:          ['bbc.co.uk', 'englishpage.com', 'grammarbook.com', 'britishcouncil.org'],
    creative:          ['instructables.com', 'wikihow.com', 'domestika.org'],
    business:          ['hbr.org', 'investopedia.com', 'mindtools.com'],
    sports_fitness:    ['nasm.org', 'acefitness.org', 'verywellfit.com'],
    social_humanities: ['britannica.com', 'simplypsychology.org', 'philosophybasics.com', 'sparknotes.com'],
    general:           ['khanacademy.org', 'openstax.org', 'instructables.com'],
  },
  technical_exercise: {
    programming:       ['geeksforgeeks.org', 'exercism.org', 'codingbat.com', 'programiz.com', 'acwing.com', 'pintia.cn'],
    math:              ['khanacademy.org', 'openstax.org', 'mathsisfun.com', 'brilliant.org'],
    science:           ['khanacademy.org', 'openstax.org', 'physicsclassroom.com'],
    language:          ['bbc.co.uk', 'englishpage.com', 'britishcouncil.org'],
    creative:          ['instructables.com', 'wikihow.com'],
    business:          ['hbr.org', 'investopedia.com'],
    sports_fitness:    ['nasm.org', 'verywellfit.com'],
    social_humanities: ['britannica.com', 'simplypsychology.org'],
    general:           ['khanacademy.org', 'openstax.org', 'geeksforgeeks.org'],
  },
  skill_drill: {
    programming:       ['exercism.org', 'codingbat.com', 'freecodecamp.org', 'w3schools.com', 'acwing.com'],
    math:              ['khanacademy.org', 'mathsisfun.com', 'openstax.org'],
    science:           ['khanacademy.org', 'openstax.org'],
    language:          ['bbc.co.uk', 'britishcouncil.org', 'cambridgeenglish.org'],
    creative:          ['instructables.com', 'wikihow.com'],
    business:          ['coursera.org', 'mindtools.com'],
    sports_fitness:    ['nasm.org', 'verywellfit.com'],
    social_humanities: ['coursera.org', 'britannica.com'],
    general:           ['khanacademy.org', 'wikihow.com'],
  },
  creative_practice: {
    programming:       ['exercism.org', 'freecodecamp.org'],
    math:              ['khanacademy.org', 'openstax.org'],
    science:           ['khanacademy.org', 'openstax.org'],
    language:          ['bbc.co.uk', 'britishcouncil.org'],
    creative:          ['instructables.com', 'domestika.org', 'skillshare.com'],
    business:          ['coursera.org', 'hbr.org'],
    sports_fitness:    ['nasm.org', 'verywellfit.com'],
    social_humanities: ['coursera.org'],
    general:           ['instructables.com', 'khanacademy.org'],
  },
  performance_simulation: {
    programming:       ['exercism.org', 'freecodecamp.org'],
    math:              ['khanacademy.org', 'openstax.org'],
    science:           ['khanacademy.org', 'openstax.org'],
    language:          ['bbc.co.uk', 'britishcouncil.org', 'cambridgeenglish.org'],
    creative:          ['instructables.com', 'domestika.org'],
    business:          ['hbr.org', 'coursera.org'],
    sports_fitness:    ['nasm.org', 'verywellfit.com'],
    social_humanities: ['coursera.org', 'britannica.com'],
    general:           ['khanacademy.org', 'wikihow.com'],
  },
};

function getPracticeQuery(
  nodeName: string,
  practiceType: string,
  knowledgePoint?: string,
): string[] {
  const subject = knowledgePoint ?? nodeName;
  switch (practiceType) {
    case 'technical_exercise':
      return [
        `${subject} exercises with solutions answer key`,
        `${subject} practice problems step by step solution`,
        `${subject} 练习题 解析 答案`,
      ];
    case 'skill_drill':
      return [
        `${subject} practice drills worksheet with answers`,
        `${subject} exercises beginner problems solution`,
        `${subject} 习题 解答 入门练习`,
      ];
    case 'creative_practice':
      return [
        `${subject} hands-on practice project with guide`,
        `${subject} 实操练习 步骤 案例`,
      ];
    case 'performance_simulation':
      return [
        `${subject} practice scenarios with sample answers`,
        `${subject} 情景练习 示范 解析`,
      ];
    default: // academic_qa
      return [
        `${subject} quiz questions with answers explained`,
        `${subject} problem set answer key worksheet`,
        `${subject} 经典习题 解析 答案`,
      ];
  }
}

const ANSWER_KEYWORDS = /answer[:\s]|solution[:\s]|答案|解析|解答|习题|练习题|题解|explanation[:\s]|step.by.step|answer\s*key|worksheet|problem\s*set/i;

/**
 * Search for reference exercises / training materials.
 * Uses multi-query parallel search and LLM quality filtering (same pattern as buildTieredSources).
 */
export async function buildPracticeSources(
  nodeName: string,
  domain: Domain,
  practiceType = 'academic_qa',
  knowledgePoints?: string[],
  options?: { provider?: string; model?: string; signal?: AbortSignal },
): Promise<SourceResult[]> {
  const domainDomains =
    (PRACTICE_DOMAINS[practiceType] ?? PRACTICE_DOMAINS['academic_qa'])[domain] ??
    PRACTICE_DOMAINS['academic_qa']['general'];

  // Primary parallel queries (node level)
  const primaryQueries = getPracticeQuery(nodeName, practiceType);
  const primaryResults = await Promise.allSettled(
    primaryQueries.map((q) =>
      tavilySearch(q, {
        searchDepth: 'advanced',
        includeDomains: domainDomains,
        maxResults: 3,
      }),
    ),
  );

  // Merge by URL, keep highest score
  const byUrl = new Map<string, { title: string; url: string; content: string; score: number }>();
  for (const settled of primaryResults) {
    if (settled.status !== 'fulfilled') continue;
    for (const r of settled.value.results) {
      const boostedScore = ANSWER_KEYWORDS.test(r.content) ? r.score * 1.2 : r.score;
      const existing = byUrl.get(r.url);
      if (!existing || boostedScore > existing.score) {
        byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: boostedScore });
      }
    }
  }

  // Per-knowledge-point queries (parallel, max 3 points)
  if (knowledgePoints && knowledgePoints.length > 0 && byUrl.size < 4) {
    const pointResults = await Promise.allSettled(
      knowledgePoints.slice(0, 3).map((kp) =>
        tavilySearch(getPracticeQuery(nodeName, practiceType, kp)[0], {
          searchDepth: 'basic',
          includeDomains: domainDomains,
          maxResults: 2,
        }).then((res) =>
          res.results.filter((r) => r.score > 0.45 && ANSWER_KEYWORDS.test(r.content)),
        ),
      ),
    );
    for (const settled of pointResults) {
      if (settled.status !== 'fulfilled') continue;
      for (const r of settled.value) {
        if (!byUrl.has(r.url)) {
          byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: r.score });
        }
      }
    }
  }

  const candidates = [...byUrl.values()]
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // LLM quality filter
  let qualityScores: number[] = candidates.map(() => 0.6);
  if (options?.provider && options.model && candidates.length > 0) {
    qualityScores = await llmFilterResults(
      candidates,
      nodeName,
      options.provider,
      options.model,
      options.signal,
    );
  }

  const results: SourceResult[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if ((qualityScores[i] ?? 0.6) >= 0.5) {
      results.push({ tier: 2, ...candidates[i] });
    }
  }

  return results.slice(0, 6);
}
