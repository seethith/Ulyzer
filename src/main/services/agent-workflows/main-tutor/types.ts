import type { TokenUsage } from '@shared/types';

export interface LlmNode {
  id: string;
  chapter: string;
  chapter_order?: number;
  name: string;
  description?: string;
  node_type?: string;
  difficulty?: string;
  prerequisites?: string[];
  required_tools?: string[];
  bloom_target?: string;
  learning_type?: string;
  priority?: string;
  source_ids?: string[];
  sourceIds?: string[];
  rationale?: string;
}

export interface LlmEdge {
  source: string;
  target: string;
}

export interface ChapterScopeEntry {
  nodes: string[];
  scope_distribution: Record<string, string[]>;
  boundary_notes?: string;
}

export interface LlmDagOutput {
  nodes: LlmNode[];
  edges: LlmEdge[];
}

export interface DagRepairReport {
  droppedDuplicateNodes: number;
  normalizedFields: number;
  droppedInvalidPrerequisites: number;
  truncatedSourceIds: number;
  addedPrerequisiteEdges: number;
  droppedDuplicateEdges: number;
  droppedUnknownEdges: number;
  droppedSelfLoops: number;
  droppedCycleEdges: number;
  droppedTransitiveEdges: number;
}

export interface ParsedDagOutput extends LlmDagOutput {
  repairReport: DagRepairReport;
}

export interface NodeTarget {
  min: number;
  max: number;
  chapters: string;
  label: string;
}

export interface DagGenerationResult {
  nodeCount: number;
  chapterNames: string[];
  profileText: string;
  accUsage: TokenUsage;
}
