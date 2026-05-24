import { randomUUID } from 'crypto';
import type {
  LearningShape,
  LearningSourcePlan,
  LearningSourceSlot,
  LearningSourceType,
  LLMMessage,
  LLMProvider,
  ResearchTaskType,
  SearchMode,
} from '@shared/types';
import { getDb } from '../db/sqlite';
import { LLMAdapter } from '../llm/adapter';
import type { LearningSourcePlannerInput } from './types';

const SHAPES: LearningShape[] = [
  'knowledge_understanding',
  'skill_operation',
  'creative_project',
  'tool_software',
  'game_system',
  'social_behavior',
  'physical_training',
  'exam_course',
  'interest_exploration',
  'mixed',
];

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

const MAX_SLOTS = 8;
const MIN_SLOTS = 4;
const MAX_QUERIES_PER_SLOT = 3;

function compact(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function slug(input: string, fallback: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return value || fallback;
}

function uniqueStrings(values: unknown, max: number, itemMax = 90): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = compact(value, itemMax);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeSourceTypes(values: unknown): LearningSourceType[] {
  const raw = uniqueStrings(values, 6, 40);
  const filtered = raw.filter((item): item is LearningSourceType => SOURCE_TYPES.includes(item as LearningSourceType));
  return filtered.length > 0 ? filtered : ['tutorial', 'unknown'];
}

function fallbackShape(goal: string, taskType: ResearchTaskType): LearningShape {
  const text = goal.toLowerCase();
  if (taskType === 'roadmap' && /考试|课程|线性代数|数学|physics|calculus|algebra|course|exam|syllabus/.test(text)) return 'exam_course';
  if (/游戏|game|moba|fps|rpg|原神|王者|lol|steam/.test(text)) return 'game_system';
  if (/cosplay|绘画|摄影|剪辑|手工|服装|道具|妆造|创作|design|make|craft/.test(text)) return 'creative_project';
  if (/社交|礼仪|沟通|表达|关系|人际|领导力|etiquette|communication/.test(text)) return 'social_behavior';
  if (/健身|瑜伽|跑步|游泳|训练|fitness|workout/.test(text)) return 'physical_training';
  if (/软件|工具|photoshop|excel|figma|blender|react|python|编程|代码|api/.test(text)) return 'tool_software';
  return taskType === 'theory' ? 'knowledge_understanding' : 'mixed';
}

function slot(input: {
  id: string;
  name: string;
  purpose: string;
  mustHave?: boolean;
  priority?: LearningSourceSlot['priority'];
  queryIntents: string[];
  qualityCriteria: string[];
  acceptableSourceTypes: LearningSourceType[];
}): LearningSourceSlot {
  return {
    id: input.id,
    name: input.name,
    purpose: input.purpose,
    mustHave: input.mustHave ?? true,
    priority: input.priority ?? 'high',
    queryIntents: input.queryIntents.slice(0, MAX_QUERIES_PER_SLOT),
    qualityCriteria: input.qualityCriteria,
    acceptableSourceTypes: input.acceptableSourceTypes,
  };
}

function fallbackSlots(goal: string, taskType: ResearchTaskType, searchMode: SearchMode, seedQueries?: Array<{ query: string; purpose: string }>): LearningSourceSlot[] {
  if (seedQueries?.length) {
    const seeded = seedQueries.slice(0, 5).map((query, index) => slot({
      id: slug(query.purpose, `planned_${index + 1}`),
      name: compact(query.purpose || `规划资料 ${index + 1}`, 24),
      purpose: `围绕“${goal}”补充 ${query.purpose || '学习资料'}。`,
      mustHave: index < 3,
      priority: index < 3 ? 'high' : 'medium',
      queryIntents: [query.query],
      qualityCriteria: ['与学习目标强相关', '内容具体可读', '优先系统资料和权威来源'],
      acceptableSourceTypes: ['course_syllabus', 'tutorial', 'textbook_or_notes', 'project_or_case'],
    }));
    if (seeded.length >= MIN_SLOTS) return seeded;
  }

  const base = [
    slot({
      id: taskType === 'roadmap' ? 'learning_structure' : 'concept_framework',
      name: taskType === 'roadmap' ? '学习结构与进阶顺序' : '核心概念与结构',
      purpose: '找到能帮助建立整体框架、关键术语和进阶顺序的资料。',
      queryIntents: [
        `${goal} 学习路线 课程大纲 结构`,
        `${goal} curriculum syllabus learning objectives`,
        `${goal} open textbook lecture notes site:edu`,
      ],
      qualityCriteria: ['结构清晰', '覆盖核心主题', '适合规划学习顺序'],
      acceptableSourceTypes: ['course_syllabus', 'textbook_or_notes', 'official_doc', 'tutorial'],
    }),
    slot({
      id: 'how_to_examples',
      name: '方法步骤与案例',
      purpose: '找到可模仿的步骤、示例、作品或实际场景。',
      queryIntents: [
        `${goal} 入门 教程 步骤 案例`,
        `${goal} beginner tutorial examples`,
        `${goal} worked examples lecture notes`,
      ],
      qualityCriteria: ['步骤具体', '有案例或示例', '适合初学者实践'],
      acceptableSourceTypes: ['tutorial', 'worked_example', 'project_or_case', 'video_or_transcript'],
    }),
    slot({
      id: 'practice_projects',
      name: '练习任务与项目',
      purpose: '找到能转化为练习、作业、项目或训练任务的资料。',
      queryIntents: [
        `${goal} 练习 作业 项目`,
        `${goal} practice project assignment`,
      ],
      qualityCriteria: ['可练习', '有任务或项目', '能检验学习效果'],
      acceptableSourceTypes: ['exercise_or_assignment', 'project_or_case', 'rubric_or_assessment'],
    }),
    slot({
      id: 'mistakes_constraints',
      name: '常见误区与限制',
      purpose: '找到常见错误、风险、安全/伦理/成本限制。',
      queryIntents: [
        `${goal} 常见错误 误区 注意事项`,
        `${goal} common mistakes risks safety constraints`,
      ],
      qualityCriteria: ['指出风险或误区', '有可操作建议', '不是单纯吐槽'],
      acceptableSourceTypes: ['common_mistake', 'safety_or_constraint', 'community_experience'],
    }),
  ];

  const shape = fallbackShape(goal, taskType);
  if (shape === 'creative_project') {
    base.push(slot({
      id: 'materials_tools_safety',
      name: '材料工具与安全准备',
      purpose: '找到材料清单、工具选择、成本约束、安全注意事项和制作前准备。',
      queryIntents: [`${goal} 材料 工具 清单 安全 注意事项`, `${goal} materials tools safety checklist`],
      qualityCriteria: ['材料/工具具体', '说明安全或成本限制', '能转成准备清单'],
      acceptableSourceTypes: ['tool_material', 'safety_or_constraint', 'tutorial'],
    }));
  } else if (shape === 'game_system') {
    base.push(
      slot({
        id: 'mechanics_versions',
        name: '机制系统与版本变化',
        purpose: '找到核心机制、系统规则、版本变化或当前环境，避免学习过期资料。',
        queryIntents: [`${goal} 机制 系统 版本 攻略`, `${goal} mechanics system current version guide`],
        qualityCriteria: ['机制讲清楚', '时间/版本信息明确', '不是纯娱乐剪辑'],
        acceptableSourceTypes: ['official_doc', 'tutorial', 'video_or_transcript', 'community_experience'],
      }),
      slot({
        id: 'hands_on_play',
        name: '操作训练与实战复盘',
        purpose: '找到操作练习、实战场景、复盘方法和进阶训练任务。',
        queryIntents: [`${goal} 操作 训练 实战 复盘`, `${goal} practice drills gameplay review beginner`],
        qualityCriteria: ['有训练方法', '有实战案例', '能分层练习'],
        acceptableSourceTypes: ['tutorial', 'worked_example', 'project_or_case'],
      }),
    );
  } else if (shape === 'social_behavior') {
    base.push(slot({
      id: 'scenarios_boundaries_culture',
      name: '场景边界与文化差异',
      purpose: '找到典型场景、行为边界、文化差异和不适用条件，避免泛泛鸡汤。',
      queryIntents: [`${goal} 场景 边界 文化差异 练习`, `${goal} scenarios boundaries cultural differences practice`],
      qualityCriteria: ['有真实场景', '说明边界/差异', '能转成角色扮演或反思练习'],
      acceptableSourceTypes: ['project_or_case', 'common_mistake', 'safety_or_constraint', 'tutorial'],
    }));
  } else if (shape === 'physical_training') {
    base.push(slot({
      id: 'progression_safety',
      name: '训练进阶与安全',
      purpose: '找到动作进阶、训练负荷、安全禁忌和自检标准。',
      queryIntents: [`${goal} 训练计划 进阶 安全 禁忌`, `${goal} progression safety common mistakes training plan`],
      qualityCriteria: ['有渐进安排', '说明安全风险', '有自检/纠错方法'],
      acceptableSourceTypes: ['tutorial', 'safety_or_constraint', 'rubric_or_assessment'],
    }));
  }

  if (taskType === 'roadmap') {
    base.push(
      slot({
        id: 'textbook_toc_notes',
        name: '教材目录与讲义结构',
        purpose: '找到教材目录、章节结构、讲义或公开课程目录，避免路线图偏离主要知识结构。',
        queryIntents: [`${goal} 教材 目录 章节 讲义`, `${goal} textbook table of contents lecture notes`],
        qualityCriteria: ['有章节层级', '不是零散文章', '能支撑知识覆盖检查'],
        acceptableSourceTypes: ['textbook_or_notes', 'course_syllabus', 'reference_index'],
      }),
      slot({
        id: 'prerequisites',
        name: '前置知识与依赖',
        purpose: '识别学习前置条件、概念依赖和常见跳跃点。',
        queryIntents: [`${goal} 前置知识 先修 依赖`, `${goal} prerequisites prior knowledge dependencies`],
        qualityCriteria: ['指出先修要求', '能形成依赖顺序', '适合初学者判断起点'],
        acceptableSourceTypes: ['course_syllabus', 'textbook_or_notes', 'tutorial'],
      }),
      slot({
        id: 'objectives_assessment',
        name: '学习目标与评估方式',
        purpose: '找到学习成果、评估标准、项目或练习要求，支撑节点验收设计。',
        queryIntents: [`${goal} 学习目标 评估 项目 作业`, `${goal} learning objectives assessment project assignment`],
        qualityCriteria: ['有目标或产出', '有练习/考核方式', '可转成节点验收'],
        acceptableSourceTypes: ['course_syllabus', 'rubric_or_assessment', 'exercise_or_assignment', 'project_or_case'],
      }),
    );
  }

  if (taskType === 'practice' || taskType === 'answer') {
    base.push(slot({
      id: 'rubric_worked_examples',
      name: '评分标准与解析样例',
      purpose: '找到评分标准、答案解析、worked examples，支撑出题和答案生成。',
      queryIntents: [`${goal} rubric worked examples solutions`, `${goal} 评分标准 答案 解析`],
      qualityCriteria: ['有标准或解析', '能支撑答案生成', '难度可分层'],
      acceptableSourceTypes: ['rubric_or_assessment', 'worked_example', 'exercise_or_assignment'],
    }));
    base.push(slot({
      id: 'error_patterns',
      name: '错误模式与讲评要点',
      purpose: '找到常见错法、评分扣分点和讲评依据，避免只生成答案不解释。',
      queryIntents: [`${goal} 常见错误 易错点 讲评`, `${goal} common mistakes error patterns feedback`],
      qualityCriteria: ['能解释错误原因', '可用于反馈', '不是单纯答案列表'],
      acceptableSourceTypes: ['common_mistake', 'rubric_or_assessment', 'worked_example'],
    }));
  }

  if (taskType === 'theory') {
    base.push(slot({
      id: 'applications_context',
      name: '应用场景与边界',
      purpose: '找到概念在真实问题中的用途、适用边界和反例。',
      queryIntents: [`${goal} 应用场景 边界 例子`, `${goal} applications limitations examples`],
      qualityCriteria: ['有具体场景', '解释适用条件', '能辅助理解抽象概念'],
      acceptableSourceTypes: ['tutorial', 'project_or_case', 'common_mistake'],
    }));
  }

  if (taskType === 'freshness') {
    base.push(slot({
      id: 'official_latest',
      name: '官方最新信息',
      purpose: '找到官方文档、发布说明、变更记录或当前版本信息。',
      queryIntents: [`${goal} 最新 官方 文档 发布说明`, `${goal} latest official documentation release notes`],
      qualityCriteria: ['来源官方或高可信', '时间信息清晰', '能核对当前版本'],
      acceptableSourceTypes: ['official_doc', 'tutorial'],
    }));
  }

  if (searchMode === 'web') {
    base.push(slot({
      id: 'authority_sources',
      name: '权威来源',
      purpose: '优先查找官方、课程、教材、教育平台资料，避免只依赖个人帖子。',
      queryIntents: [`${goal} official course guide documentation`, `${goal} site:edu OR syllabus OR textbook`],
      qualityCriteria: ['来源可信', '非营销页', '有系统内容'],
      acceptableSourceTypes: ['official_doc', 'course_syllabus', 'textbook_or_notes'],
    }));
  }

  return base.slice(0, MAX_SLOTS);
}

function taskStrategyText(taskType: ResearchTaskType): string {
  if (taskType === 'roadmap') {
    return '路线图资料策略：优先真实课程结构、教材目录/讲义、学习目标、前置依赖、项目/评估、常见误区；不要只搜“roadmap 推荐”。';
  }
  if (taskType === 'practice' || taskType === 'answer') {
    return '练习/答案资料策略：优先习题、作业、项目、评分标准、worked examples、讲评依据、错误模式；不要只要概念解释。';
  }
  if (taskType === 'theory') {
    return '原理资料策略：优先核心概念、理论框架、机制解释、例子/反例、常见误区和应用场景。';
  }
  if (taskType === 'freshness') {
    return '最新信息策略：优先官方文档、发布说明、版本说明和时间明确的资料，避免旧博客。';
  }
  return '普通问答资料策略：优先精确证据片段、官方/高可信来源和已有参考库，必要时补充网页。';
}

function ensureMinimumSlots(slots: LearningSourceSlot[], goal: string, taskType: ResearchTaskType, searchMode: SearchMode): LearningSourceSlot[] {
  const byId = new Map<string, LearningSourceSlot>();
  for (const item of slots) {
    if (!item.queryIntents.length) continue;
    byId.set(item.id, item);
  }
  for (const item of fallbackSlots(goal, taskType, searchMode)) {
    if (byId.size >= MIN_SLOTS && hasCoreCoverage([...byId.values()], taskType)) break;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].slice(0, MAX_SLOTS);
}

function hasCoreCoverage(slots: LearningSourceSlot[], taskType: ResearchTaskType): boolean {
  const text = slots.map((item) => `${item.id} ${item.name} ${item.purpose}`).join('\n').toLowerCase();
  const hasStructure = /结构|框架|路线|课程|syllabus|curriculum|framework|structure|learning/.test(text);
  const hasPractice = /练习|实践|项目|案例|步骤|practice|project|example|how/.test(text);
  const hasRisk = /误区|错误|风险|限制|安全|mistake|risk|constraint|safety/.test(text);
  const taskNeed = taskType === 'practice' || taskType === 'answer'
    ? /评分|答案|解析|rubric|solution|worked/.test(text)
    : true;
  return hasStructure && hasPractice && hasRisk && taskNeed;
}

function normalizeSlot(value: unknown, index: number, goal: string): LearningSourceSlot | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? compact(rec.name, 30) : `资料槽位 ${index + 1}`;
  const queryIntents = uniqueStrings(rec.query_intents ?? rec.queryIntents ?? rec.queries, MAX_QUERIES_PER_SLOT, 120);
  if (!queryIntents.length) queryIntents.push(`${goal} ${name}`);
  const priority = rec.priority === 'low' || rec.priority === 'medium' || rec.priority === 'high'
    ? rec.priority
    : index < 3 ? 'high' : 'medium';
  return {
    id: typeof rec.id === 'string' && rec.id.trim() ? slug(rec.id, `slot_${index + 1}`) : slug(name, `slot_${index + 1}`),
    name,
    purpose: typeof rec.purpose === 'string' ? compact(rec.purpose, 180) : `查找“${goal}”相关的${name}资料。`,
    mustHave: typeof rec.must_have === 'boolean' ? rec.must_have : typeof rec.mustHave === 'boolean' ? rec.mustHave : index < 4,
    priority,
    queryIntents,
    qualityCriteria: uniqueStrings(rec.quality_criteria ?? rec.qualityCriteria, 5, 80),
    acceptableSourceTypes: normalizeSourceTypes(rec.acceptable_source_types ?? rec.acceptableSourceTypes),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  const json = first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('learning source planner returned non-object JSON');
  return parsed as Record<string, unknown>;
}

function normalizePlanObject(raw: Record<string, unknown>, input: LearningSourcePlannerInput): LearningSourcePlan {
  const slots = Array.isArray(raw.slots)
    ? raw.slots.map((item, index) => normalizeSlot(item, index, input.userGoal)).filter((item): item is LearningSourceSlot => Boolean(item))
    : [];
  const shape = SHAPES.includes(raw.learning_shape as LearningShape)
    ? raw.learning_shape as LearningShape
    : fallbackShape(input.userGoal, input.taskType);
  return {
    id: randomUUID(),
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    taskType: input.taskType,
    userGoal: compact(input.userGoal, 240),
    learningShape: shape,
    planningRationale: typeof raw.planning_rationale === 'string'
      ? compact(raw.planning_rationale, 240)
      : typeof raw.why === 'string'
        ? compact(raw.why, 240)
        : 'AI 动态规划学习资料需求。',
    slots: ensureMinimumSlots(slots, input.userGoal, input.taskType, input.searchMode),
    createdAt: new Date().toISOString(),
  };
}

function fallbackPlan(input: LearningSourcePlannerInput): LearningSourcePlan {
  return {
    id: randomUUID(),
    courseId: input.courseId,
    nodeId: input.nodeId ?? null,
    taskType: input.taskType,
    userGoal: compact(input.userGoal, 240),
    learningShape: fallbackShape(input.userGoal, input.taskType),
    planningRationale: '未调用模型或规划失败，使用通用学习资料骨架兜底。',
    slots: fallbackSlots(input.userGoal, input.taskType, input.searchMode, input.plannedQueries),
    createdAt: new Date().toISOString(),
  };
}

function plannerPrompt(input: LearningSourcePlannerInput): string {
  const seedQueries = input.plannedQueries?.length
    ? `\n已有上游检索意图，可吸收但不要机械照抄：\n${input.plannedQueries.map((item) => `- ${item.purpose}: ${item.query}`).join('\n')}\n`
    : '';
  return [
    `学习目标：${input.userGoal}`,
    `任务类型：${input.taskType}`,
    `搜索模式：${input.searchMode}`,
    seedQueries,
    '请为这个学习目标规划“学习资料需求清单”。不要硬套固定领域模板，要判断它更像知识理解、技能操作、创作项目、工具软件、游戏系统、社交行为、身体训练、考试课程、兴趣探索或混合形态。',
    taskStrategyText(input.taskType),
    '通用资料骨架仅作为底线：核心概念、理论/结构框架、案例/示例、方法/步骤、练习/项目、评估标准、常见误区、场景应用、工具材料、安全/伦理/限制。最终 slots 必须根据目标改写。',
    '输出合法 JSON 对象，不要 Markdown。',
    '字段：learning_shape, planning_rationale, slots。',
    'slots 为 4-8 项，每项字段：id, name, purpose, must_have, priority(high/medium/low), query_intents(1-3项), quality_criteria(2-5项), acceptable_source_types。',
    `acceptable_source_types 只能从这些值选：${SOURCE_TYPES.join(', ')}`,
  ].filter(Boolean).join('\n\n');
}

async function callPlannerModel(input: LearningSourcePlannerInput & { provider: string; model: string }): Promise<LearningSourcePlan> {
  let raw = '';
  let streamError: Error | null = null;
  const messages: LLMMessage[] = [{ role: 'user', content: plannerPrompt(input) }];
  await LLMAdapter.stream({
    provider: input.provider as LLMProvider,
    model: input.model,
    systemPrompt: '你是学习资料检索规划器。你只输出 JSON，负责把开放学习目标转成可执行的资料槽位和搜索意图。',
    messages,
    maxTokens: 1400,
    temperature: 0.2,
    jsonMode: true,
    signal: input.signal,
    onChunk: (chunk) => { raw += chunk; },
    onComplete: (usage) => { input.onUsage?.(usage); },
    onError: (error) => { streamError = error; },
  });
  if (streamError) throw streamError;
  return normalizePlanObject(parseJsonObject(raw), input);
}

function persistPlan(plan: LearningSourcePlan): void {
  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO learning_source_plans (
         id, course_id, node_id, task_type, user_goal, learning_shape,
         planning_rationale, slots_json, created_at
       ) VALUES (
         @id, @course_id, @node_id, @task_type, @user_goal, @learning_shape,
         @planning_rationale, @slots_json, @created_at
       )`,
    ).run({
      id: plan.id,
      course_id: plan.courseId,
      node_id: plan.nodeId ?? null,
      task_type: plan.taskType,
      user_goal: plan.userGoal,
      learning_shape: plan.learningShape,
      planning_rationale: plan.planningRationale,
      slots_json: JSON.stringify(plan.slots),
      created_at: plan.createdAt,
    });
  } catch {
    // Planning must never fail just because debug persistence is unavailable.
  }
}

export async function planLearningSources(input: LearningSourcePlannerInput): Promise<LearningSourcePlan> {
  let plan: LearningSourcePlan;
  if (input.provider && input.model) {
    try {
      plan = await callPlannerModel({ ...input, provider: input.provider, model: input.model });
    } catch {
      plan = fallbackPlan(input);
    }
  } else {
    plan = fallbackPlan(input);
  }
  persistPlan(plan);
  return plan;
}
