import * as fs from 'fs';
import * as nodePath from 'path';
import { z } from 'zod';
import { getArtifactDisplayName, getReviewBaseName, getReviewIndexEntry, getReviewIndexHeader, getTimestampedArtifactFilename } from '../../agent-i18n/artifact-names';
import { message } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { buildFeynmanReviewWorkflowPrompt } from '../../agent-skills/feynman-review.skill';
import { NodeRepository } from '../../db/repositories/node.repo';
import { getFolderPath, writeFileContent } from '../../fs/content.service';
import { LLMAdapter } from '../../llm/adapter';
import { resolveOutputTokenBudget } from '../../agent-context/output-token-budget';
import { languageLayer, localMsg } from '../../prompt/prompt-builder';
import { importTextSource } from '../../source/source-library';
import { getOutlineBundleStatus } from '../../agent-workflows/outline-version';
import { buildOutlineContextForArtifact } from '../../agent-workflows/outline-context';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import { usageLedger } from '../../llm/usage-ledger';
import {
  formatFeynmanContextTrace,
  formatFeynmanSaveTrace,
  formatGenerationStepTrace,
  formatSimpleGenerationTrace,
} from '../../agent-workflows/material/material-progress-trace';
import type { ToolContext, TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';

const nodeRepo = new NodeRepository();

function syncGeneratedSourceIndex(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  fileName: string,
  filePath: string,
  content: string,
): boolean {
  try {
    importTextSource({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      title: fileName,
      content,
      filePath,
      kind: 'generated',
      origin: 'ai_generated',
    });
    return true;
  } catch {
    return false;
  }
}

interface GenerationResult {
  success: boolean;
  fileName?: string;
  summary: string;
}

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner: '入门', intermediate: '进阶', advanced: '高级',
};
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
};
function diffLabel(d: string, lang?: string): string {
  return (lang === 'en' ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH)[d] ?? d;
}

function countChecklistLikeItems(content: string): number {
  const bulletCount = content.match(/^\s*[-*+]\s+\S/gm)?.length ?? 0;
  const numberedCount = content.match(/^\s*\d+[.)、]\s+\S/gm)?.length ?? 0;
  return bulletCount + numberedCount;
}

async function ensureFeynmanOutlineBundle(
  ctx: ToolContext,
  node: NonNullable<ReturnType<NodeRepository['findById']>>,
  kind: string,
): Promise<string | undefined> {
  const status = getOutlineBundleStatus(ctx.courseId, ctx.nodeId);
  if (status.complete) return undefined;

  ctx.onProgress(formatGenerationStepTrace({
    kind,
    step: ctx.language === 'en' ? 'prepare blueprints' : '准备三层蓝图',
    status: 'start',
    detail: ctx.language === 'en'
      ? 'The review checklist needs the v1-v3 foundation blueprints; generating missing/stale blueprints first.'
      : '复盘清单需要 v1-v3 三层基础蓝图；当前缺失或过期，先自动补齐。',
    language: ctx.language,
  }));

  const startedAt = Date.now();
  const useRunContext = Boolean(ctx.runContext);
  try {
    await workflowRunner.run('outline.generateNext', {
      options: {
        courseId:        ctx.courseId,
        nodeId:          ctx.nodeId,
        provider:        ctx.provider,
        model:           ctx.model,
        signal:          ctx.signal,
        language:        ctx.language,
        searchMode:      ctx.searchMode,
        onProgressChunk: useRunContext ? () => {} : (msg: string) => ctx.onProgress(msg),
        onComplete:      (usage) => {
          if (!useRunContext) {
            usageLedger.record({
              sessionId: ctx.sessionId,
              courseId: ctx.courseId,
              provider: ctx.provider,
              model: ctx.model,
              usage,
              source: 'chat_tool_generate_feynman_outline_prerequisite',
            });
          }
        },
      },
      node,
    }, { context: ctx.runContext });
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'prepare blueprints' : '准备三层蓝图',
      status: 'done',
      durationMs: Date.now() - startedAt,
      detail: ctx.language === 'en'
        ? 'Foundation blueprints are ready; continuing with Feynman review generation.'
        : '三层基础蓝图已准备好，继续生成费曼复盘。',
      language: ctx.language,
    }));
    return undefined;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'prepare blueprints' : '准备三层蓝图',
      status: 'fail',
      durationMs: Date.now() - startedAt,
      detail: error,
      language: ctx.language,
    }));
    return error;
  }
}

