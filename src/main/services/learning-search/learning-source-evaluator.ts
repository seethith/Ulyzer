import type {
  LearningSearchCandidate,
  LearningSourceEvaluation,
  LearningSourcePlan,
  LearningSourceSlot,
  LearningShape,
  LearningSourceType,
  LLMMessage,
  LLMProvider,
  ResearchTaskType,
  TrustLevel,
} from '@shared/types';
import { streamStructuredCompletion } from '../llm/structured-stream';
import { assessSourceRisk, hostOf, scoreSourceCandidate } from '../web/source-authority';
import type { LearningCandidateEvaluationInput } from './types';

const SOURCE_TYPES: LearningSourceType[] = [
  'official_doc',
  'course_syllabus',
  'textbook_or_notes',
  'tutorial',
  'worked_example',
  'exercise_or_assignment',
  'project_or_case',
  'rubric_or_assessment',
  'common_mistake',
  'tool_material',
  'safety_or_constraint',
  'community_experience',
  'video_or_transcript',
  'reference_index',
  'unknown',
];

const COMMUNITY_FRIENDLY_SHAPES: LearningShape[] = [
  'skill_operation',
  'creative_project',
  'tool_software',
  'game_system',
  'social_behavior',
  'physical_training',
  'interest_exploration',
  'mixed',
];

const COMMUNITY_SUPPORT_SLOT_RE =
  /经验|心得|误区|错误|风险|安全|注意|限制|材料|工具|设备|成本|案例|项目|作品|实践|实战|复盘|场景|边界|文化|练习|训练|操作|技巧|流程|example|case|practice|project|mistake|risk|safety|tool|material|scenario|boundary|drill|workflow/i;
const MAX_CONDITIONAL_COMMUNITY_IMPORTS = 3;

interface LlmEvaluation {
  index: number;
  quality_score?: number;
  source_type?: LearningSourceType;
  why_useful?: string;
  limitations?: string;
  should_ingest?: boolean;
  enabled_by_default?: boolean;
  main_evidence?: boolean;
}

