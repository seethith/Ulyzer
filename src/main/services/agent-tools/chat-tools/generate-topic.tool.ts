/**
 * generate_topic chat tool — lets the AI generate a Topic outline for a specific KC
 * after the user has explicitly confirmed they want to deep-dive.
 *
 * The AI must NOT call this tool until the user has confirmed the proposal.
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { NodeRepository } from '../../db/repositories/node.repo';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import { getArtifactDisplayName } from '../../agent-i18n/artifact-names';
import { message } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';

const nodeRepo = new NodeRepository();

interface TopicResult { success: boolean; summary: string }

export const generateTopicTool: TutorTool<{ kcId: string; kcName: string }, TopicResult> = buildTool({
  name: 'generate_topic',
  description: toolDescription('generate_topic'),
  inputSchema: z.object({
    kcId:   z.string().min(1),
    kcName: z.string().min(1),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['kcId', 'kcName'],
    properties: {
      kcId:   { type: 'string', description: toolPropertyDescription('generate_topic', 'kcId') },
      kcName: { type: 'string', description: toolPropertyDescription('generate_topic', 'kcName') },
    },
  },
  maxResultChars: 500,
  isReadOnly: false,
  execute: async (input, ctx): Promise<TopicResult> => {
    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: message('nodeNotFound', ctx.language, { nodeId: ctx.nodeId }) };

    try {
      const useRunContext = Boolean(ctx.runContext);
      await workflowRunner.run('topic.generate', {
        options: {
          courseId: ctx.courseId,
          nodeId:   ctx.nodeId,
          kcId:     input.kcId,
          kcName:   input.kcName,
          provider: ctx.provider,
          model:    ctx.model,
          signal:   ctx.signal,
          language: ctx.language,
          searchMode: ctx.searchMode,
          onProgressChunk: useRunContext ? () => {} : (msg) => ctx.onProgress?.(msg),
        },
        node,
      }, { context: ctx.runContext });
      return {
        success: true,
        summary: message('topicOutlineGenerated', ctx.language, {
          topic:  input.kcName,
          folder: getArtifactDisplayName('outline', ctx.language),
        }),
      };
    } catch (err) {
      return { success: false, summary: message('topicGenerationFailed', ctx.language, { error: String(err) }) };
    }
  },
  formatResult: (r) => r.summary,
});
