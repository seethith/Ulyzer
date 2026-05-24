import type { ResearchTaskType, SourceKind, SourceRecord, TrustLevel } from '@shared/types';

export interface AuthorityProfile {
  officialDomains: string[];
  educationDomains: string[];
  lowQualityDomains: string[];
  freshnessSensitive: boolean;
}

export interface ScoredSourceCandidate {
  title: string;
  url: string;
  content: string;
  score: number;
  provider?: 'tavily' | 'exa' | 'library' | 'reflection';
  publishedDate?: string;
}

const LOW_QUALITY_DOMAINS = [
  'answers.com', 'ehow.com', 'blurtit.com', 'weknowtheanswer.com', 'ask.com', 'chacha.com',
  'quora.com', 'pinterest.com',
  'wenku.baidu.com', 'doc88.com', 'docin.com', 'max.book118.com', 'book118.com',
  'taodocs.com', 'renrendoc.com', 'douchai.cn', 'doc.mbalib.com',
  'studocu.com', 'coursehero.com', 'scribd.com', 'slideshare.net',
  '51paper.net', 'lw881.com', 'lw54.com', 'bylw.com', 'lunwenstudy.com',
  'paperpass.com', 'checkpass.net',
];

const CANONICAL_EDU_DOMAINS = [
  'openstax.org', 'ocw.mit.edu', 'phet.colorado.edu', 'oli.cmu.edu',
  'openlearn.open.ac.uk', 'ocw.tudelft.nl', 'nptel.ac.in',
];

const VETTED_EDU_DOMAINS = [
  'khanacademy.org', 'merlot.org', 'oercommons.org', 'coursera.org', 'edx.org',
  'britannica.com', 'brilliant.org', 'mathsisfun.com', 'betterexplained.com',
  'britishcouncil.org', 'cambridgeenglish.org', 'dictionary.cambridge.org',
  'oxfordlearnersdictionaries.com',
];

const SCHOLARLY_DOMAINS = [
  'arxiv.org', 'doi.org', 'semanticscholar.org', 'openalex.org', 'core.ac.uk',
  'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'nature.com', 'science.org',
  'springer.com', 'link.springer.com',
];

const COMMUNITY_DOMAINS = [
  'stackoverflow.com', 'stackexchange.com', 'github.com', 'reddit.com', 'medium.com',
  'substack.com', 'zhihu.com', 'juejin.cn', 'csdn.net', 'bilibili.com', 'youtube.com',
  '51cto.com', 'blog.51cto.com', 'x.com', 'twitter.com',
];

const RISKY_TITLE_RE =
  /毕业论文|本科论文|硕士论文|博士论文|学位论文|开题报告|论文范文|论文下载|论文格式|答辩|查重|代写|文库|文档下载|免费下载|资源下载|课后答案|答案解析下载|试题库|题库下载|百度文库|道客巴巴|豆丁|人人文库|原创力文档|book118|studocu|coursehero|scribd/i;