function compact(text: string | undefined | null, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function slotFor(plan: LearningSourcePlan, slotId: string): LearningSourceSlot | undefined {
  return plan.slots.find((slot) => slot.id === slotId);
}

function isCommunityHost(host: string): boolean {
  return /reddit|zhihu|medium|substack|csdn|51cto|juejin|stackoverflow|stackexchange|quora|tieba|bilibili|youtube|x\.com|twitter/.test(host);
}

function inferSourceType(candidate: LearningSearchCandidate, slot?: LearningSourceSlot): LearningSourceType {
  const host = hostOf(candidate.url);
  const text = `${candidate.title}\n${candidate.excerpt}\n${candidate.url}`.toLowerCase();
  if (/docs\.|developer\.|official|documentation|官方文档|官方标准|技术标准|standard/.test(text) || /\.(gov|org)$/.test(host) && /docs|developer|standard/.test(host)) return 'official_doc';
  if (/syllabus|curriculum|course outline|learning objectives|课程大纲|教学大纲|学习目标/.test(text)) return 'course_syllabus';
  if (/textbook|lecture notes|notes|chapter|openstax|教材|讲义|章节/.test(text)) return 'textbook_or_notes';
  if (/youtube|bilibili|video|transcript|视频|字幕/.test(text)) return 'video_or_transcript';
  if (isCommunityHost(host)) return 'community_experience';
  if (/rubric|assessment|grading|评分|评价|考核/.test(text)) return 'rubric_or_assessment';
  if (/exercise|problem set|assignment|practice|作业|练习|题目|习题/.test(text)) return 'exercise_or_assignment';
  if (/worked example|solution|answer|解析|答案|例题/.test(text)) return 'worked_example';
  if (/project|case study|capstone|案例|项目|作品/.test(text)) return 'project_or_case';
  if (/mistake|misconception|pitfall|common error|误区|错误|陷阱/.test(text)) return 'common_mistake';
  if (/safety|risk|constraint|precaution|伦理|安全|风险|限制|注意事项/.test(text)) return 'safety_or_constraint';
  if (/material|tool|equipment|setup|材料|工具|设备|环境/.test(text)) return 'tool_material';
  if (/tutorial|guide|how to|教程|指南|入门/.test(text)) return 'tutorial';
  return slot?.acceptableSourceTypes.find((type) => type !== 'unknown') ?? 'unknown';
}

function sourceTypeMatchesSlot(sourceType: LearningSourceType, slot?: LearningSourceSlot): boolean {
  if (!slot) return true;
  if (slot.acceptableSourceTypes.includes(sourceType)) return true;
  if (sourceType === 'community_experience' && slot.acceptableSourceTypes.includes('common_mistake')) return true;
  if (sourceType === 'tutorial' && slot.acceptableSourceTypes.includes('worked_example')) return true;
  return slot.acceptableSourceTypes.includes('unknown');
}

function scoreRule(input: {
  candidate: LearningSearchCandidate;
  slot?: LearningSourceSlot;
  taskType: ResearchTaskType;
}): { score: number; trustLevel: TrustLevel; sourceType: LearningSourceType; whyUseful: string; limitations: string; mainEvidence: boolean } {
  const sourceType = inferSourceType(input.candidate, input.slot);
  const scored = scoreSourceCandidate({
    title: input.candidate.title,
    url: input.candidate.url,
    content: input.candidate.excerpt,
    score: input.candidate.rawScore,
    provider: input.candidate.provider === 'exa' ? 'exa' : input.candidate.provider === 'tavily' ? 'tavily' : 'reflection',
    publishedDate: input.candidate.publishedDate,
  }, input.taskType, input.candidate.query);
  let score = scored.score;
  const host = hostOf(input.candidate.url);
  const text = `${input.candidate.title}\n${input.candidate.excerpt}`.toLowerCase();

  if (sourceTypeMatchesSlot(sourceType, input.slot)) score += 0.08;
  else score -= 0.12;
  if (input.slot?.mustHave) score += 0.03;
  if (input.candidate.provider === 'exa') score += 0.03;
  if (input.candidate.excerpt.length > 900) score += 0.04;
  if (input.candidate.excerpt.length < 180) score -= 0.12;
  if (/广告|购买|折扣|affiliate|subscribe|登录|注册|top \d+|best .{0,30} in 20/i.test(text)) score -= 0.1;
  if (/步骤|step|example|案例|练习|practice|project|assignment|rubric|评分|安全|risk/.test(text)) score += 0.05;
  if (sourceType === 'community_experience') score -= 0.08;
  if (isCommunityHost(host) && input.taskType === 'roadmap') score -= 0.08;

  score = Math.max(0.05, Math.min(1, score));
  const mainEvidence = score >= 0.78 && sourceType !== 'community_experience';
  return {
    score,
    trustLevel: scored.trustLevel,
    sourceType,
    whyUseful: input.slot
      ? `匹配「${input.slot.name}」：${compact(input.slot.purpose, 80)}`
      : '与当前学习目标相关，可作为补充资料。',
    limitations: sourceType === 'community_experience'
      ? '社区/个人经验资料，只适合作补充，不应作为唯一依据。'
      : score < 0.55
        ? '资料质量或匹配度偏低，暂不建议自动入库。'
        : '',
    mainEvidence,
  };
}

function communitySlotSupportsPracticeSupplement(slot?: LearningSourceSlot): boolean {
  if (!slot) return false;
  if (slot.acceptableSourceTypes.includes('community_experience')) return true;
  if (slot.acceptableSourceTypes.some((type) =>
    type === 'common_mistake'
    || type === 'safety_or_constraint'
    || type === 'project_or_case'
    || type === 'tool_material'
    || type === 'video_or_transcript',
  )) return true;
  return COMMUNITY_SUPPORT_SLOT_RE.test(`${slot.id}\n${slot.name}\n${slot.purpose}\n${slot.qualityCriteria.join('\n')}`);
}

function conditionalCommunityAllowed(input: {
  evaluation: LearningSourceEvaluation;
  plan: LearningSourcePlan;
  slot?: LearningSourceSlot;
}): boolean {
  if (input.evaluation.sourceType !== 'community_experience') return false;
  if (input.evaluation.qualityScore < 0.55 || !input.evaluation.shouldIngest) return false;
  if (!COMMUNITY_FRIENDLY_SHAPES.includes(input.plan.learningShape)) return false;
  return communitySlotSupportsPracticeSupplement(input.slot);
}

function appendLimitation(base: string, extra: string): string {
  if (!base) return extra;
  if (base.includes(extra)) return base;
  return `${base}；${extra}`;
}

function applyRiskPolicy(input: {
  evaluation: LearningSourceEvaluation;
  candidate: LearningSearchCandidate;
  taskType: ResearchTaskType;
}): LearningSourceEvaluation {
  const risk = assessSourceRisk({
    title: input.candidate.title,
    url: input.candidate.url,
    content: input.candidate.excerpt,
    trustScore: input.candidate.rawScore,
  });
  if (risk.level === 'low') return input.evaluation;

  const riskText = `来源风险：${risk.reasons.join('；')}`;
  if (risk.level === 'blocked' || risk.level === 'high') {
    return {
      ...input.evaluation,
      qualityScore: Math.min(input.evaluation.qualityScore, risk.level === 'blocked' ? 0.22 : 0.42),
      shouldIngest: false,
      enabledByDefault: false,
      mainEvidence: false,
      limitations: appendLimitation(input.evaluation.limitations, riskText),
    };
  }

  const communityOnly = risk.reasons.length === 1 && /社区|个人经验/.test(risk.reasons[0] ?? '');
  return {
    ...input.evaluation,
    qualityScore: communityOnly
      ? input.evaluation.qualityScore
      : Math.min(input.evaluation.qualityScore, 0.68),
    mainEvidence: false,
    limitations: appendLimitation(input.evaluation.limitations, riskText),
  };
}

function applyCommunityPolicy(input: {
  evaluation: LearningSourceEvaluation;
  plan: LearningSourcePlan;
  slot?: LearningSourceSlot;
  allowCommunityAutoImport?: boolean;
}): LearningSourceEvaluation {
  const { evaluation, plan, slot, allowCommunityAutoImport } = input;
  if (evaluation.sourceType !== 'community_experience') return evaluation;
  if (allowCommunityAutoImport) return { ...evaluation, mainEvidence: false };
  if (conditionalCommunityAllowed({ evaluation, plan, slot })) {
    return {
      ...evaluation,
      mainEvidence: false,
      limitations: appendLimitation(
        evaluation.limitations,
        '社区/个人经验资料，已按学习形态和槽位作为实践补充入库，不作为主依据。',
      ),
    };
  }
  return {
    ...evaluation,
    shouldIngest: false,
    enabledByDefault: false,
    mainEvidence: false,
    limitations: evaluation.limitations
      ? `${evaluation.limitations}；当前设置不允许社区/个人经验资料自动入库。`
      : '当前设置不允许社区/个人经验资料自动入库。',
  };
}

function baseEvaluation(
  candidate: LearningSearchCandidate,
  plan: LearningSourcePlan,
  taskType: ResearchTaskType,
): LearningSourceEvaluation {
  const slot = slotFor(plan, candidate.slotId);
  const rule = scoreRule({ candidate, slot, taskType });
  return {
    url: candidate.url,
    slotId: candidate.slotId,
    sourceType: rule.sourceType,
    trustLevel: rule.trustLevel,
    qualityScore: rule.score,
    whyUseful: rule.whyUseful,
    limitations: rule.limitations,
    shouldIngest: rule.score >= 0.55,
    enabledByDefault: rule.score >= 0.55,
    mainEvidence: rule.mainEvidence,
  };
}

function parseJsonArray(raw: string): unknown[] {
  const first = raw.indexOf('[');
  const last = raw.lastIndexOf(']');
  const json = first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeLlmEvaluation(value: unknown): LlmEvaluation | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.index !== 'number') return null;
  const sourceType = SOURCE_TYPES.includes(rec.source_type as LearningSourceType)
    ? rec.source_type as LearningSourceType
    : undefined;
  return {
    index: Math.floor(rec.index),
    quality_score: typeof rec.quality_score === 'number' ? Math.max(0, Math.min(1, rec.quality_score)) : undefined,
    source_type: sourceType,
    why_useful: typeof rec.why_useful === 'string' ? compact(rec.why_useful, 140) : undefined,
    limitations: typeof rec.limitations === 'string' ? compact(rec.limitations, 140) : undefined,
    should_ingest: typeof rec.should_ingest === 'boolean' ? rec.should_ingest : undefined,
    enabled_by_default: typeof rec.enabled_by_default === 'boolean' ? rec.enabled_by_default : undefined,
    main_evidence: typeof rec.main_evidence === 'boolean' ? rec.main_evidence : undefined,
  };
}

