import { materialGenerateWorkflow } from './material/generate-material.workflow';
import { outlineGenerateNextWorkflow } from './outline/generate-outline.workflow';
import { routeGenerateWorkflow } from './route/generate-route.workflow';
import { topicGenerateWorkflow } from './topic/generate-topic.workflow';
import type {
  WorkflowDefinition,
  WorkflowId,
  WorkflowInput,
  WorkflowResult,
  WorkflowRunOptions,
} from './workflow-types';

export class WorkflowRunner {
  private readonly workflows = new Map<WorkflowId, WorkflowDefinition>();

  constructor(workflows: WorkflowDefinition[] = defaultWorkflows) {
    for (const workflow of workflows) {
      this.workflows.set(workflow.id, workflow);
    }
  }

  async run<TId extends WorkflowId>(
    id: TId,
    input: WorkflowInput<TId>,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowResult<TId>> {
    options.context?.throwIfAborted();

    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);

    const result = await workflow.run(input, options);
    options.context?.throwIfAborted();
    return result as WorkflowResult<TId>;
  }
}

export const defaultWorkflows: WorkflowDefinition[] = [
  routeGenerateWorkflow,
  materialGenerateWorkflow,
  outlineGenerateNextWorkflow,
  topicGenerateWorkflow,
];

export const workflowRunner = new WorkflowRunner();
