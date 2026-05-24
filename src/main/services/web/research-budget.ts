import type { ResearchTaskType, SearchMode } from '@shared/types';

export interface ResearchBudget {
  maxQueries: number;
  maxResultsPerQuery: number;
  maxPagesToFetch: number;
  maxEvidenceChunks: number;
  allowReflectionSearch: boolean;
  allowLlmRerank: boolean;
}

export function inferResearchTaskType(query: string, fallback: ResearchTaskType = 'chat'): ResearchTaskType {
  const text = query.toLowerCase();
  if (/最新|今天|现在|current|latest|202[5-9]|api change|breaking change|新版本/.test(text)) return 'freshness';
  if (/路线|规划|roadmap|curriculum|syllabus|学习路径|课程大纲/.test(text)) return 'roadmap';
  if (/练习|题目|作业|实验|practice|exercise|problem set|assignment|lab|rubric/.test(text)) return 'practice';
  if (/解释|原理|概念|definition|concept|fundamental|principle|theory/.test(text)) return 'theory';
  return fallback;
}

export function buildResearchBudget(input: {
  mode: SearchMode;
  taskType: ResearchTaskType;
  maxWebResults?: number;
}): ResearchBudget {
  if (input.mode === 'off' || input.mode === 'library') {
    return {
      maxQueries: 0,
      maxResultsPerQuery: 0,
      maxPagesToFetch: 0,
      maxEvidenceChunks: 8,
      allowReflectionSearch: false,
      allowLlmRerank: false,
    };
  }

  const forced = input.mode === 'web';
  const requested = Math.max(1, Math.min(input.maxWebResults ?? (forced ? 5 : 3), 6));
  const base = {
    maxQueries: forced ? 4 : 2,
    maxResultsPerQuery: Math.min(requested, forced ? 4 : 3),
    maxPagesToFetch: forced ? 5 : 3,
    maxEvidenceChunks: forced ? 12 : 8,
    allowReflectionSearch: forced,
    allowLlmRerank: false,
  };

  if (input.taskType === 'roadmap') {
    base.maxQueries = forced ? 5 : 3;
    base.maxPagesToFetch = forced ? 5 : 3;
  } else if (input.taskType === 'practice' || input.taskType === 'answer') {
    base.maxQueries = forced ? 5 : 3;
    base.maxPagesToFetch = forced ? 5 : 3;
  } else if (input.taskType === 'freshness') {
    base.maxQueries = forced ? 5 : 3;
    base.maxPagesToFetch = forced ? 5 : 4;
    base.allowReflectionSearch = true;
  }

  return base;
}