async function llmEvaluate(input: LearningCandidateEvaluationInput, base: LearningSourceEvaluation[]): Promise<LlmEvaluation[]> {
  if (!input.provider || !input.model || input.candidates.length === 0) return [];
  const candidates = input.candidates.slice(0, 14);
  const slotMap = new Map(input.plan.slots.map((slot) => [slot.id, slot]));
  const items = candidates.map((candidate, index) => {
    const slot = slotMap.get(candidate.slotId);
    return [
      `[${index}]`,
      `槽位：${slot?.name ?? candidate.slotId}`,
      `槽位目的：${slot?.purpose ?? ''}`,
      `标题：${candidate.title}`,
      `URL：${candidate.url}`,
      `摘要：${candidate.excerpt.slice(0, 550)}`,
      `规则初评分：${base[index]?.qualityScore.toFixed(2) ?? '0.50'}`,
    ].join('\n');
  }).join('\n\n');

  const messages: LLMMessage[] = [{
    role: 'user',
    content:
      `学习目标：${input.plan.userGoal}\n任务类型：${input.taskType}\n\n` +
      `请评估这些搜索候选是否适合作为学习资料。重点判断它是否系统、具体、可学习、与槽位匹配；社区经验可保留但不能当主依据。\n` +
      `硬性要求：毕业论文、开题报告、论文范文、文库/文档下载、作业答案下载、未知来源 DOC/PPT/压缩包不应入库，也不能作为 main_evidence；未知来源 PDF 只能在确有作者/机构和正文可验证时作补充。\n` +
      `只输出 JSON 数组，每项字段：index, quality_score(0-1), source_type, why_useful, limitations, should_ingest, enabled_by_default, main_evidence。\n` +
      `source_type 从这些值选：${SOURCE_TYPES.join(', ')}。\n\n${items}`,
  }];

  const result = await streamStructuredCompletion({
    provider: input.provider as LLMProvider,
    model: input.model,
    systemPrompt: '你是学习资料质量评估器。只输出 JSON 数组，不要 Markdown。',
    messages,
    maxTokens: 1600,
    temperature: 0,
    jsonMode: true,
    kind: 'json',
    language: input.language,
    signal: input.signal,
    maxContinuations: 1,
    onUsage: input.onUsage,
  });
  return parseJsonArray(result.text).map(normalizeLlmEvaluation).filter((item): item is LlmEvaluation => Boolean(item));
}

