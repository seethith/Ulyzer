import type { WebContents } from 'electron';
import type { DagNode } from '@shared/types';
import type { AgentRequest } from '../agent-core/orchestrator';
import type { AgentRunContext } from '../agent-core/run-context';
import type { MaterialGenerationRequest } from './material/material-generation-loop';
import type { WorkflowLifecycle } from './workflow-lifecycle';
import type { DagGenerationResult } from './main-tutor/types';
import type { OutlineGenerateNextOptions } from './outline-version';
import type { TopicGenerateOptions } from './topic-generator';

export type WorkflowId =
  | 'route.generate'
  | 'material.generate'
  | 'outline.generateNext'
  | 'topic.generate';

export interface WorkflowRunOptions {
  context?: AgentRunContext;
}

export interface RouteGenerateWorkflowInput {
  req: AgentRequest;
  sender: WebContents;
  topic?: string;
  generate: (
    req: AgentRequest,
    sender: WebContents,
    topicOverride?: string,
    context?: AgentRunContext,
    lifecycle?: WorkflowLifecycle,
  ) => Promise<DagGenerationResult>;
}

export interface MaterialGenerateWorkflowInput {
  request: MaterialGenerationRequest;
}

export interface OutlineGenerateNextWorkflowInput {
  options: OutlineGenerateNextOptions;
  node: DagNode;
}

export interface TopicGenerateWorkflowInput {
  options: TopicGenerateOptions;
  node: DagNode;
}

export interface MaterialGenerateWorkflowResult {
  fileSaved: boolean;
}

export interface OutlineGenerateNextWorkflowResult {
  version: number;
  skipped: boolean;
  generatedVersions?: number[];
  staleVersions?: number[];
}

export interface TopicGenerateWorkflowResult {
  filePath: string;
}

export interface WorkflowInputMap {
  'route.generate': RouteGenerateWorkflowInput;
  'material.generate': MaterialGenerateWorkflowInput;
  'outline.generateNext': OutlineGenerateNextWorkflowInput;
  'topic.generate': TopicGenerateWorkflowInput;
}

export interface WorkflowResultMap {
  'route.generate': DagGenerationResult;
  'material.generate': MaterialGenerateWorkflowResult;
  'outline.generateNext': OutlineGenerateNextWorkflowResult;
  'topic.generate': TopicGenerateWorkflowResult;
}

export type WorkflowInput<TId extends WorkflowId> = WorkflowInputMap[TId];
export type WorkflowResult<TId extends WorkflowId> = WorkflowResultMap[TId];

export interface WorkflowDefinition<TId extends WorkflowId = WorkflowId> {
  id: TId;
  run(
    input: WorkflowInput<TId>,
    options: WorkflowRunOptions,
  ): Promise<WorkflowResult<TId>>;
}
