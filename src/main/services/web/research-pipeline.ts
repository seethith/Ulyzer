import type { EvidencePack, LearningSourcePlan, ResearchTaskType, SearchMode, SourceRecord, TokenUsage } from '@shared/types';
import type { PlannedQuery } from './query-planner';
import { assessSourceRisk, classifySourceTier, classifyTrustLevel, type SourceTier } from './source-authority';
import { collectLearningSources } from '../learning-search/learning-search-service';
import { formatSourceLearningMetadataForAgent } from '../learning-search/learning-source-metadata';
import { formatSourceSemanticProfileForAgent } from '../source/source-semantic-format';

function sourceLabel(source: SourceRecord, index: number): string {
  const name = source.host || source.filePath || source.kind;
  return `[S${index + 1}] ${source.title}${name ? ` (${name})` : ''}`;
}

function tierLabel(tier: SourceTier, language?: string): string {
  const zh: Record<SourceTier, string> = {
    canonical: '权威核心',
    vetted_education: '可信教育',
    scholarly: '学术研究',
    supplemental: '补充资料',
    community: '社区经验',
    library_upload: '本地上传',
    library_generated: 'AI 已生成',
    unknown: '未知来源',
    risky: '风险来源',
  };
  const en: Record<SourceTier, string> = {
    canonical: 'canonical',
    vetted_education: 'vetted education',
    scholarly: 'scholarly',
    supplemental: 'supplemental',
    community: 'community',
    library_upload: 'library upload',
    library_generated: 'AI generated',
    unknown: 'unknown',
    risky: 'risky',
  };
  return (language === 'en' ? en : zh)[tier];
}

function sourceGroupTitle(source: SourceRecord, language?: string): string {
  const tier = classifySourceTier(source);
  if (tier === 'canonical' || tier === 'vetted_education' || tier === 'scholarly') {
    return language === 'en' ? 'Authoritative / vetted sources' : '权威或可信依据';
  }
  if (tier === 'library_generated' || source.kind === 'generated') {
    return language === 'en' ? 'Existing AI-generated materials (coverage reference only)' : '已有 AI 生成资料（仅作覆盖参考）';
  }
  if (tier === 'library_upload') {
    return language === 'en' ? 'Local library uploads' : '本地参考库资料';
  }
  if (tier === 'community') {
    return language === 'en' ? 'Community / experience supplements' : '社区经验补充';
  }
  if (tier === 'risky') {
    return language === 'en' ? 'Risky / low-confidence sources' : '风险或低可信来源';
  }
  return language === 'en' ? 'Supplemental sources' : '补充资料';
}

