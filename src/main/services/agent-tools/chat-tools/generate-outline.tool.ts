/**
 * generate_outline chat tool — lets the AI generate or complete the three
 * foundation blueprints for the current node (v1 learning, v2 practice,
 * v3 review).
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool, truncateResult } from '../tutor-tools/index';
import { NodeRepository } from '../../db/repositories/node.repo';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import { MAX_OUTLINE_VERSION } from '../../agent-workflows/outline-version';
import { getLatestOutlinePath, getNodeDir } from '../../fs/content.service';
import { getArtifactDisplayName } from '../../agent-i18n/artifact-names';
import { localMsg, message } from '../../agent-i18n/messages';
import { toolDescription } from '../../agent-i18n/tool-descriptions';
import { usageLedger } from '../../llm/usage-ledger';

const nodeRepo = new NodeRepository();

interface OutlineResult {
  success: boolean;
  summary: string;
  version?: number;
  generatedVersions?: number[];
  path?: string;
  preview?: string;
  contentChars?: number;
  language?: string;
}

function readLatestOutlinePreview(courseId: string, nodeId: string, maxChars = 1_800): {
  path?: string;
  preview?: string;
  contentChars?: number;
} {
  const outlinePath = getLatestOutlinePath(courseId, nodeId);
  if (!outlinePath || !fs.existsSync(outlinePath)) return {};
  try {
    const content = fs.readFileSync(outlinePath, 'utf-8').trim();
    const relPath = nodePath.relative(getNodeDir(courseId, nodeId), outlinePath).split(nodePath.sep).join('/');
    return {
      path: relPath,
      preview: content.slice(0, maxChars),
      contentChars: content.length,
    };
  } catch {
    return {};
  }
}

export const generateOutlineTool: TutorTool<Record<string, never>, OutlineResult> = buildTool({
  name: 'generate_outline',
  description: toolDescription('generate_outline'),
  inputSchema: z.object({}),
  inputJsonSchema: { type: 'object', properties: {} },
  maxResultChars: 3000,
  isReadOnly: false,
  execute: async (_input, ctx): Promise<OutlineResult> => {
    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: message('nodeNotFound', ctx.language, { nodeId: ctx.nodeId }) };

    const useRunContext = Boolean(ctx.runContext);
    const result = await workflowRunner.run('outline.generateNext', {
      options: {
        courseId:        ctx.courseId,
        nodeId:          ctx.nodeId,
        provider:        ctx.provider,
        model:           ctx.model,
        signal:          ctx.signal,
        language:        ctx.language,
        searchMode:      ctx.searchMode,
        onProgressChunk: useRunContext ? () => {} : (msg: string) => ctx.onProgress?.(msg),
        onComplete:      (usage) => {
          if (!useRunContext) {
            usageLedger.record({
              sessionId: ctx.sessionId,
              courseId: ctx.courseId,
              provider: ctx.provider,
              model: ctx.model,
              usage,
              source: 'chat_tool_generate_outline',
            });
          }
        },
      },
      node,
    }, { context: ctx.runContext });

    if (result.skipped) {
      const preview = readLatestOutlinePreview(ctx.courseId, ctx.nodeId);
      return {
        success: true,
        summary: message('outlineBundleAlreadyReady', ctx.language, { version: MAX_OUTLINE_VERSION }),
        version: result.version,
        generatedVersions: [],
        language: ctx.language,
        ...preview,
      };
    }

    const preview = readLatestOutlinePreview(ctx.courseId, ctx.nodeId);
    return {
      success: true,
      summary: message('outlineBundleSaved', ctx.language, {
        versions: (result.generatedVersions ?? [result.version]).map((version) => `v${version}`).join(', '),
        folder:  getArtifactDisplayName('outline', ctx.language),
      }),
      version: result.version,
      generatedVersions: result.generatedVersions,
      language: ctx.language,
      ...preview,
    };
  },
  formatResult: (r) => {
    if (!r.preview) return r.summary;
    const hasMore = (r.contentChars ?? 0) > r.preview.length;
    const parts = [
      r.summary,
      r.path ? localMsg(r.language, `文件：${r.path}`, `File: ${r.path}`) : undefined,
      localMsg(r.language, '预览：', 'Preview:'),
      `${r.preview}${hasMore ? message('contentTruncated', r.language) : ''}`,
      localMsg(
        r.language,
        '提示：三层基础蓝图已在纲要文件夹中；预览默认展示最新的复盘与深化蓝图。除非用户明确要求展示全文，否则不要继续调用 read_file 或 search_knowledge 查找同一纲要。',
        'Note: the three foundation blueprints are in the Outline folder; the preview shows the latest review/deepening blueprint. Unless the user explicitly asks for the full text, do not call read_file or search_knowledge for the same outline.',
      ),
    ].filter(Boolean).join('\n\n');
    return truncateResult(parts, 3000, r.language);
  },
});
