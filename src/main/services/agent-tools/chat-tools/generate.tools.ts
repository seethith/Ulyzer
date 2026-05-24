/**
 * Chat-context generation tools — trigger workflow-backed material generation so the AI can trigger
 * material generation during a normal conversation without slash commands.
 *
 * Each tool streams content to the user in real-time via ctx.onChunk,
 * then returns a short summary that the AI can reference when continuing the
 * conversation. The outer streamWithTools loop handles LLM_STREAM_END.
 */
import { z } from 'zod';
import * as nodePath from 'path';
import { OUTLINE_VERSION_KEYS, type GenerateFolder, type OutlineVersionSelection } from '@shared/types';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import type { TutorTool, ToolContext } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { getArtifactDisplayName } from '../../agent-i18n/artifact-names';
import { message } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { localMsg } from '../../prompt/prompt-builder';
import { usageLedger } from '../../llm/usage-ledger';

// ── Shared result type ────────────────────────────────────────────────────────

interface GenerationResult {
  success: boolean;
  fileName?: string;
  summary: string;
}

// ── Shared generation helper ──────────────────────────────────────────────────

async function runGeneration(
  folder: GenerateFolder,
  topic: string | undefined,
  ctx: ToolContext,
  customInstructions?: string,
  outlineVersion?: OutlineVersionSelection,
): Promise<GenerationResult> {
  if (!ctx.nodeId) return { success: false, summary: message('noNodeSelectedGenerateMaterial', ctx.language) };

  const folderLabel = getArtifactDisplayName(folder, ctx.language);
  const baseUserMessage = customInstructions
    ? customInstructions
    : topic
      ? localMsg(ctx.language, `请重点围绕「${topic}」生成${folderLabel}`, `Please generate ${folderLabel} focused on "${topic}"`)
      : localMsg(ctx.language, '请帮我生成相关学习资料', 'Please generate learning materials for this node');
  const userMessage = baseUserMessage;

  let primaryFileName: string | undefined;
  let secondaryFileName: string | undefined;
  const useRunContext = Boolean(ctx.runContext);

  const workflowResult = await workflowRunner.run('material.generate', {
    request: {
      sessionId:       ctx.sessionId,
      courseId:        ctx.courseId,
      nodeId:          ctx.nodeId,
      provider:        ctx.provider,
      model:           ctx.model,
      targetFolder:    folder,
      userMessage,
      signal:          ctx.signal,
      language:        ctx.language,
      searchMode:      ctx.searchMode,
      outlineVersion: ctx.outlineVersion ?? outlineVersion,
      onChunk:         () => {},   // suppress inner-loop content; outer model sees formatResult summary
      onProgressChunk: useRunContext ? () => {} : (chunk) => ctx.onProgress(chunk),
      onComplete:      (usage) => {
        if (!useRunContext) {
          usageLedger.record({
            sessionId: ctx.sessionId,
            courseId: ctx.courseId,
            provider: ctx.provider,
            model: ctx.model,
            usage,
            source: `chat_tool_generate_${folder}`,
          });
        }
      },
      onError:         (err) => ctx.onProgress(message('generationFailedProgress', ctx.language, { error: err })),
      onFileGenerated: (payload) => {
        const fileName = nodePath.basename(payload.filePath);
        if (payload.folderName === folder) {
          primaryFileName ??= fileName;
        } else {
          secondaryFileName ??= fileName;
        }
        if (!useRunContext) ctx.onFileGenerated(payload);
      },
    },
  }, { context: ctx.runContext });

  const savedFileName = primaryFileName ?? secondaryFileName;
  const success = Boolean(savedFileName) || Boolean(workflowResult.fileSaved);
  const savedFolderLabel = primaryFileName
    ? folderLabel
    : folder === 'practice'
      ? getArtifactDisplayName('answer', ctx.language)
      : folderLabel;
  const pairedAnswerNote = folder === 'practice' && primaryFileName && secondaryFileName
    ? localMsg(ctx.language, `\n参考答案已保存至「${getArtifactDisplayName('answer', ctx.language)}」：${secondaryFileName}`, `\nAnswer key saved to "${getArtifactDisplayName('answer', ctx.language)}": ${secondaryFileName}`)
    : '';
  return {
    success,
    fileName: savedFileName,
    summary:  savedFileName
      ? message('generatedSavedToFolder', ctx.language, {
          folder:   savedFolderLabel,
          filename: savedFileName,
        }) + pairedAnswerNote
      : success
        ? localMsg(ctx.language, `${folderLabel}生成流程已完成，但未收到具体文件名。`, `${folderLabel} generation completed, but no file name was returned.`)
        : localMsg(
            ctx.language,
            `${folderLabel}生成流程没有保存文件。不要自动重复调用同一个生成工具；请如实告诉用户失败原因，等待用户确认后再重试。`,
            `${folderLabel} generation did not save a file. Do not automatically call the same generation tool again; report the failure honestly and wait for user confirmation before retrying.`,
          ),
  };
}

// ── generate_theory ───────────────────────────────────────────────────────────

export const generateTheoryTool: TutorTool<{ topic?: string; custom_instructions?: string; outline_version?: OutlineVersionSelection }, GenerationResult> = buildTool({
  name: 'generate_theory',
  description: toolDescription('generate_theory'),
  inputSchema: z.object({
    topic: z.string().optional(),
    custom_instructions: z.string().optional(),
    outline_version: z.enum(OUTLINE_VERSION_KEYS).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: toolPropertyDescription('generate_theory', 'topic') },
      custom_instructions: { type: 'string', description: toolPropertyDescription('generate_theory', 'custom_instructions') },
      outline_version: {
        type: 'string',
        enum: [...OUTLINE_VERSION_KEYS],
        description: toolPropertyDescription('generate_theory', 'outline_version'),
      },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: (input, ctx) => runGeneration('theory', input.topic, ctx, input.custom_instructions, input.outline_version),
  formatResult: (r) => r.summary,
});

// ── generate_practice ─────────────────────────────────────────────────────────

export const generatePracticeTool: TutorTool<{ topic?: string; custom_instructions?: string; outline_version?: OutlineVersionSelection }, GenerationResult> = buildTool({
  name: 'generate_practice',
  description: toolDescription('generate_practice'),
  inputSchema: z.object({
    topic: z.string().optional(),
    custom_instructions: z.string().optional(),
    outline_version: z.enum(OUTLINE_VERSION_KEYS).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: toolPropertyDescription('generate_practice', 'topic') },
      custom_instructions: { type: 'string', description: toolPropertyDescription('generate_practice', 'custom_instructions') },
      outline_version: {
        type: 'string',
        enum: [...OUTLINE_VERSION_KEYS],
        description: toolPropertyDescription('generate_practice', 'outline_version'),
      },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: (input, ctx) => runGeneration('practice', input.topic, ctx, input.custom_instructions, input.outline_version),
  formatResult: (r) => r.summary,
});
