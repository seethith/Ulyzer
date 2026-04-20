/**
 * generate_outline chat tool — lets the AI generate or upgrade the knowledge
 * outline for the current node (v0→v1, v1→v2, v2→v3).
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { NodeRepository } from '../../db/repositories/node.repo';
import {
  getOutlineVersionNumber,
  generateNextOutlineVersion,
  MAX_OUTLINE_VERSION,
} from '../outline-version';
import { generateOutlineV1 } from '../sub-tutor-loop';

const nodeRepo = new NodeRepository();

interface OutlineResult { success: boolean; summary: string; version?: number }

export const generateOutlineTool: TutorTool<Record<string, never>, OutlineResult> = buildTool({
  name: 'generate_outline',
  description:
    '【做什么】为当前节点生成或升级知识纲要（KC 列表）。v0→v1（初始纲要），v1→v2（研究生深度），v2→v3（调研论文深度）。' +
    '【何时调用】用户说"帮我生成大纲"/"生成纲要"/"升级纲要"/"纲要太简单了"/"把纲要加深"/"先生成大纲"等，或用户请求生成资料但当前节点还没有纲要、需要先生成纲要时。' +
    '【限制】最高版本 v3，到顶后无法继续升级；每次只升一级；生成需要一定时间。',
  inputSchema: z.object({}),
  inputJsonSchema: { type: 'object', properties: {} },
  maxResultChars: 400,
  isReadOnly: false,
  execute: async (_input, ctx): Promise<OutlineResult> => {
    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: `节点不存在: ${ctx.nodeId}` };

    const currentVersion = getOutlineVersionNumber(ctx.courseId, ctx.nodeId);

    if (currentVersion >= MAX_OUTLINE_VERSION) {
      return {
        success: false,
        summary: `当前纲要已是最高版本 v${MAX_OUTLINE_VERSION}，无法继续升级。如需深入某个知识组件，可以请我生成专题。`,
        version: currentVersion,
      };
    }

    const opts = {
      courseId:        ctx.courseId,
      nodeId:          ctx.nodeId,
      provider:        ctx.provider,
      model:           ctx.model,
      signal:          ctx.signal,
      language:        ctx.language,
      onProgressChunk: (msg: string) => ctx.onProgress?.(msg),
      onComplete:      () => {},
    };

    if (currentVersion === 0) {
      await generateOutlineV1(opts, node);
    } else {
      await generateNextOutlineVersion(opts, node);
    }

    const newVersion = currentVersion + 1;
    return {
      success: true,
      summary: `v${newVersion} 纲要已生成并保存到「纲要」文件夹。`,
      version: newVersion,
    };
  },
  formatResult: (r) => r.summary,
});
