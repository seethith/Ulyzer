import type {
  RouteGenerateWorkflowInput,
  WorkflowDefinition,
  WorkflowRunOptions,
} from '../workflow-types';
import { createWorkflowLifecycle } from '../workflow-lifecycle';

export const routeGenerateWorkflow: WorkflowDefinition<'route.generate'> = {
  id: 'route.generate',
  async run(input: RouteGenerateWorkflowInput, options: WorkflowRunOptions) {
    const lifecycle = createWorkflowLifecycle('route.generate', options);
    const topic = input.topic ?? input.req.userMessage;
    try {
      return await input.generate({ ...input.req, userMessage: topic }, input.sender, topic, options.context, lifecycle);
    } catch (err) {
      throw lifecycle.fail(err);
    }
  },
};
