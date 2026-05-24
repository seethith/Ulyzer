import type { EvidenceChunk, EvidenceCoverage, ResearchTaskType } from '@shared/types';

const SLOT_KEYWORDS: Record<ResearchTaskType, Record<string, RegExp>> = {
  roadmap: {
    curriculum: /syllabus|curriculum|course outline|课程大纲|教学大纲/i,
    prerequisites: /prerequisite|prior knowledge|dependency|前置|先修|依赖/i,
    learning_objectives: /learning objective|outcome|目标|学习目标|能力/i,
    practice_or_project: /project|assignment|lab|capstone|实践|项目|作业|实验/i,
    assessment: /assessment|exam|rubric|quiz|考核|考试|评分/i,
  },
  theory: {
    definition: /definition|define|概念|定义|是什么/i,
    principle: /principle|fundamental|mechanism|原理|机制|基础/i,
    example: /example|sample|case|示例|例子|案例/i,
    common_mistake: /mistake|misconception|pitfall|误区|错误|陷阱/i,
    application: /application|use case|real world|应用|场景|实践/i,
  },
  practice: {
    exercise_pattern: /exercise|problem set|practice|练习|题目|习题/i,
    worked_example: /worked example|solution|answer|解析|解答|答案/i,
    rubric: /rubric|assessment|grading|评分|评价|考核/i,
    difficulty_progression: /beginner|intermediate|advanced|easy|hard|难度|进阶/i,
    real_world_task: /project|case study|real world|scenario|项目|真实|场景/i,
  },
  answer: {
    exercise_pattern: /exercise|problem set|practice|练习|题目|习题/i,
    worked_example: /worked example|solution|answer|解析|解答|答案/i,
    rubric: /rubric|assessment|grading|评分|评价|考核/i,
    difficulty_progression: /beginner|intermediate|advanced|easy|hard|难度|进阶/i,
    real_world_task: /project|case study|real world|scenario|项目|真实|场景/i,
  },
  freshness: {
    definition: /documentation|official|docs|文档|官方/i,
    application: /release|latest|current|update|breaking|版本|更新|变化/i,
    example: /example|migration|示例|迁移/i,
  },
  chat: {
    definition: /definition|concept|定义|概念/i,
    example: /example|示例|例子/i,
    application: /application|应用|实践/i,
  },
};

export function requiredSlots(taskType: ResearchTaskType): string[] {
  return Object.keys(SLOT_KEYWORDS[taskType] ?? SLOT_KEYWORDS.chat);
}

export function classifyEvidenceSlot(text: string, taskType: ResearchTaskType): string | undefined {
  const slots = SLOT_KEYWORDS[taskType] ?? SLOT_KEYWORDS.chat;
  for (const [slot, pattern] of Object.entries(slots)) {
    if (pattern.test(text)) return slot;
  }
  return undefined;
}

export function evaluateEvidenceCoverage(taskType: ResearchTaskType, chunks: EvidenceChunk[]): EvidenceCoverage {
  const required = requiredSlots(taskType);
  const covered = new Set<string>();
  for (const chunk of chunks) {
    const slot = chunk.slot ?? classifyEvidenceSlot(chunk.text, taskType);
    if (slot) covered.add(slot);
  }
  return {
    required,
    covered: required.filter((slot) => covered.has(slot)),
    missing: required.filter((slot) => !covered.has(slot)),
  };
}

export function formatCoverageWarning(coverage: EvidenceCoverage, language?: string): string | null {
  if (coverage.missing.length === 0) return null;
  return language === 'en'
    ? `Evidence coverage is missing: ${coverage.missing.join(', ')}. Mark unsupported parts as AI-generated or needs verification.`
    : `证据覆盖仍缺：${coverage.missing.join('、')}。无来源支持的部分请标注为 AI补充 或 待核实。`;
}
