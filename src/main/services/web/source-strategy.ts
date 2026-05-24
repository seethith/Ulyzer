import { tavilySearch } from './tavily';
import { exaSearch } from './exa';
import { LLMAdapter } from '../llm/adapter';
import { collectEvidencePack } from './research-pipeline';
import { formatSourceExerciseEvidenceBrief, retrieveSourceExercises } from '../source/source-exercises';
import type { EvidencePack, SearchMode, SourceExercise, TokenUsage } from '@shared/types';

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
  ['social_humanities', /历史|心理|哲学|社会学|文化|政治|经济学|法律|教育学|语言学|人类学|伦理|逻辑学|文学|礼仪|社交|沟通|人际|边界感|同理心|价值观|态度|素养|团队协作|领导力|职业素养|history|psychology|philosophy|sociology|politics|ethics|literature|etiquette|social\s*skills|soft\s*skills|communication|interpersonal|empathy|values|attitude|teamwork|leadership/i],
];

export function detectDomain(nodeName: string, nodeDescription: string | null): Domain {
  const text = `${nodeName} ${nodeDescription ?? ''}`;
  for (const [domain, re] of DOMAIN_RE) {
    if (re.test(text)) return domain;
  }
  return 'general';
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
  'wenku.baidu.com', 'doc88.com', 'docin.com', 'max.book118.com', 'book118.com',
  'taodocs.com', 'renrendoc.com', 'studocu.com', 'coursehero.com', 'scribd.com',
  'slideshare.net', '51paper.net', 'lw881.com', 'lw54.com', 'bylw.com',
];

// ── Curriculum authority domains (for outline KC structure search) ────────────
// These sites publish structured syllabi, course outlines, and learning objectives
// rather than general tutorials — they anchor KC selection to authoritative curricula.

const CURRICULUM_AUTHORITY_DOMAINS = [
  'ocw.mit.edu',              // MIT OpenCourseWare — syllabi, problem sets, reading lists
  'cs.stanford.edu',          // Stanford CS course pages
  'web.stanford.edu',
  'coursera.org',             // Course syllabus/outline pages
  'edx.org',                  // Course syllabus pages
  'openlearn.open.ac.uk',     // Open University — structured curriculum
  'nptel.ac.in',              // NPTEL — IIT/IISc courses, wide domain coverage
  'ocw.tudelft.nl',           // TU Delft OpenCourseWare
  'oli.cmu.edu',              // Carnegie Mellon Open Learning Initiative
  'khanacademy.org',
];

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
  onUsage?: (usage: TokenUsage) => void,
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
    onComplete: (usage) => { onUsage?.(usage); },
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

export type PracticeSourceKind =
  | 'assignment'
  | 'problem_set'
  | 'lab'
  | 'exam'
  | 'textbook_exercise'
  | 'rubric'
  | 'worked_example'
  | 'misconception'
  | 'scenario'
  | 'checklist'
  | 'general';

export interface PracticeSourceBrief {
  sources: Array<{
    title: string;
    url: string;
    kind: PracticeSourceKind;
    trustScore: number;
    snippet: string;
  }>;
  exercises: SourceExercise[];
  patterns: string[];
  warnings: string[];
  summary: string;
}

// ── Outline (KC model) search ─────────────────────────────────────────────────

/**
 * Multi-query search optimised for KC outline generation.
 * Three outline-specific angles: misconceptions, learning prerequisites, beginner mistakes.
 * Uses two parallel search streams — curriculum structure and misconceptions — with
 * domain-aware authority domains + LLM quality filter.
 *
 * Returns tagged results: kind='curriculum' anchors KC selection to authoritative
 * course structures; kind='misconception' populates Misconceptions / Edge Conditions.
 * Up to 3 results per kind (6 total).
 */
