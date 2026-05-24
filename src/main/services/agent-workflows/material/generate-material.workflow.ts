import { runMaterialGenerationLoop } from './material-generation-loop';
import { wrapFileGenerated, wrapProgress, wrapUsage } from '../workflow-events';
import { createWorkflowLifecycle } from '../workflow-lifecycle';
import type {
  MaterialGenerateWorkflowInput,
  WorkflowDefinition,
  WorkflowRunOptions,
} from '../workflow-types';

export const materialGenerateWorkflow: WorkflowDefinition<'material.generate'> = {
  id: 'material.generate',
  async run(input: MaterialGenerateWorkflowInput, options: WorkflowRunOptions) {
    const lifecycle = createWorkflowLifecycle('material.generate', options);
    const request = options.context
      ? {
          ...input.request,
          lifecycle,
          onProgressChunk: wrapProgress(input.request.onProgressChunk, options, lifecycle),
          onComplete:      wrapUsage(input.request.onComplete, options, lifecycle),
          onFileGenerated: wrapFileGenerated(input.request.onFileGenerated, options, lifecycle),
        }
      : { ...input.request, lifecycle };
    try {
      const fileSaved = await runMaterialGenerationLoop(request);
      if (!fileSaved) {
        lifecycle.skip('verify');
        lifecycle.skip('persist_artifacts');
      }
      lifecycle.skip('emit_result');
      return { fileSaved };
    } catch (err) {
      throw lifecycle.fail(err);
    }
  },
};
