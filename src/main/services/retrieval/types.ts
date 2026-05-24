import type { AgentType, EvidenceChunk, ResearchTaskType, SourceKind, SourceRecord, SourceScope, TokenUsage } from '@shared/types';

export interface RetrievalQuery {
  courseId: string;
  nodeId?: string;
  agentType?: AgentType;
  scope?: SourceScope;
  query: string;
  taskType?: ResearchTaskType;
  limit?: number;
  sourceKinds?: SourceKind[];
  llmRerank?: boolean;
  rerankProvider?: string;
  rerankModel?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

export interface RetrievalCandidate extends EvidenceChunk {
  chunkId: string;
  lexicalScore?: number;
  vectorScore?: number;
  rerankScore?: number;
  finalScore: number;
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[];
  sources: SourceRecord[];
  method: 'lexical' | 'vector' | 'hybrid';
}