export async function buildOutlineSearchResults(
  nodeName: string,
  nodeDescription: string | null,
  options?: {
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    courseId?: string;
    nodeId?: string;
    searchMode?: SearchMode;
    language?: string;
    onUsage?: (usage: TokenUsage) => void;
  },
): Promise<Array<{ title: string; url: string; content: string; kind: 'curriculum' | 'misconception' }>> {
  if (options?.courseId) {
    const pack = await collectEvidencePack({
      query: `${nodeName} ${nodeDescription ?? ''}`.trim(),
      courseId: options.courseId,
      nodeId: options.nodeId,
      mode: options.searchMode ?? 'auto',
      taskType: 'theory',
      maxWebResults: 4,
      language: options.language,
      provider: options.provider,
      model: options.model,
      signal: options.signal,
      onUsage: options.onUsage,
    });
    const sourceById = new Map(pack.sources.map((source) => [source.id, source]));
    const out = pack.chunks.slice(0, 6).map((chunk) => {
      const source = sourceById.get(chunk.sourceId);
      const text = `${chunk.slot ?? ''} ${chunk.text}`.toLowerCase();
      const kind: 'curriculum' | 'misconception' = /误区|错误|mistake|misconception|pitfall|risk/.test(text)
        ? 'misconception'
        : 'curriculum';
      return {
        title: source?.title ?? nodeName,
        url: source?.url ?? source?.filePath ?? '',
        content: chunk.text,
        kind,
      };
    });
    if (options.searchMode === 'library') return out;
    if (out.length > 0) return out;
  }

  const domain = detectDomain(nodeName, nodeDescription);
  const domainDomains = DOMAIN_TIER2_DOMAINS[domain] ?? DOMAIN_TIER2_DOMAINS.general;

  // Curriculum stream: target authoritative course structure sites
  const curriculumIncludeDomains = [...new Set([...CURRICULUM_AUTHORITY_DOMAINS])];
  const curriculumQueries = [
    `"${nodeName}" course syllabus topics covered learning objectives`,
    `"${nodeName}" curriculum textbook chapter outline what to learn`,
  ];

  // Misconception stream: target domain-specific educational sites
  const misconceptionIncludeDomains = [...new Set([...domainDomains, ...GENERAL_QUALITY_DOMAINS])];
  const misconceptionQueries = [
    `common misconceptions about ${nodeName}`,
    `${nodeName} prerequisites beginner mistakes to avoid`,
  ];

  const [curriculumSettled, misconceptionSettled, exaCurriculumRes, exaMisconceptionRes] = await Promise.all([
    Promise.allSettled(
      curriculumQueries.map((q) =>
        tavilySearch(q, {
          searchDepth: 'basic',
          includeDomains: curriculumIncludeDomains,
          excludeDomains: LOW_QUALITY_DOMAINS,
          maxResults: 3,
        }),
      ),
    ),
    Promise.allSettled(
      misconceptionQueries.map((q) =>
        tavilySearch(q, {
          searchDepth: 'basic',
          includeDomains: misconceptionIncludeDomains,
          excludeDomains: LOW_QUALITY_DOMAINS,
          maxResults: 3,
        }),
      ),
    ),
    exaSearch(`${nodeName} course syllabus learning objectives curriculum`, { numResults: 3, useAutoprompt: true }).catch(() => ({ results: [] })),
    exaSearch(`${nodeName} common misconceptions prerequisites to learn`, { numResults: 3, useAutoprompt: true }).catch(() => ({ results: [] })),
  ]);

  // Merge by URL — curriculum takes priority if the same URL appears in both streams
  const byUrl = new Map<string, { title: string; url: string; content: string; score: number; kind: 'curriculum' | 'misconception' }>();

  const mergeStream = (
    settled: PromiseSettledResult<{ results: Array<{ title: string; url: string; content: string; score: number }> }>[],
    kind: 'curriculum' | 'misconception',
  ) => {
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const r of s.value.results) {
        const existing = byUrl.get(r.url);
        if (!existing || r.score > existing.score || (kind === 'curriculum' && existing.kind === 'misconception')) {
          byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score: r.score, kind });
        }
      }
    }
  };

  mergeStream(curriculumSettled, 'curriculum');
  mergeStream(misconceptionSettled, 'misconception');

  for (const r of exaCurriculumRes.results) {
    const content = r.text.slice(0, 600);
    const existing = byUrl.get(r.url);
    if (!existing || r.score > existing.score || existing.kind === 'misconception') {
      byUrl.set(r.url, { title: r.title, url: r.url, content, score: r.score, kind: 'curriculum' });
    }
  }
  for (const r of exaMisconceptionRes.results) {
    const content = r.text.slice(0, 600);
    const existing = byUrl.get(r.url);
    if (!existing || r.score > existing.score) {
      byUrl.set(r.url, { title: r.title, url: r.url, content, score: r.score, kind: 'misconception' });
    }
  }

  let candidates = [...byUrl.values()]
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  // Fallback: open curriculum search if no curriculum results landed
  if (!candidates.some((c) => c.kind === 'curriculum')) {
    try {
      const res = await tavilySearch(`${nodeName} course syllabus learning objectives`, {
        searchDepth: 'basic',
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: 4,
      });
      const seen = new Set(candidates.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.4 && !seen.has(r.url))) {
        candidates.push({ title: r.title, url: r.url, content: r.content, score: r.score, kind: 'curriculum' });
      }
    } catch { /* degrade */ }
  }

  // Fallback: open misconception search if no misconception results landed
  if (!candidates.some((c) => c.kind === 'misconception')) {
    try {
      const res = await tavilySearch(`common misconceptions about ${nodeName}`, {
        searchDepth: 'basic',
        excludeDomains: LOW_QUALITY_DOMAINS,
        maxResults: 4,
      });
      const seen = new Set(candidates.map((r) => r.url));
      for (const r of res.results.filter((r) => r.score > 0.5 && !seen.has(r.url))) {
        candidates.push({ title: r.title, url: r.url, content: r.content, score: r.score, kind: 'misconception' });
      }
    } catch { /* degrade */ }
  }

  candidates = candidates.slice(0, 8);

  // LLM quality filter when provider/model available
  let qualityScores: number[] = candidates.map(() => 0.6);
  if (options?.provider && options.model && candidates.length > 0) {
    qualityScores = await llmFilterResults(
      candidates, nodeName, options.provider, options.model, options.signal, options.onUsage,
    );
  }

  const filtered = candidates.filter((_, i) => (qualityScores[i] ?? 0.6) >= 0.5);
  const curriculumResults  = filtered.filter((r) => r.kind === 'curriculum').slice(0, 3);
  const misconceptionResults = filtered.filter((r) => r.kind === 'misconception').slice(0, 3);
  return [...curriculumResults, ...misconceptionResults];
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

