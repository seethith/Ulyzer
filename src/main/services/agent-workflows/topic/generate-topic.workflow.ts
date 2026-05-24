import { generateTopicOutline } from '../topic-generator';
import { wrapProgress, wrapUsage } from '../workflow-events';
import { createWorkflowLifecycle } from '../workflow-lifecycle';
import type {
  TopicGenerateWorkflowInput,
  WorkflowDefinition,
  WorkflowRunOptions,
} from '../workflow-types';

export const topicGenerateWorkflow: WorkflowDefinition<'topic.generate'> = {
  id: 'topic.generate',
  async run(input: TopicGenerateWorkflowInput, options: WorkflowRunOptions) {
    const lifecycle = createWorkflowLifecycle('topic.generate', options);
    try {
      const runOptions = options.context
        ? {
            ...input.options,
            onProgressChunk: wrapProgress(input.options.onProgressChunk, options, lifecycle),
            onComplete:      wrapUsage(input.options.onComplete, options, lifecycle),
          }
        : input.options;
      lifecycle.complete('prepare_context');
      lifecycle.start('retrieve_sources');
      lifecycle.start('generate_content');
      const filePath = await generateTopicOutline(runOptions, input.node);
      lifecycle.complete('retrieve_sources');
      lifecycle.complete('generate_content');
      lifecycle.skip('verify');
      lifecycle.complete('persist_artifacts', [filePath]);
      lifecycle.start('emit_result');
      lifecycle.fileGenerated({
        filePath,
        folderName: 'outline',
        nodeId: runOptions.nodeId,
      });
      lifecycle.complete('emit_result');
      return { filePath };
    } catch (err) {
      throw lifecycle.fail(err);
    }
  },
};