function readFeynmanOutlineContext(ctx: Pick<ToolContext, 'courseId' | 'nodeId' | 'language'>): {
  text: string;
  version: string;
  charCount: number;
} {
  const outlineContext = buildOutlineContextForArtifact({
    courseId: ctx.courseId,
    nodeId: ctx.nodeId,
    artifactKind: 'review',
    language: ctx.language,
  });
  return {
    text: outlineContext.text,
    version: outlineContext.primaryVersion ?? outlineContext.versionLabel,
    charCount: outlineContext.text.length,
  };
}

export const generateFeynmanChecklistTool: TutorTool<Record<string, never>, GenerationResult> = buildTool({
  name: 'generate_feynman_checklist',
  description: toolDescription('generate_feynman_checklist'),
  inputSchema: z.object({}),
  inputJsonSchema: { type: 'object', properties: {} },
  maxResultChars: 300,
  isReadOnly: false,
  execute: async (_input, ctx): Promise<GenerationResult> => {
    if (!ctx.nodeId) return { success: false, summary: message('noNodeSelectedGenerateReview', ctx.language) };

    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: message('nodeNotFound', ctx.language, { nodeId: ctx.nodeId }) };

    const workflowStartedAt = Date.now();
    const kind = ctx.language === 'en' ? 'Feynman review' : '费曼复盘';
    const diff = diffLabel(node.difficulty, ctx.language);
    const outlineError = await ensureFeynmanOutlineBundle(ctx, node, kind);
    if (outlineError) {
      return {
        success: false,
        summary: message('outlineGenerationFailed', ctx.language, { error: outlineError }),
      };
    }
    const outlineStartedAt = Date.now();
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'read outline' : '读取纲要',
      status: 'start',
      detail: localMsg(ctx.language, '读取三层基础蓝图作为复盘范围。', 'Reading the three foundation blueprints as review scope.'),
      language: ctx.language,
    }));
    const outlineContext = readFeynmanOutlineContext(ctx);
    const outlineText = outlineContext.text;
    const outlineVerForTrace = outlineContext.version;
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'read outline' : '读取纲要',
      status: outlineText ? 'done' : 'skip',
      durationMs: Date.now() - outlineStartedAt,
      detail: ctx.language === 'en'
        ? `Version ${outlineVerForTrace}; read ${outlineContext.charCount.toLocaleString('en-US')} chars.`
        : `版本 ${outlineVerForTrace}；读取 ${outlineContext.charCount.toLocaleString('en-US')} 字符。`,
      language: ctx.language,
    }));

    const prereqStartedAt = Date.now();
    const allNodes = nodeRepo.findByCourse(ctx.courseId);
    const prereqNames = (node.prerequisites ?? [])
      .map((pid) => allNodes.find((n) => n.id === pid)?.name)
      .filter(Boolean)
      .join(ctx.language === 'en' ? ', ' : '、');
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'read prerequisites' : '读取前置节点',
      status: 'done',
      durationMs: Date.now() - prereqStartedAt,
      detail: ctx.language === 'en'
        ? `${node.prerequisites?.length ?? 0} prerequisite id(s); ${prereqNames || 'none'}.`
        : `${node.prerequisites?.length ?? 0} 个前置节点；${prereqNames || '无'}。`,
      language: ctx.language,
    }));
    ctx.onProgress(formatFeynmanContextTrace({
      node,
      provider: ctx.provider,
      model: ctx.model,
      outlineVersion: outlineVerForTrace,
      outlineText,
      prerequisiteNames: prereqNames,
      language: ctx.language,
    }));

    const systemPrompt =
      languageLayer(ctx.language)() +
      buildFeynmanReviewWorkflowPrompt({
        nodeName:          node.name,
        chapter:           node.chapter,
        difficultyLabel:   diff,
        outlineText,
        learningType:      node.learning_type,
        bloomTarget:       node.bloom_target,
        prerequisiteNames: prereqNames,
        language:          ctx.language,
      });
    const maxTokens = resolveOutputTokenBudget({ provider: ctx.provider, model: ctx.model, task: 'feynman' });
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'build prompt' : '构建复盘提示词',
      status: 'done',
      detail: ctx.language === 'en'
        ? `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; output cap ${maxTokens.toLocaleString('en-US')} tokens.`
        : `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；输出上限 ${maxTokens.toLocaleString('en-US')} tokens。`,
      language: ctx.language,
    }));

    let fullContent = '';
    let streamError = '';

    const generationStartedAt = Date.now();
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'model drafts review' : '模型生成复盘',
      status: 'start',
      detail: ctx.language === 'en' ? 'Calling the model to produce the review checklist.' : '调用模型输出复盘清单全文。',
      language: ctx.language,
    }));
    await LLMAdapter.stream({
      provider:    ctx.provider,
      model:       ctx.model,
      messages:    [{ role: 'user', content: `节点：${node.name}，请生成深度复盘清单。` }],
      systemPrompt,
      maxTokens,
      temperature: 0.4,
      signal:      ctx.signal,
      onChunk:     (chunk) => { fullContent += chunk; },
      onComplete:  (usage) => { ctx.runContext?.addUsage(usage); },
      onError:     (err) => { streamError = err.message; },
    });
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'model drafts review' : '模型生成复盘',
      status: streamError || !fullContent ? 'fail' : 'done',
      durationMs: Date.now() - generationStartedAt,
      detail: streamError || (ctx.language === 'en'
        ? `Output about ${fullContent.length.toLocaleString('en-US')} chars.`
        : `输出约 ${fullContent.length.toLocaleString('en-US')} 字符。`),
      language: ctx.language,
    }));

    if (streamError || !fullContent) {
      return { success: false, summary: streamError || message('generationFailedRetry', ctx.language) };
    }

    const checklistItems = countChecklistLikeItems(fullContent);
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'structure check' : '结构检查',
      status: 'done',
      detail: ctx.language === 'en'
        ? `About ${checklistItems} checklist-like item(s); ${/自测|练习|行动|复盘|check|practice|action/i.test(fullContent) ? 'contains review/action cues' : 'few explicit review/action cues'}.`
        : `约 ${checklistItems} 个清单项；${/自测|练习|行动|复盘|check|practice|action/i.test(fullContent) ? '包含复盘/行动提示' : '复盘/行动提示较少'}。`,
      language: ctx.language,
    }));

    const outlineVer = outlineVerForTrace;
    const now = new Date();
    const mmdd = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const feynmanDir0 = getFolderPath(ctx.courseId, ctx.nodeId, 'feynman');
    const baseName = getReviewBaseName(outlineVer, mmdd, ctx.language);
    let fileName = `${baseName}.md`;
    if (fs.existsSync(nodePath.join(feynmanDir0, fileName))) {
      let i = 2;
      while (fs.existsSync(nodePath.join(feynmanDir0, `${baseName}-${i}.md`))) i++;
      fileName = `${baseName}-${i}.md`;
    }
    const filePath = nodePath.join(feynmanDir0, fileName);
    const persistStartedAt = Date.now();
    writeFileContent(filePath, fullContent);
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'write review file' : '写入复盘文件',
      status: 'done',
      durationMs: Date.now() - persistStartedAt,
      detail: ctx.language === 'en' ? `Saved as ${fileName}.` : `保存到 ${fileName}。`,
      language: ctx.language,
    }));

    const indexStartedAt = Date.now();
    const sourceIndexed = syncGeneratedSourceIndex(ctx, fileName, filePath, fullContent);

    let indexUpdated = false;
    try {
      const indexPath = nodePath.join(feynmanDir0, '_index.md');
      const date = new Date().toISOString().slice(0, 10);
      const entry = getReviewIndexEntry(fileName, date, outlineVer, ctx.language);
      const indexHeader = getReviewIndexHeader(ctx.language);
      const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : indexHeader;
      writeFileContent(indexPath, existing + entry);
      indexUpdated = true;
    } catch { /* non-fatal */ }
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: ctx.language === 'en' ? 'index review file' : '索引复盘文件',
      status: 'done',
      durationMs: Date.now() - indexStartedAt,
      detail: ctx.language === 'en'
        ? `Source index ${sourceIndexed ? 'ok' : 'not completed'}; folder index ${indexUpdated ? 'updated' : 'not updated'}; total ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)}s.`
        : `参考库索引${sourceIndexed ? '成功' : '未完成'}；目录索引${indexUpdated ? '已更新' : '未更新'}；总耗时 ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)} 秒。`,
      language: ctx.language,
    }));
    ctx.onProgress(formatFeynmanSaveTrace({
      filename: fileName,
      content: fullContent,
      indexed: sourceIndexed,
      indexUpdated,
      language: ctx.language,
    }));

    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'feynman', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return {
      success: true,
      fileName,
      summary: message('feynmanReviewGenerated', ctx.language, {
        filename: fileName,
        folder:   getArtifactDisplayName('feynman', ctx.language),
      }),
    };
  },
  formatResult: (r) => r.summary,
});