function mergeEvaluation(
  base: LearningSourceEvaluation,
  llm: LlmEvaluation | undefined,
  input: LearningCandidateEvaluationInput,
  candidate: LearningSearchCandidate,
): LearningSourceEvaluation {
  const slot = slotFor(input.plan, base.slotId);
  if (!llm) {
    return applyRiskPolicy({
      candidate,
      taskType: input.taskType,
      evaluation: applyCommunityPolicy({
        evaluation: base,
        plan: input.plan,
        slot,
        allowCommunityAutoImport: input.allowCommunityAutoImport,
      }),
    });
  }
  const qualityScore = typeof llm.quality_score === 'number'
    ? Math.max(0, Math.min(1, base.qualityScore * 0.45 + llm.quality_score * 0.55))
    : base.qualityScore;
  const sourceType = llm.source_type ?? base.sourceType;
  const mainEvidence = llm.main_evidence ?? (qualityScore >= 0.78 && sourceType !== 'community_experience');
  return applyRiskPolicy({
    candidate,
    taskType: input.taskType,
    evaluation: applyCommunityPolicy({
      evaluation: {
        ...base,
        sourceType,
        qualityScore,
        whyUseful: llm.why_useful || base.whyUseful,
        limitations: llm.limitations ?? base.limitations,
        shouldIngest: llm.should_ingest ?? qualityScore >= 0.55,
        enabledByDefault: llm.enabled_by_default ?? qualityScore >= 0.55,
        mainEvidence: sourceType === 'community_experience' ? false : mainEvidence,
      },
      plan: input.plan,
      slot,
      allowCommunityAutoImport: input.allowCommunityAutoImport,
    }),
  });
}

