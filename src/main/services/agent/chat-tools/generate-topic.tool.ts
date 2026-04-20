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
import { generateTopicOutline } from '../topic-generator';

const nodeRepo = new NodeRepository();

interface TopicResult { success: boolean; summary: string }

export const generateTopicTool: TutorTool<{ kcId: string; kcName: string }, TopicResult> = buildTool({
  name: 'generate_topic',
  description:
    '【做什么】为指定 KC 生成专题纲要，把该知识组件当作独立研究对象深度展开，保存到纲要文件夹。' +
    '【何时调用】用户明确确认开启专题后（如回复"是""确认""帮我生成"等确认词）才调用。' +
    '【重要约束】必须先向用户提议并等待确认，不得主动或未经确认调用；用户只是提问时直接回答即可。',
  inputSchema: z.object({
    kcId:   z.string().min(1),
    kcName: z.string().min(1),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['kcId', 'kcName'],
    properties: {
      kcId:   { type: 'string', description: 'KC 编号，如 "KC3"' },
      kcName: { type: 'string', description: 'KC 名称，如 "变量作用域"' },
    },
  },
  maxResultChars: 500,
  isReadOnly: false,
  execute: async (input, ctx): Promise<TopicResult> => {
    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: `节点不存在: ${ctx.nodeId}` };

    try {
      await generateTopicOutline(
        {
          courseId: ctx.courseId,
          nodeId:   ctx.nodeId,
          kcId:     input.kcId,
          kcName:   input.kcName,
          provider: ctx.provider,
          model:    ctx.model,
          signal:   ctx.signal,
          language: ctx.language,
          onProgressChunk: (msg) => ctx.onProgress?.(msg),
        },
        node,
      );
      const isEn = ctx.language === 'en';
      return {
        success: true,
        summary: isEn
          ? `Topic outline for "${input.kcName}" generated and saved to Outline folder. You can now request theory materials or practice exercises based on this topic.`
          : `专题纲要「${input.kcName}」已生成并保存到「纲要」文件夹。你可以基于该专题纲要继续请求生成原理资料或实践题。`,
      };
    } catch (err) {
      return { success: false, summary: ctx.language === 'en' ? `Topic generation failed: ${String(err)}` : `专题生成失败：${String(err)}` };
    }
  },
  formatResult: (r) => r.summary,
});