function normalizeMindmapMarkdown(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```([^\n]*)\n([\s\S]*?)\n```$/i);
  if (fenced) {
    const lang = (fenced[1].trim().split(/\s+/)[0] ?? '').toLowerCase();
    const body = fenced[2].trim();
    if (lang === 'mermaid' || lang === 'mindmap' || (!lang && /^mindmap\b/i.test(body))) {
      return `\`\`\`mermaid\n${body}\n\`\`\`\n`;
    }
    return trimmed;
  }
  if (/^mindmap\b/i.test(trimmed)) {
    return `\`\`\`mermaid\n${trimmed}\n\`\`\`\n`;
  }
  return trimmed;
}

export const generateMindmapTool: TutorTool<{ topic?: string }, GenerationResult> = buildTool({
  name: 'generate_mindmap',
  description: toolDescription('generate_mindmap'),
  inputSchema: z.object({ topic: z.string().optional() }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: toolPropertyDescription('generate_mindmap', 'topic') },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: async (input, ctx): Promise<GenerationResult> => {
    if (!ctx.nodeId) return { success: false, summary: message('noNodeSelectedGenerateMindmap', ctx.language) };

    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: message('nodeNotFound', ctx.language, { nodeId: ctx.nodeId }) };

    const diff = diffLabel(node.difficulty, ctx.language);
    const topic = input.topic?.trim();
    const targetLabel = topic || node.name;
    const focus = topic ? (ctx.language === 'en' ? `, focused on "${topic}"` : `，重点聚焦「${topic}」`) : '';
    const outlineContext = buildOutlineContextForArtifact({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      artifactKind: 'mindmap',
      language: ctx.language,
      kcName: topic,
    });
    ctx.onProgress(formatSimpleGenerationTrace({
      kind: ctx.language === 'en' ? 'Mermaid mind map' : 'Mermaid 思维导图',
      nodeName: node.name,
      targetFolder: 'theory',
      model: `${ctx.provider}/${ctx.model}`,
      language: ctx.language,
    }));
    const systemPrompt = languageLayer(ctx.language)() + `你是节点「${node.name}」（${node.chapter}，${diff}难度）的知识结构分析师。

${outlineContext.text ? `优先参考以下学习蓝图上下文，生成知识结构，不要只凭节点标题发挥：\n${outlineContext.text}\n\n` : ''}

生成一份 Mermaid mindmap 格式的学习结构图${focus}，帮助学员抓住学习主线、关键关系和后续练习入口。

当前导图目标：${targetLabel}
${topic ? `用户指定了聚焦方向，必须只围绕「${topic}」展开：根节点必须是「${topic}」，不要生成「${node.name}」整个节点的总览，不要把其他 KC/旁支内容塞进来。` : `用户没有指定聚焦方向，生成「${node.name}」整个节点的总览。`}

**严格输出格式**：只输出 Mermaid 代码块，不要任何说明文字：

\`\`\`mermaid
mindmap
  root((${targetLabel}))
    是什么
      核心定义
      关键对象
    怎么理解
      直观模型
      核心关系
    怎么使用
      基本步骤
      典型题型
    易错边界
      常见误区
      自检问题
\`\`\`

要求：
- 根节点必须是「${targetLabel}」
- 如果当前导图目标不是整个节点名，所有一级分支和叶子节点都必须直接服务这个目标，不要泛化到全节点内容
- 第一层优先采用学习顺序：是什么 / 怎么理解 / 怎么使用 / 易错边界 / 应用拓展；可按节点性质合并或改名，但不要超过 5 个一级分支
- 第二层每个分支 2-3 个具体知识点，总叶子节点控制在 10-16 个，避免像词库一样堆术语
- 结构要体现“定义 → 直观 → 方法 → 边界 → 应用”的关系，不要把同类项拆散到不同分支
- 数学节点只保留 1-2 个最关键公式，公式节点要短；英文术语尽量翻译成中文，必要时放括号中
- 节点文字简洁：一级分支 2-6 字，子节点 4-12 字
- 不要添加任何代码块之外的文字`;

    let fullContent = '';
    let streamError = '';

    await LLMAdapter.stream({
      provider:    ctx.provider,
      model:       ctx.model,
      messages:    [{ role: 'user', content: topic ? `节点：${node.name}，请针对「${topic}」生成聚焦思维导图。` : `节点：${node.name}，请生成思维导图。` }],
      systemPrompt,
      maxTokens:   resolveOutputTokenBudget({ provider: ctx.provider, model: ctx.model, task: 'mindmap' }),
      temperature: 0.3,
      signal:      ctx.signal,
      onChunk:     (chunk) => { fullContent += chunk; },
      onComplete:  (usage) => { ctx.runContext?.addUsage(usage); },
      onError:     (err) => { streamError = err.message; },
    });

    if (streamError || !fullContent) {
      return { success: false, summary: streamError || message('generationFailedRetry', ctx.language) };
    }

    const normalizedContent = normalizeMindmapMarkdown(fullContent);
    const fileName = getTimestampedArtifactFilename('mindmap', topic ? { title: topic } : {}, ctx.language);
    const filePath = nodePath.join(getFolderPath(ctx.courseId, ctx.nodeId, 'theory'), fileName);
    writeFileContent(filePath, normalizedContent);
    syncGeneratedSourceIndex(ctx, fileName, filePath, normalizedContent);
    ctx.onProgress(formatSimpleGenerationTrace({
      kind: ctx.language === 'en' ? 'Mermaid mind map' : 'Mermaid 思维导图',
      nodeName: node.name,
      targetFolder: 'theory',
      model: `${ctx.provider}/${ctx.model}`,
      content: normalizedContent,
      filename: fileName,
      language: ctx.language,
    }));
    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'theory', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return {
      success: true,
      fileName,
      summary: message('mindmapGenerated', ctx.language, {
        filename: fileName,
        folder:   getArtifactDisplayName('theory', ctx.language),
      }),
    };
  },
  formatResult: (r) => r.summary,
});