export function formatEvidencePack(pack: EvidencePack, language?: string): string {
  if (pack.sources.length === 0 && pack.chunks.length === 0) {
    const empty = language === 'en'
      ? '(No evidence sources found. Clearly mark unsupported claims as [AI Supplement] or [Needs verification].)'
      : '（未找到证据来源。请将无来源支持的内容明确标注为 [AI补充] 或 [待核实]。）';
    if (pack.warnings.length === 0) return empty;
    const title = language === 'en' ? '\n\n## Search process' : '\n\n## 检索过程';
    return `${empty}${title}\n${pack.warnings.map((warning) => `- ${warning}`).join('\n')}`;
  }

  const sourceIndex = new Map(pack.sources.map((source, index) => [source.id, index]));
  const lines: string[] = [];
  const plan = (pack as EvidencePack & { plan?: LearningSourcePlan }).plan;
  lines.push(language === 'en'
    ? '# Evidence Sources (cite with [S1], [S2] where relevant)'
    : '# 证据来源（相关事实请用 [S1]、[S2] 标注）');
  if (plan) {
    lines.push(language === 'en'
      ? `## Learning Source Plan\nShape: ${plan.learningShape}\nSlots: ${plan.slots.map((slot) => `${slot.name}${slot.mustHave ? '*' : ''}`).join(', ')}\nRationale: ${plan.planningRationale}`
      : `## 学习资料需求规划\n学习形态：${plan.learningShape}\n资料槽位：${plan.slots.map((slot) => `${slot.name}${slot.mustHave ? '*' : ''}`).join('、')}\n规划依据：${plan.planningRationale}`);
  }
  const groupedSources = new Map<string, Array<{ source: SourceRecord; index: number }>>();
  pack.sources.forEach((source, index) => {
    const title = sourceGroupTitle(source, language);
    const group = groupedSources.get(title) ?? [];
    group.push({ source, index });
    groupedSources.set(title, group);
  });
  for (const [groupTitle, group] of groupedSources) {
    lines.push(`\n## ${groupTitle}`);
    group.forEach(({ source, index }) => {
      const trustLevel = classifyTrustLevel({ kind: source.kind, host: source.host, url: source.url, trustScore: source.trustScore });
      const tier = classifySourceTier(source);
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
      const learningMeta = formatSourceLearningMetadataForAgent(source.id);
      const semanticProfile = formatSourceSemanticProfileForAgent(source, { maxItems: 5 });
      lines.push(
        `${sourceLabel(source, index)}\n` +
        `source_id：${source.id}\n` +
        `${language === 'en' ? 'Source' : '来源'}：${source.url ?? source.filePath ?? source.kind}\n` +
        `${language === 'en' ? 'Tier' : '来源层级'}：${tierLabel(tier, language)}\n` +
        `${language === 'en' ? 'Trust' : '可信度'}：${trustLevel} · ${source.trustScore.toFixed(2)}` +
        `${risk.level !== 'low' ? `\n${language === 'en' ? 'Risk' : '风险'}：${risk.level} · ${risk.reasons.join(language === 'en' ? '; ' : '；')}` : ''}` +
        `${learningMeta ? `\n${learningMeta}` : ''}` +
        `${semanticProfile ? `\n${semanticProfile}` : ''}`,
      );
    });
  }
  if (pack.chunks.length > 0) {
    lines.push(language === 'en' ? '\n## Evidence snippets' : '\n## 证据片段');
    pack.chunks.slice(0, 8).forEach((chunk) => {
      const index = sourceIndex.get(chunk.sourceId) ?? 0;
      const slot = chunk.slot ? ` (${chunk.slot})` : '';
      lines.push(`[S${index + 1}]${slot} ${chunk.text.slice(0, 900)}`);
    });
  }
  if (pack.coverage.missing.length > 0) {
    lines.push(language === 'en' ? '\n## Coverage gaps' : '\n## 覆盖缺口');
    lines.push(pack.coverage.missing.join(language === 'en' ? ', ' : '、'));
  }
  if (pack.warnings.length > 0) {
    lines.push(language === 'en' ? '\n## Warnings' : '\n## 检索提示');
    lines.push(...pack.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n\n');
}

export function summarizeEvidencePack(pack: EvidencePack, language?: string): string {
  const libraryCount = pack.sources.filter((s) => s.kind === 'upload' || s.kind === 'generated').length;
  const generatedCount = pack.sources.filter((s) => s.kind === 'generated').length;
  const webCount = pack.sources.filter((s) => s.kind === 'web').length;
  const officialCount = pack.sources.filter((s) =>
    classifyTrustLevel({ kind: s.kind, host: s.host, url: s.url, trustScore: s.trustScore }) === 'official',
  ).length;
  const vettedCount = pack.sources.filter((s) => {
    const tier = classifySourceTier(s);
    return tier === 'canonical' || tier === 'vetted_education' || tier === 'scholarly';
  }).length;
  const reflection = pack.budgetUsed.reflectionSearches > 0
    ? language === 'en' ? ` · follow-up ${pack.budgetUsed.reflectionSearches}` : ` · 补搜 ${pack.budgetUsed.reflectionSearches}`
    : '';
  const gaps = pack.coverage.missing.length > 0
    ? language === 'en' ? ` · gaps ${pack.coverage.missing.length}` : ` · 缺口 ${pack.coverage.missing.length}`
    : '';
  return language === 'en'
    ? `Source scan: library ${libraryCount} · AI-generated ${generatedCount} · vetted ${vettedCount} · official ${officialCount} · web ${webCount}${reflection}${gaps}\n`
    : `检索参考库 ${libraryCount} 条 · AI生成 ${generatedCount} 条 · 可信依据 ${vettedCount} 条 · 官方来源 ${officialCount} 条 · 网页补充 ${webCount} 条${reflection}${gaps}\n`;
}

export async function collectEvidencePack(input: {
  query: string;
  courseId: string;
  nodeId?: string;
  mode?: SearchMode;
  taskType?: ResearchTaskType;
  maxWebResults?: number;
  plannedQueries?: PlannedQuery[];
  language?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<EvidencePack> {
  return collectLearningSources(input);
}
