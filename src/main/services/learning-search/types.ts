import type {
  EvidenceChunk,
  EvidencePack,
  LearningSearchCandidate,
  LearningSourceEvaluation,
  LearningSourcePlan,
  LearningSourceSlot,
  ResearchTaskType,
  SearchMode,
  SourceRecord,
  TokenUsage,
} from '@shared/types';
import type { PlannedQuery } from '../web/query-planner';

export interface CollectLearningSourcesInput {
  courseId: string;
  nodeId?: string;
  query: string;
  userGoal?: string;
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
}

export interface LearningSourcePlannerInput {
  courseId: string;
  nodeId?: string;
  taskType: ResearchTaskType;
  userGoal: string;
  searchMode: SearchMode;
  language?: string;
  provider?: string;
  model?: string;
  plannedQueries?: PlannedQuery[];
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

export interface LearningSearchExecutionInput {
  plan: LearningSourcePlan;
  taskType: ResearchTaskType;
  maxQueries: number;
  maxResultsPerQuery: number;
  searchDepth: 'basic' | 'advanced';
  useExa?: boolean;
  signal?: AbortSignal;
}

export interface LearningSearchExecutionResult {
  candidates: LearningSearchCandidate[];
  queriesUsed: Array<{ slotId: string; slotName: string; query: string }>;
  warnings: string[];
}

export interface LearningCandidateReadInput {
  candidates: LearningSearchCandidate[];
  evaluations: LearningSourceEvaluation[];
  plan: LearningSourcePlan;
  courseId: string;
  nodeId?: string;
  taskType: ResearchTaskType;
  maxPagesToFetch: number;
  maxEvidenceChunks: number;
  autoIngest?: boolean;
}

export interface LearningCandidateReadResult {
  sources: SourceRecord[];
  chunks: EvidenceChunk[];
  pagesFetched: number;
  warnings: string[];
}

export interface LearningCandidateEvaluationInput {
  candidates: LearningSearchCandidate[];
  plan: LearningSourcePlan;
  taskType: ResearchTaskType;
  provider?: string;
  model?: string;
  allowCommunityAutoImport?: boolean;
  language?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

export interface LearningSearchResult extends EvidencePack {
  plan?: LearningSourcePlan;
}

export function sortSlotsForSearch(slots: LearningSourceSlot[]): LearningSourceSlot[] {
  const priorityScore = { high: 3, medium: 2, low: 1 };
  return [...slots].sort((a, b) =>
    Number(b.mustHave) - Number(a.mustHave)
    || priorityScore[b.priority] - priorityScore[a.priority]
    || a.name.localeCompare(b.name),
  );
}