const COURSE_ARTIFACT_DOMAINS = [
  'ocw.mit.edu',
  'openstax.org',
  'cs50.harvard.edu',
  'nifty.stanford.edu',
  'web.stanford.edu',
  'cs.cmu.edu',
  'berkeley.edu',
  'khanacademy.org',
  'brilliant.org',
  'mindtools.com',
  'skillsyouneed.com',
  'edutopia.org',
  'understood.org',
  'positivepsychology.com',
];

const COURSE_ARTIFACT_RE = /assignment|problem\s*set|homework|lab|exam|worksheet|exercise|rubric|solution|worked\s*example|starter\s*code|test\s*cases|case\s*study|scenario|role\s*play|reflection|checklist|self\s*assessment|peer\s*feedback|values\s*clarification|code\s*of\s*conduct|etiquette|misconception|common\s+mistake|作业|习题|实验|评分|解析|错题|误区|情景|情境|案例|角色扮演|反思|清单|自评|互评|价值澄清|行为规范|礼仪/i;

function classifyPracticeSource(title: string, content: string, url: string): PracticeSourceKind {
  const text = `${title} ${content} ${url}`;
  if (/rubric|grading|评分/i.test(text)) return 'rubric';
  if (/checklist|self\s*assessment|peer\s*feedback|自评|互评|清单|观察表|反馈表/i.test(text)) return 'checklist';
  if (/scenario|role\s*play|case\s*study|情景|情境|案例|角色扮演/i.test(text)) return 'scenario';
  if (/lab|实验|starter\s*code|test\s*cases/i.test(text)) return 'lab';
  if (/problem\s*set|pset|习题|题集/i.test(text)) return 'problem_set';
  if (/assignment|homework|作业/i.test(text)) return 'assignment';
  if (/exam|quiz|期末|考试/i.test(text)) return 'exam';
  if (/textbook|openstax|chapter.*exercise|教材/i.test(text)) return 'textbook_exercise';
  if (/worked\s*example|sample\s*solution|solution|解析|答案/i.test(text)) return 'worked_example';
  if (/misconception|common\s+mistake|debugging|error\s*analysis|误区|常见错误/i.test(text)) return 'misconception';
  return 'general';
}