const RISKY_FILE_RE = /\.(doc|docx|ppt|pptx|xls|xlsx|rar|zip)(?:[?#].*)?$/i;

export type SourceTier =
  | 'canonical'
  | 'vetted_education'
  | 'scholarly'
  | 'supplemental'
  | 'community'
  | 'library_upload'
  | 'library_generated'
  | 'unknown'
  | 'risky';

export type SourceRiskLevel = 'low' | 'medium' | 'high' | 'blocked';

export interface SourceRiskAssessment {
  level: SourceRiskLevel;
  reasons: string[];
}

const PROFILES: Record<string, AuthorityProfile> = {
  programming: {
    officialDomains: [
      'developer.mozilla.org', 'react.dev', 'www.typescriptlang.org', 'docs.python.org',
      'nodejs.org', 'go.dev', 'doc.rust-lang.org', 'learn.microsoft.com', 'docs.github.com',
      'developer.apple.com', 'developer.android.com', 'kubernetes.io', 'docs.docker.com',
    ],
    educationDomains: ['web.dev', 'freecodecamp.org', 'realpython.com', 'www.postgresql.org', 'dev.mysql.com'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: true,
  },
  math_science: {
    officialDomains: ['openstax.org', 'ocw.mit.edu', 'phet.colorado.edu'],
    educationDomains: ['khanacademy.org', 'brilliant.org', 'mathsisfun.com', 'betterexplained.com', 'nature.com'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: false,
  },
  business: {
    officialDomains: ['hbr.org', 'mckinsey.com'],
    educationDomains: ['investopedia.com', 'coursera.org', 'edx.org', 'mindtools.com'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: true,
  },
  language: {
    officialDomains: ['cambridgeenglish.org', 'britishcouncil.org', 'bbc.co.uk'],
    educationDomains: ['dictionary.cambridge.org', 'oxfordlearnersdictionaries.com'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: false,
  },
  humanities: {
    officialDomains: ['plato.stanford.edu', 'britannica.com'],
    educationDomains: ['ocw.mit.edu', 'coursera.org', 'open.edu', 'simplypsychology.org'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: false,
  },
  general: {
    officialDomains: ['britannica.com', 'khanacademy.org', 'ocw.mit.edu'],
    educationDomains: ['coursera.org', 'edx.org', 'openstax.org', 'openlearn.open.ac.uk'],
    lowQualityDomains: LOW_QUALITY_DOMAINS,
    freshnessSensitive: false,
  },
};

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function domainMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function sourceText(input: {
  title?: string | null;
  url?: string | null;
  content?: string | null;
  filePath?: string | null;
  originalPath?: string | null;
}): string {
  return [
    input.title ?? '',
    input.url ?? '',
    input.content ?? '',
    input.filePath ?? '',
    input.originalPath ?? '',
  ].join('\n');
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^mc_/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return url.trim();
  }
}

export function detectAuthorityProfile(query: string): AuthorityProfile {
  const text = query.toLowerCase();
  if (/python|javascript|typescript|react|vue|angular|svelte|sql|postgres|mysql|git|docker|kubernetes|api|编程|代码|框架|算法|数据结构/.test(text)) {
    return PROFILES.programming;
  }
  if (/math|calculus|algebra|statistics|physics|chemistry|biology|数学|微积分|线代|物理|化学|生物/.test(text)) {
    return PROFILES.math_science;
  }
  if (/business|marketing|finance|management|strategy|商业|营销|财务|管理|战略/.test(text)) {
    return PROFILES.business;
  }
  if (/english|grammar|vocabulary|pronunciation|英语|日语|语言|语法|词汇|口语/.test(text)) {
    return PROFILES.language;
  }
  if (/history|psychology|philosophy|sociology|literature|历史|心理|哲学|社会学|文学/.test(text)) {
    return PROFILES.humanities;
  }
  return PROFILES.general;
}

export function classifyTrustLevel(input: { url?: string | null; host?: string | null; kind?: SourceKind; trustScore?: number }): TrustLevel {
  if (input.kind === 'upload' || input.kind === 'generated') return 'library';
  const host = (input.host ?? (input.url ? hostOf(input.url) : '')).toLowerCase();
  if (!host) return 'unknown';
  if (/docs\.|developer\.|learn\.|react\.dev|nodejs\.org|go\.dev|typescriptlang|python\.org|kubernetes\.io|docker\.com/.test(host)) return 'official';
  if (/\.edu$|ocw\.|openstax|stanford|mit\.edu|plato\.stanford/.test(host)) return 'academic';
  if (/khanacademy|coursera|edx|britannica|britishcouncil|cambridge|freecodecamp|web\.dev/.test(host)) return 'educational';
  if (/stackoverflow|stackexchange|github|reddit|medium|substack|zhihu|juejin|csdn|51cto/.test(host)) return 'community';
  if ((input.trustScore ?? 0) >= 0.78) return 'educational';
  return 'unknown';
}

export function classifySourceTier(input: {
  kind?: SourceKind;
  origin?: SourceRecord['origin'] | null;
  url?: string | null;
  host?: string | null;
  trustScore?: number;
}): SourceTier {
  if (input.kind === 'generated' || input.origin === 'ai_generated') return 'library_generated';
  if (input.kind === 'upload') return 'library_upload';
  const host = (input.host ?? (input.url ? hostOf(input.url) : '')).toLowerCase();
  if (!host) return 'unknown';
  if (domainMatches(host, LOW_QUALITY_DOMAINS)) return 'risky';
  if (domainMatches(host, CANONICAL_EDU_DOMAINS)) return 'canonical';
  if (/docs\.|developer\.|learn\.|react\.dev|nodejs\.org|go\.dev|typescriptlang|python\.org|kubernetes\.io|docker\.com/.test(host)) return 'canonical';
  if (domainMatches(host, VETTED_EDU_DOMAINS)) return 'vetted_education';
  if (domainMatches(host, SCHOLARLY_DOMAINS) || /\.edu$/.test(host) || /stanford|mit\.edu|plato\.stanford/.test(host)) return 'scholarly';
  if (domainMatches(host, COMMUNITY_DOMAINS)) return 'community';
  if ((input.trustScore ?? 0) >= 0.78) return 'supplemental';
  return 'unknown';
}

export function assessSourceRisk(input: {
  title?: string | null;
  url?: string | null;
  content?: string | null;
  kind?: SourceKind;
  origin?: SourceRecord['origin'] | null;
  host?: string | null;
  filePath?: string | null;
  originalPath?: string | null;
  trustScore?: number;
}): SourceRiskAssessment {
  if (input.kind === 'generated') {
    return { level: 'medium', reasons: ['AI 已生成资料只能作覆盖参考，不应作为事实权威来源'] };
  }
  const url = input.url ?? input.filePath ?? input.originalPath ?? '';
  const host = (input.host ?? (input.url ? hostOf(input.url) : '')).toLowerCase();
  const tier = classifySourceTier(input);
  const text = sourceText(input);
  const reasons: string[] = [];

  if (host && domainMatches(host, LOW_QUALITY_DOMAINS)) {
    reasons.push('命中文库/论文/答案/文档分享等低可信域名');
  }
  if (RISKY_TITLE_RE.test(text)) {
    reasons.push('标题、URL 或摘要含论文/文库/下载/答案等风险信号');
  }
  if (RISKY_FILE_RE.test(url) && tier !== 'canonical' && tier !== 'vetted_education' && tier !== 'scholarly') {
    reasons.push('未知来源的 Office/压缩文档不适合作自动学习证据');
  }
  if (/\.pdf(?:[?#].*)?$/i.test(url) && tier === 'unknown' && (input.trustScore ?? 0) < 0.72) {
    reasons.push('未知来源 PDF 可信度不足');
  }

  if (reasons.some((reason) => /文库|论文|答案|下载|文档分享/.test(reason))) {
    return { level: 'blocked', reasons };
  }
  if (reasons.length > 0) return { level: 'high', reasons };
  if (tier === 'community') return { level: 'medium', reasons: ['社区/个人经验资料只适合作补充，不应作为主依据'] };
  if (tier === 'unknown' && (input.trustScore ?? 0) < 0.58) {
    return { level: 'medium', reasons: ['来源层级未知且搜索评分偏低'] };
  }
  return { level: 'low', reasons: [] };
}

export function scoreSourceCandidate(candidate: ScoredSourceCandidate, taskType: ResearchTaskType, query: string): { score: number; trustLevel: TrustLevel } {
  const host = hostOf(candidate.url);
  const profile = detectAuthorityProfile(query);
  let score = candidate.score || 0.45;
  const trustLevel = classifyTrustLevel({ url: candidate.url, trustScore: score });
  const tier = classifySourceTier({ url: candidate.url, trustScore: score });
  const risk = assessSourceRisk({
    title: candidate.title,
    url: candidate.url,
    content: candidate.content,
    trustScore: score,
  });

  if (profile.officialDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) score += 0.22;
  if (profile.educationDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) score += 0.14;
  if (tier === 'canonical') score += 0.18;
  if (tier === 'vetted_education') score += 0.12;
  if (tier === 'scholarly') score += 0.08;
  if (tier === 'risky') score -= 0.35;
  if (/\.edu$/.test(host)) score += 0.14;
  if (trustLevel === 'official') score += 0.18;
  if (trustLevel === 'academic') score += 0.12;
  if (trustLevel === 'educational') score += 0.08;
  if (trustLevel === 'community') score -= 0.08;
  if (profile.lowQualityDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) score -= 0.25;

  const haystack = `${candidate.title}\n${candidate.content}`.toLowerCase();
  if (taskType === 'roadmap' && /syllabus|curriculum|learning objective|course outline|roadmap|prerequisite|课程大纲|教学大纲|学习目标/.test(haystack)) score += 0.12;
  if ((taskType === 'practice' || taskType === 'answer') && /exercise|problem set|assignment|lab|rubric|exam|practice|练习|作业|实验|评分/.test(haystack)) score += 0.13;
  if (taskType === 'theory' && /definition|concept|fundamental|principle|example|misconception|定义|概念|原理|示例|误区/.test(haystack)) score += 0.08;
  if (taskType === 'freshness' && candidate.publishedDate) score += 0.08;
  if (/top \d+|best .* guide|ultimate guide|complete guide/i.test(candidate.title) && trustLevel === 'unknown') score -= 0.05;
  if (candidate.content.length > 1200) score += 0.04;
  if (risk.level === 'medium') score -= 0.12;
  if (risk.level === 'high') score -= 0.28;
  if (risk.level === 'blocked') score = Math.min(score, 0.22);

  return { score: Math.max(0.05, Math.min(1, score)), trustLevel };
}

export function lowQualityDomainsFor(query: string): string[] {
  return detectAuthorityProfile(query).lowQualityDomains;
}