function capConditionalCommunityImports(
  evaluations: LearningSourceEvaluation[],
  input: LearningCandidateEvaluationInput,
): LearningSourceEvaluation[] {
  if (input.allowCommunityAutoImport) return evaluations;
  const eligible = evaluations
    .map((evaluation, index) => ({
      evaluation,
      index,
      allowed: conditionalCommunityAllowed({
        evaluation,
        plan: input.plan,
        slot: slotFor(input.plan, evaluation.slotId),
      }),
    }))
    .filter((item) => item.allowed)
    .sort((a, b) => b.evaluation.qualityScore - a.evaluation.qualityScore)
    .slice(0, MAX_CONDITIONAL_COMMUNITY_IMPORTS);
  const allowedIndexes = new Set(eligible.map((item) => item.index));
  return evaluations.map((evaluation, index) => {
    if (
      evaluation.sourceType !== 'community_experience'
      || !evaluation.shouldIngest
      || allowedIndexes.has(index)
    ) {
      return evaluation;
    }
    return {
      ...evaluation,
      shouldIngest: false,
      enabledByDefault: false,
      mainEvidence: false,
      limitations: appendLimitation(
        evaluation.limitations,
        `本轮已保留 ${MAX_CONDITIONAL_COMMUNITY_IMPORTS} 条更高质量的社区经验资料，避免参考库被经验帖占满。`,
      ),
    };
  });
}

export async function evaluateLearningCandidates(input: LearningCandidateEvaluationInput): Promise<{
  evaluations: LearningSourceEvaluation[];
  warnings: string[];
}> {
  const base = input.candidates.map((candidate) =>
    baseEvaluation(candidate, input.plan, input.taskType),
  );
  const warnings: string[] = [];
  let llm: LlmEvaluation[] = [];
  try {
    llm = await llmEvaluate(input, base);
  } catch {
    warnings.push(input.language === 'en'
      ? 'LLM quality scoring was unavailable; rule-based scoring was used.'
      : '学习资料 LLM 质量评分不可用，已使用规则评分。');
  }
  const llmByIndex = new Map(llm.map((item) => [item.index, item]));
  const evaluations = base.map((item, index) => mergeEvaluation(item, llmByIndex.get(index), input, input.candidates[index]));
  return {
    evaluations: capConditionalCommunityImports(evaluations, input),
    warnings,
  };
}