function scorePracticeArtifact(result: { title: string; url: string; content: string; score: number }): number {
  let score = result.score ?? 0.5;
  const host = (() => {
    try { return new URL(result.url).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  const text = `${result.title} ${result.content} ${result.url}`;

  if (COURSE_ARTIFACT_RE.test(text)) score += 0.25;
  if (/\.edu$|\.edu\//i.test(result.url) || COURSE_ARTIFACT_DOMAINS.some((domain) => host.endsWith(domain))) score += 0.25;
  if (/solution|answer\s*key|sample\s*solution|worked\s*example|rubric|grading|test\s*cases|解析|答案|评分/i.test(text)) score += 0.15;
  if (/scenario|role\s*play|reflection|checklist|self\s*assessment|peer\s*feedback|values\s*clarification|情景|情境|角色扮演|反思|自评|互评|价值澄清/i.test(text)) score += 0.18;
  if (/blog|medium\.com|substack|forum|reddit|zhihu|广告|培训/i.test(text)) score -= 0.15;
  if (result.content.length < 120) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

function isAttitudeLike(learningType?: string | null): boolean {
  return learningType === 'attitude';
}

function isMotorLike(learningType?: string | null): boolean {
  return learningType === 'motor_skill';
}

function isStrategyLike(learningType?: string | null): boolean {
  return learningType === 'cognitive_strategy';
}

function practiceQueries(
  nodeName: string,
  domain: Domain,
  learningType?: string | null,
  bloomTarget?: string | null,
): { exact: string; open: string; semantic: string } {
  if (isAttitudeLike(learningType)) {
    return {
      exact:    `${nodeName} scenario role play worksheet etiquette communication`,
      open:     `${nodeName} self reflection checklist peer feedback values clarification 情景 角色扮演 自评 清单`,
      semantic: `High quality attitude or social skills practice scenarios, role play cards, reflection checklist, and rubric for ${nodeName}`,
    };
  }
  if (isMotorLike(learningType)) {
    return {
      exact:    `${nodeName} drill progression practice routine self assessment checklist`,
      open:     `${nodeName} common mistakes coaching cues self check practice`,
      semantic: `High quality motor skill drill progression, coaching cues, common mistakes, and self-check practice for ${nodeName}`,
    };
  }
  if (isStrategyLike(learningType)) {
    return {
      exact:    `${nodeName} strategy worksheet case analysis decision framework rubric`,
      open:     `${nodeName} reflection prompts practice scenarios common mistakes`,
      semantic: `High quality cognitive strategy worksheet, case analysis, decision framework, and reflection prompts for ${nodeName}`,
    };
  }
  if (bloomTarget === 'create') {
    return {
      exact:    `${nodeName} project brief assignment rubric examples`,
      open:     `${nodeName} creative task constraints assessment criteria`,
      semantic: `High quality project brief, assignment rubric, and creative practice constraints for ${nodeName}`,
    };
  }
  if (domain === 'programming') {
    return {
      exact:    `${nodeName} programming assignment lab starter code tests`,
      open:     `${nodeName} debugging exercise common mistakes solution`,
      semantic: `High quality university programming assignment or lab exercise for ${nodeName}`,
    };
  }
  if (domain === 'math' || domain === 'science') {
    return {
      exact:    `${nodeName} problem set solutions textbook exercises`,
      open:     `${nodeName} conceptual questions common mistakes worked examples`,
      semantic: `University problem set or textbook exercises with solutions for ${nodeName}`,
    };
  }
  if (domain === 'business' || domain === 'social_humanities') {
    return {
      exact:    `${nodeName} case study assignment rubric discussion questions`,
      open:     `${nodeName} practice questions worked examples common mistakes`,
      semantic: `High quality case assignment rubric and practice questions for ${nodeName}`,
    };
  }
  if (domain === 'creative' || domain === 'sports_fitness') {
    return {
      exact:    `${nodeName} practice assignment rubric drill progression`,
      open:     `${nodeName} common mistakes self assessment checklist`,
      semantic: `High quality practice brief rubric and drill progression for ${nodeName}`,
    };
  }
  return {
    exact:    `${nodeName} assignment problem set lab solutions`,
    open:     `${nodeName} textbook exercises worked examples common mistakes`,
    semantic: `High quality course assignment or textbook exercises for ${nodeName}`,
  };
}

function practiceIncludeDomains(domain: Domain, learningType?: string | null): string[] | undefined {
  if (isAttitudeLike(learningType) || isStrategyLike(learningType)) {
    return undefined;
  }
  return [...new Set([...COURSE_ARTIFACT_DOMAINS, ...(PRACTICE_DOMAINS.academic_qa[domain] ?? [])])];
}

function buildPracticePatterns(
  domain: Domain,
  sources: Array<{ kind: PracticeSourceKind }>,
  learningType?: string | null,
): string[] {
  const sourceKinds = new Set(sources.map((source) => source.kind));
  const patterns = [
    '原型题：用最小而完整的场景训练核心 KC，题干必须有明确条件和可判定结果。',
    '变式题：改变边界条件、约束、数据或场景，检查学生是否只会套模板。',
    '错误诊断题：给出错误推理、错误代码、错误步骤或错误方案，要求定位并修正。',
    '迁移/综合题：放入新场景，要求学生判断是否适用、如何组合、如何取舍。',
  ];

  if (isAttitudeLike(learningType)) {
    patterns.push('态度/价值内化节点优先采用情境判断、角色扮演、行为观察清单、自我反思、同伴反馈、价值澄清；答案应给“更得体/更尊重/更符合边界”的判断依据和评分维度。');
  } else if (isMotorLike(learningType)) {
    patterns.push('动作技能节点优先采用分步练习、动作/作品自检、常见错误纠正、进阶 drill；题目必须有完成标准和错误提示。');
  } else if (isStrategyLike(learningType)) {
    patterns.push('认知策略节点优先采用案例分析、决策框架应用、反思提示、策略迁移；题目必须要求说明判断依据。');
  } else if (domain === 'programming') {
    patterns.push('编程题优先采用代码阅读、debug、补全实现、小型重构、测试用例设计；应用题必须给输入/输出或可运行测试。');
  } else if (domain === 'math' || domain === 'science') {
    patterns.push('数理题优先采用概念辨析、反例构造、计算变式、证明/推导、建模应用；答案需展示关键步骤。');
  } else if (domain === 'business' || domain === 'social_humanities') {
    patterns.push('案例题优先采用诊断、比较、决策取舍、方案评审；开放题必须给评分维度。');
  } else if (domain === 'creative' || domain === 'sports_fitness') {
    patterns.push('技能题优先采用操作任务、限制条件创作、动作/作品自检、常见错误纠正；必须给完成标准。');
  }

  if (sourceKinds.has('rubric')) patterns.push('已有 rubric 信号：开放题和综合题必须给评分维度，不写成泛泛讨论题。');
  if (sourceKinds.has('lab')) patterns.push('已有 lab 信号：应用题应包含材料/环境/步骤/验收结果，避免只问概念。');
  if (sourceKinds.has('misconception')) patterns.push('已有误区信号：至少设置一道错误诊断题，专门打击常见误解。');
  if (sourceKinds.has('scenario')) patterns.push('已有 scenario/role-play 信号：至少设置一道情境判断或角色扮演题，要求给出行为选择和理由。');
  if (sourceKinds.has('checklist')) patterns.push('已有 checklist/feedback 信号：至少设置一道自评、互评或观察清单题，用于真实行为迁移。');
  return patterns;
}

export function formatPracticeSourceBrief(brief: PracticeSourceBrief, language?: string): string {
  const isEn = language === 'en';
  if (brief.sources.length === 0 && brief.exercises.length === 0) {
    return isEn
      ? '[Practice Source Brief]\nNo strong exercise sources found. Use the blueprint patterns and mark original questions as [AI Original].'
      : '[实践题源简报]\n未找到强题源。请基于出题蓝图生成原创题，并将原创题标注为 [AI原创]。';
  }

  const sourceLines = brief.sources.length > 0
    ? brief.sources
      .map((source, index) =>
        `${index + 1}. [${source.kind}] ${source.title}\n` +
        `${isEn ? 'Source' : '来源'}: ${source.url}\n` +
        `${source.snippet}`,
      )
      .join('\n\n')
    : (isEn ? 'No extra source snippets.' : '无额外题源片段。');
  const exerciseLines = formatSourceExerciseEvidenceBrief(brief.exercises, language);
  const patternLines = brief.patterns.map((pattern) => `- ${pattern}`).join('\n');
  const warningLines = brief.warnings.length > 0
    ? '\n\n' + (isEn ? 'Warnings:' : '注意：') + '\n' + brief.warnings.map((warning) => `- ${warning}`).join('\n')
    : '';

  return (isEn ? '[Practice Source Brief]' : '[实践题源简报]') +
    `\n${brief.summary}\n\n` +
    (isEn ? 'Exercise patterns to imitate, not copy:' : '可模仿但不得照搬的题型范式：') +
    `\n${patternLines}\n\n` +
    (isEn ? 'Source evidence:' : '题源证据：') +
    `\n${sourceLines}\n\n` +
    (isEn ? 'Structured exercise assets:' : '结构化题目资产：') +
    `\n${exerciseLines}` +
    warningLines;
}

/**
 * Low-cost source brief for practice generation.
 * Fixed budget: 2 Tavily searches + 1 Exa semantic search, no reviewer LLM call.
 */
export async function buildPracticeSourceBrief(
  nodeName: string,
  domain: Domain,
  options?: {
    signal?: AbortSignal;
    maxSources?: number;
    learningType?: string | null;
    bloomTarget?: string | null;
    evidencePack?: EvidencePack;
    courseId?: string;
    nodeId?: string;
    searchMode?: SearchMode;
    language?: string;
    provider?: string;
    model?: string;
    onProgress?: (message: string) => void;
    onUsage?: (usage: TokenUsage) => void;
  },
): Promise<PracticeSourceBrief> {
  const exerciseAssets = options?.courseId
    ? retrieveSourceExercises({
      courseId: options.courseId,
      nodeId: options.nodeId,
      agentType: 'sub_tutor',
      query: nodeName,
      limit: 5,
    })
    : [];

  if (options?.courseId) {
    const pack = options.evidencePack ?? await collectEvidencePack({
      query: nodeName,
      courseId: options.courseId,
      nodeId: options.nodeId,
      mode: options.searchMode ?? 'auto',
      taskType: 'practice',
      maxWebResults: options.maxSources ?? 5,
      language: options.language,
      provider: options.provider,
      model: options.model,
      signal: options.signal,
      onProgress: options.onProgress,
      onUsage: options.onUsage,
    });
    const sourceById = new Map(pack.sources.map((source) => [source.id, source]));
    const sources = pack.chunks.slice(0, Math.min(options.maxSources ?? 5, 6)).map((chunk) => {
      const source = sourceById.get(chunk.sourceId);
      const title = source?.title ?? nodeName;
      const url = source?.url ?? source?.filePath ?? '';
      const snippet = chunk.text.slice(0, 420);
      return {
        title,
        url,
        kind: classifyPracticeSource(title, snippet, url),
        trustScore: Number((source?.trustScore ?? chunk.score ?? 0.5).toFixed(2)),
        snippet,
      };
    });
    if (sources.length > 0) {
      const patterns = buildPracticePatterns(domain, sources, options.learningType);
      return {
        sources,
        exercises: exerciseAssets,
        patterns,
        warnings: [
          '不要照搬题源原题；只提取题型结构、约束方式、答案/评分方式，再为当前 KC 生成原创或改编题。',
          exerciseAssets.length > 0
            ? `参考库已抽取 ${exerciseAssets.length} 道题目资产；优先用它们判断题型、答案结构和难度，但仍需改编。`
            : '参考库暂未抽取到结构化题目资产；主要依据题源片段和学习蓝图出题。',
          ...pack.warnings.slice(0, 4),
        ],
        summary: `Practice source brief reused the material retrieval package. Found ${sources.length} usable snippets and ${exerciseAssets.length} exercise assets; coverage gaps: ${pack.coverage.missing.join(', ') || 'none'}.`,
      };
    }
    if (exerciseAssets.length > 0) {
      const patterns = buildPracticePatterns(domain, [], options.learningType);
      return {
        sources: [],
        exercises: exerciseAssets,
        patterns,
        warnings: [
          `参考库已抽取 ${exerciseAssets.length} 道结构化题目资产；不要照搬原题，按当前 KC 改编数值、情境和约束。`,
          ...pack.warnings.slice(0, 4),
        ],
        summary: `Practice source search found 0 usable snippets but ${exerciseAssets.length} structured exercise assets.`,
      };
    }
    if (options.searchMode === 'library') {
      const patterns = buildPracticePatterns(domain, [], options.learningType);
      return {
        sources: [],
        exercises: [],
        patterns,
        warnings: [
          '严格参考库模式未找到可用题源片段；不要退回联网题源或外部题库。',
          ...pack.warnings.slice(0, 4),
        ],
        summary: 'Practice source search used strict library mode. Found 0 usable source-library snippets.',
      };
    }
    if (options.evidencePack) {
      const patterns = buildPracticePatterns(domain, [], options.learningType);
      return {
        sources: [],
        exercises: [],
        patterns,
        warnings: [
          '本轮资料检索没有得到可用题源片段；不要追加旧题源搜索，直接依据学习蓝图生成原创题并标注 [AI原创]。',
          ...pack.warnings.slice(0, 4),
        ],
        summary: `Practice source brief reused the material retrieval package. Found 0 usable snippets and 0 exercise assets; coverage gaps: ${pack.coverage.missing.join(', ') || 'none'}.`,
      };
    }
  }

  const queries = practiceQueries(nodeName, domain, options?.learningType, options?.bloomTarget);
  const maxSources = Math.min(options?.maxSources ?? 5, 6);
  const includeDomains = practiceIncludeDomains(domain, options?.learningType);

  const [exactRes, openRes, exaRes] = await Promise.all([
    tavilySearch(queries.exact, {
      searchDepth: 'basic',
      includeDomains,
      excludeDomains: LOW_QUALITY_DOMAINS,
      maxResults: 3,
    }).catch(() => ({ results: [] })),
    tavilySearch(queries.open, {
      searchDepth: 'basic',
      excludeDomains: LOW_QUALITY_DOMAINS,
      maxResults: 3,
    }).catch(() => ({ results: [] })),
    exaSearch(queries.semantic, { numResults: 3, useAutoprompt: true }).catch(() => ({ results: [] })),
  ]);

  const byUrl = new Map<string, { title: string; url: string; content: string; score: number }>();
  for (const r of [...exactRes.results, ...openRes.results]) {
    const score = scorePracticeArtifact(r);
    const existing = byUrl.get(r.url);
    if (!existing || score > existing.score) {
      byUrl.set(r.url, { title: r.title, url: r.url, content: r.content, score });
    }
  }
  for (const r of exaRes.results) {
    if (!r.url) continue;
    const candidate = { title: r.title, url: r.url, content: r.text, score: r.score };
    const score = scorePracticeArtifact(candidate);
    const existing = byUrl.get(r.url);
    if (!existing || score > existing.score) {
      byUrl.set(r.url, { ...candidate, score });
    }
  }

  const sources = [...byUrl.values()]
    .filter((result) => result.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSources)
    .map((result) => ({
      title:      result.title,
      url:        result.url,
      kind:       classifyPracticeSource(result.title, result.content, result.url),
      trustScore: Number(result.score.toFixed(2)),
      snippet:    result.content.slice(0, 700),
    }));

  const patterns = buildPracticePatterns(domain, sources, options?.learningType);
  const warnings = [
    '不要照搬题源原题；只提取题型结构、约束方式、答案/评分方式，再为当前 KC 生成原创或改编题。',
    '避免只问“解释/说明”类泛题；每道题都要有 KC、认知动作、题型标签和来源策略。',
    sources.length > 0
      ? '若题源可用，优先将部分题目标为“题型参考”，而不是全部标为 AI原创；只有确实无题源依据时才标 AI原创。'
      : '未找到强题源时允许 AI原创，但仍必须使用当前 learning_type 对应的情境、反思、清单或实操题型。',
  ];
  const kindList = [...new Set(sources.map((source) => source.kind))].join(', ') || 'none';
  return {
    sources,
    exercises: [],
    patterns,
    warnings,
    summary: `Practice source search used a fixed budget (2 Tavily + 1 Exa). Found ${sources.length} usable sources; source kinds: ${kindList}.`,
  };
}
