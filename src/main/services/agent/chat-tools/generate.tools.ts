/**
 * Chat-context generation tools — wrap runSubTutorLoop so the AI can trigger
 * material generation during a normal conversation without slash commands.
 *
 * Each tool streams content to the user in real-time via ctx.onChunk,
 * then returns a short summary that the AI can reference when continuing the
 * conversation. The outer streamWithTools loop handles LLM_STREAM_END.
 */
import { z } from 'zod';
import * as nodePath from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { GenerateFolder } from '@shared/types';
import { LLMAdapter } from '../../llm/adapter';
import { NodeRepository } from '../../db/repositories/node.repo';
import { getFolderPath, writeFileContent, getLatestOutlinePath } from '../../fs/content.service';
import { indexFile } from '../../rag/indexer';
import { runSubTutorLoop } from '../sub-tutor-loop';
import type { TutorTool, ToolContext } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { localMsg, languageLayer } from '../../prompt/prompt-builder';

const nodeRepo = new NodeRepository();

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner: '入门', intermediate: '进阶', advanced: '高级',
};
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
};
function diffLabel(d: string, lang?: string): string {
  return (lang === 'en' ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH)[d] ?? d;
}

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
): Promise<GenerationResult> {
  if (!ctx.nodeId) return { success: false, summary: localMsg(ctx.language, '未关联节点，无法生成资料', 'No node selected') };

  const outlinePath = getLatestOutlinePath(ctx.courseId, ctx.nodeId);
  if (!outlinePath) {
    return {
      success: false,
      summary: localMsg(ctx.language,
        '当前节点还没有知识纲要，请先发送"帮我生成大纲"生成纲要后再来生成资料。',
        'No outline found. Please generate an outline first by saying "generate outline".',
      ),
    };
  }

  const FOLDER_LABEL_ZH: Record<string, string> = { theory: '理论讲解', practice: '练习题', notes: '学习笔记' };
  const FOLDER_LABEL_EN: Record<string, string> = { theory: 'theory explanation', practice: 'practice exercises', notes: 'study notes' };
  const folderLabel = (ctx.language === 'en' ? FOLDER_LABEL_EN : FOLDER_LABEL_ZH)[folder] ?? (ctx.language === 'en' ? 'materials' : '资料');
  const userMessage = customInstructions
    ? customInstructions
    : topic
      ? localMsg(ctx.language, `请重点围绕「${topic}」生成${folderLabel}`, `Please generate ${folderLabel} focused on "${topic}"`)
      : localMsg(ctx.language, '请帮我生成相关学习资料', 'Please generate learning materials for this node');

  let savedFileName: string | undefined;

  await runSubTutorLoop({
    sessionId:       ctx.sessionId,
    courseId:        ctx.courseId,
    nodeId:          ctx.nodeId,
    provider:        ctx.provider,
    model:           ctx.model,
    targetFolder:    folder,
    userMessage,
    signal:          ctx.signal,
    language:        ctx.language,
    onChunk:         () => {},   // suppress inner-loop content; outer model sees formatResult summary
    onProgressChunk: (chunk) => ctx.onProgress(chunk),
    onComplete:      () => {},
    onError:         (err) => ctx.onProgress(localMsg(ctx.language, `⚠️ 生成出错: ${err}\n`, `⚠️ Generation failed: ${err}\n`)),
    onFileGenerated: (payload) => {
      savedFileName = nodePath.basename(payload.filePath);
      ctx.onFileGenerated(payload);
    },
  });

  return {
    success:  !!savedFileName,
    fileName: savedFileName,
    summary:  savedFileName
      ? localMsg(ctx.language, `已生成并保存至「${folder}」：${savedFileName}`, `Generated and saved to ${folder}: ${savedFileName}`)
      : localMsg(ctx.language, '生成未完成，请稍后重试', 'Generation incomplete, please retry'),
  };
}

// ── generate_theory ───────────────────────────────────────────────────────────

export const generateTheoryTool: TutorTool<{ topic?: string; custom_instructions?: string }, GenerationResult> = buildTool({
  name: 'generate_theory',
  description:
    '【做什么】为当前节点生成完整的理论讲解文档（概念定义、工作原理、代码示例、常见误区），保存到「原理资料」文件夹。' +
    '【何时调用】用户说"讲一下X"/"X是什么意思"/"帮我理解X"/"我不懂这个"/"给我解释一下"/"给我看下原理"/"从头讲讲"，或 AI 判断用户缺乏系统知识背景时。' +
    '【custom_instructions】若用户对格式、侧重点、题型等有具体要求，将用户原话填入此字段完整传递给生成管道。' +
    '【限制】生成需要时间，适合系统学习而非单个问题的快速解答；只覆盖当前节点范围，不跨节点。',
  inputSchema: z.object({ topic: z.string().optional(), custom_instructions: z.string().optional() }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '聚焦的具体知识点（可不填，默认生成整个节点的理论）' },
      custom_instructions: { type: 'string', description: '用户对资料的具体要求（格式、侧重点、深度等），填入后优先级高于 topic' },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: (input, ctx) => runGeneration('theory', input.topic, ctx, input.custom_instructions),
  formatResult: (r) => r.summary,
});

// ── generate_practice ─────────────────────────────────────────────────────────

export const generatePracticeTool: TutorTool<{ topic?: string; custom_instructions?: string }, GenerationResult> = buildTool({
  name: 'generate_practice',
  description:
    '【做什么】为当前节点生成一套练习题（基础题→应用题→挑战题），保存到「实践资料」文件夹。' +
    '【何时调用】用户说"出几道题"/"给我练习一下"/"我想做题"/"帮我巩固"/"检验一下我"/"来个测试"/"练练手"，或理论学完后用户想动手实践时。' +
    '【custom_instructions】若用户对题型、难度、格式等有具体要求，将用户原话填入此字段完整传递给生成管道。' +
    '【限制】只生成题目，不批改答案；只覆盖当前节点范围；生成需要一定时间，不适合即问即答。',
  inputSchema: z.object({ topic: z.string().optional(), custom_instructions: z.string().optional() }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '练习的具体方向或薄弱知识点（可不填）' },
      custom_instructions: { type: 'string', description: '用户对练习题的具体要求（题型、难度、数量等），填入后优先级高于 topic' },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: (input, ctx) => runGeneration('practice', input.topic, ctx, input.custom_instructions),
  formatResult: (r) => r.summary,
});

// ── generate_feynman_checklist ────────────────────────────────────────────────

// Per learning_type: how to deepen per-knowledge-point questions
const LEARNING_TYPE_DEEPENING: Record<string, string> = {
  motor_skill:
    '**动作技能型节点（motor_skill）** — 每个知识点的深化问题必须围绕：\n' +
    '- 步骤顺序：第 N 步和第 N+1 步的先后原因是什么？\n' +
    '- 自检标准：正确完成这一步的判断依据是什么？\n' +
    '- 错误识别：做错了会有什么可观察的症状？\n' +
    '禁止使用选择题或判断题格式。',
  intellectual_skill:
    '**智识技能型节点（intellectual_skill）** — 每个知识点的深化问题必须围绕：\n' +
    '- 推导过程：为什么是这样，而不是更直觉的做法？\n' +
    '- 边界条件：这个方法/公式在什么情况下不成立？\n' +
    '- 反例构造：能不能举一个这个知识点不适用的例子？',
  cognitive_strategy:
    '**认知策略型节点（cognitive_strategy）** — 每个知识点的深化问题必须围绕：\n' +
    '- 元认知过程：你怎么知道自己用对了这个策略？\n' +
    '- 调试思路：卡住时你会怎么诊断？从哪里开始排查？\n' +
    '- 策略选择依据：为什么选这个策略而不是另一个？',
  verbal_info:
    '**言语信息型节点（verbal_info）** — 每个知识点的深化问题必须围绕：\n' +
    '- 精确边界：定义里最关键的限定词是哪个，去掉它会怎样？\n' +
    '- 概念区分：与相近概念的精确区别在哪条边界上？\n' +
    '- 自发类比：用你自己的话，打一个能解释这个概念的比方。',
  attitude:
    '**态度/审美型节点（attitude）** — 每个知识点的深化问题必须围绕：\n' +
    '- 判断依据：你的判断标准是什么，怎么量化或描述？\n' +
    '- 反转条件：在什么情况下你的判断会反转？\n' +
    '- 价值冲突：如果两个你认可的标准相互冲突，如何取舍？',
};

// Per bloom_target: spaced review timing suggestion
const BLOOM_REVIEW_SUGGESTION: Record<string, string> = {
  remember_understand:
    '建议明天快速过一遍本节知识点的定义，3 天后尝试不看资料用自己的话各讲一遍，1 周后再做一次本清单的第一节。',
  analyze_evaluate:
    '建议 2 天后找一个新的对比场景，重新分析各知识点的优劣取舍；1 周后做一道需要综合判断的分析题。',
  apply:
    '建议 3 天后在一个新场景中尝试应用本节技能，做不出来时只看原理资料对应知识点，不要直接搜答案。',
  create:
    '建议 1 周后独立完成一个综合任务，看能否把本节所有知识点融入其中；评估维度：完整性 + 灵活运用 + 质量。',
};

export const generateFeynmanChecklistTool: TutorTool<Record<string, never>, GenerationResult> = buildTool({
  name: 'generate_feynman_checklist',
  description:
    '【做什么】为当前节点生成深度复盘清单（激活回忆 → 知识点深化问题 → 整合提炼 → 学习过程复盘 → 下一步行动），保存到「费曼复盘」文件夹。' +
    '【何时调用】用户说"我学完了"/"复盘一下"/"检验一下自己"/"费曼一下"/"看看我掌握了没"/"我觉得我懂了，测测我"/"回顾一下"，或整个节点学习完毕时。' +
    '【限制】只生成清单，不自动批阅；适合节点学完后的整体巩固与反思，不适合单个知识点的快速问答。',
  inputSchema: z.object({}),
  inputJsonSchema: { type: 'object', properties: {} },
  maxResultChars: 300,
  isReadOnly: false,
  execute: async (_input, ctx): Promise<GenerationResult> => {
    if (!ctx.nodeId) return { success: false, summary: localMsg(ctx.language, '未关联节点，无法生成复盘清单', 'No node selected') };

    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: `节点不存在 / Node not found: ${ctx.nodeId}` };

    const diff = diffLabel(node.difficulty, ctx.language);

    // Read knowledge outline
    const outlineText = (() => {
      try {
        const p = getLatestOutlinePath(ctx.courseId, ctx.nodeId);
        return p ? fs.readFileSync(p, 'utf-8').trim() : '';
      } catch { return ''; }
    })();

    // Prerequisite node names for integration section
    const allNodes = nodeRepo.findByCourse(ctx.courseId);
    const prereqNames = (node.prerequisites ?? [])
      .map((pid) => allNodes.find((n) => n.id === pid)?.name)
      .filter(Boolean)
      .join('、');

    const learningTypeNote = node.learning_type
      ? (LEARNING_TYPE_DEEPENING[node.learning_type] ?? '')
      : '';

    const bloomReview = node.bloom_target
      ? (BLOOM_REVIEW_SUGGESTION[node.bloom_target] ?? BLOOM_REVIEW_SUGGESTION.apply)
      : BLOOM_REVIEW_SUGGESTION.apply;

    const prereqQ = prereqNames
      ? `这个节点和「${prereqNames}」是什么关系？学完之后，你对它的理解有没有发生变化？`
      : '本节知识在整个课程体系中"坐在什么位置"？它解决了什么前置知识解决不了的问题？';

    const systemPrompt =
      languageLayer(ctx.language)() +
      `你是节点「${node.name}」（${node.chapter}，${diff}难度）的深度复盘助手。\n` +
      (outlineText ? `\n[知识纲要]\n${outlineText}\n\n` : '') +
      `生成一份**五段式深度复盘清单**，帮助学员在学完本节后进行内心反思与深度巩固。\n\n` +
      `**核心原则**：\n` +
      `- 这是供学员自己对照内心反思的清单，不是测试卷，不要出选择题或判断题\n` +
      `- 每个问题都必须是"用背书无法回答"的，必须真正理解才能思考\n` +
      `- 每道问题后留一行"→ 我的思考：____"供学员填写\n` +
      (learningTypeNote ? `\n${learningTypeNote}\n` : '') +
      `\n严格按以下五段结构输出，不要省略任何段落：\n\n` +

      `---\n\n` +
      `## 〇、激活回忆（先做这件事，约 3 分钟）\n\n` +
      `> 在看下面任何内容之前，先做这件事：\n` +
      `>\n` +
      `> 闭上眼睛，或盯着空白处，把你记得的关于「${node.name}」的东西在脑子里过一遍。\n` +
      `> 不查资料，不翻笔记。能说清楚的用一句话概括；说不清楚的记下来。\n` +
      `>\n` +
      `> （约 3 分钟，不要跳过——先主动回忆再对照，效果会完全不同）\n\n` +

      `---\n\n` +
      `## 一、知识点深化问题\n\n` +
      `依据上方 [知识纲要] 中的每个知识点，逐条生成 1-2 个深化问题（若无知识纲要则按节点描述推断知识点）。\n` +
      `问题必须针对该知识点的布鲁姆层级：记忆/理解 → 追问"能说清楚定义和边界"；应用 → 追问"在新场景能用出来吗"；分析/评估 → 追问"能判断优劣取舍吗"；创造 → 追问"能独立设计吗"。\n` +
      `格式：\n\n` +
      `**[知识点名称]**（[深度层级]·[布鲁姆层级]）\n` +
      `→ [深化问题1]\n\n` +
      `   → 我的思考：____\n\n` +
      `→ [深化问题2（可选）]\n\n` +
      `   → 我的思考：____\n\n` +

      `---\n\n` +
      `## 二、整合与提炼\n\n` +
      `（以下三个问题固定输出，不要省略）\n\n` +
      `**Q1. 本节最核心的一条规律是什么？**\n` +
      `（不是定义——而是：学完这节，最该记住的那一条思维/方法是什么？）\n\n` +
      `→ 我的回答：____\n\n` +
      `**Q2. 与前置知识的关系**\n` +
      `${prereqQ}\n\n` +
      `→ 我的回答：____\n\n` +
      `**Q3. 打一个类比**\n` +
      `如果用一个日常生活中的事物来比喻本节的核心机制，你会怎么比？（没有标准答案，能想到任何类比都算）\n\n` +
      `→ 我的回答：____\n\n` +

      `---\n\n` +
      `## 三、学习过程复盘\n\n` +
      `（回顾你学习这个节点的过程——不是内容本身，而是"你学的那个过程"）\n\n` +
      `**1. 哪个环节学得最顺？**（说明你的已有基础起了作用）\n\n` +
      `→ ____\n\n` +
      `**2. 哪个环节最费劲或最困惑？**\n\n` +
      `→ ____\n\n` +
      `费劲的根本原因是什么？（勾选最符合的）\n` +
      `- [ ] 缺少前置知识\n` +
      `- [ ] 概念本身难以直觉化\n` +
      `- [ ] 资料讲解不够清晰\n` +
      `- [ ] 自己当时注意力/状态不好\n` +
      `- [ ] 其他：____\n\n` +
      `**3. 如果重新学一次，你会改变什么？**\n\n` +
      `→ ____\n\n` +

      `---\n\n` +
      `## 四、下一步行动\n\n` +
      `**待解决的漏洞**（把第一节里没想清楚的知识点列在这里）：\n` +
      `- [ ] ____\n` +
      `- [ ] ____\n\n` +
      `**间隔复习建议：**\n` +
      `${bloomReview}\n\n` +
      `---`;

    let fullContent = '';
    let streamError = '';

    await LLMAdapter.stream({
      provider:    ctx.provider,
      model:       ctx.model,
      messages:    [{ role: 'user', content: `节点：${node.name}，请生成深度复盘清单。` }],
      systemPrompt,
      maxTokens:   3500,
      temperature: 0.4,
      signal:      ctx.signal,
      onChunk:     (chunk) => { fullContent += chunk; },
      onComplete:  () => {},
      onError:     (err) => { streamError = err.message; },
    });

    if (streamError || !fullContent) {
      return { success: false, summary: localMsg(ctx.language, streamError || '生成失败，请稍后重试', streamError || 'Generation failed, please retry') };
    }

    const outlinePath = getLatestOutlinePath(ctx.courseId, ctx.nodeId);
    const vMatch = outlinePath ? nodePath.basename(outlinePath).match(/_outline_(v\d+)\.md/) : null;
    const outlineVer = vMatch ? vMatch[1] : 'v1';
    const now = new Date();
    const mmdd = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const feynmanDir0 = getFolderPath(ctx.courseId, ctx.nodeId, 'feynman');
    const baseName = ctx.language === 'en' ? `review-${outlineVer}-${mmdd}` : `复盘清单-${outlineVer}-${mmdd}`;
    // Resolve filename conflict: if same version+date already exists add -2, -3…
    let fileName = `${baseName}.md`;
    if (fs.existsSync(nodePath.join(feynmanDir0, fileName))) {
      let i = 2;
      while (fs.existsSync(nodePath.join(feynmanDir0, `${baseName}-${i}.md`))) i++;
      fileName = `${baseName}-${i}.md`;
    }
    const filePath = nodePath.join(feynmanDir0, fileName);
    writeFileContent(filePath, fullContent);
    try { indexFile(randomUUID(), ctx.nodeId, ctx.courseId, fullContent, fileName); } catch { /* non-fatal */ }

    // Append to _index.md
    try {
      const indexPath = nodePath.join(feynmanDir0, '_index.md');
      const date = new Date().toISOString().slice(0, 10);
      const entry = ctx.language === 'en'
        ? `\n## ${fileName} (${date})\nOutline version: ${outlineVer}\n`
        : `\n## ${fileName}（${date}）\n纲要版本：${outlineVer}\n`;
      const indexHeader = ctx.language === 'en' ? '# Feynman Review Index\n' : '# 费曼复盘索引\n';
      const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : indexHeader;
      writeFileContent(indexPath, existing + entry);
    } catch { /* non-fatal */ }

    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'feynman', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return { success: true, fileName, summary: localMsg(ctx.language, `已生成深度复盘清单：${fileName}，保存至「费曼复盘」文件夹。`, `Feynman review checklist generated: ${fileName}, saved to Feynman Review folder.`) };
  },
  formatResult: (r) => r.summary,
});

// ── generate_mindmap ───────────────────────────────────────────────────────────

export const generateMindmapTool: TutorTool<{ topic?: string }, GenerationResult> = buildTool({
  name: 'generate_mindmap',
  description:
    '【做什么】为当前节点生成 Mermaid 思维导图（层级知识结构可视化），保存到「原理资料」文件夹，可在文件预览中渲染展示。' +
    '【何时调用】用户说"帮我画思维导图"/"整理知识结构"/"我想看知识图"/"可视化一下"/"画个图"/"知识框架是什么"，或 AI 判断知识点之间有层级关系适合可视化时。' +
    '【限制】只生成文字版 Mermaid 语法，不是图片；只覆盖当前节点范围；生成速度快，适合快速概览。',
  inputSchema: z.object({ topic: z.string().optional() }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '思维导图聚焦的方向（可不填，默认整个节点）' },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: async (input, ctx): Promise<GenerationResult> => {
    if (!ctx.nodeId) return { success: false, summary: localMsg(ctx.language, '未关联节点，无法生成思维导图', 'No node selected') };

    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: `节点不存在 / Node not found: ${ctx.nodeId}` };

    const diff = diffLabel(node.difficulty, ctx.language);
    const focus = input.topic ? (ctx.language === 'en' ? `, focused on "${input.topic}"` : `，重点聚焦「${input.topic}」`) : '';

    const systemPrompt = languageLayer(ctx.language)() + `你是节点「${node.name}」（${node.chapter}，${diff}难度）的知识结构分析师。

生成一份 Mermaid mindmap 格式的思维导图${focus}，帮助学员理解知识的层级结构和内在联系。

**严格输出格式**：只输出 Mermaid 代码块，不要任何说明文字：

\`\`\`mindmap
mindmap
  root((${node.name}))
    分支1
      子节点1
      子节点2
    分支2
      子节点3
\`\`\`

要求：
- 根节点是「${node.name}」
- 第一层：3-6 个核心概念分支
- 第二层：每个分支下 2-4 个具体知识点
- 第三层（可选）：关键细节或示例
- 节点文字简洁（≤10字），用中文
- 不要添加任何代码块之外的文字`;

    let fullContent = '';
    let streamError = '';

    await LLMAdapter.stream({
      provider:    ctx.provider,
      model:       ctx.model,
      messages:    [{ role: 'user', content: `节点：${node.name}，请生成思维导图。` }],
      systemPrompt,
      maxTokens:   2000,
      temperature: 0.3,
      signal:      ctx.signal,
      onChunk:     (chunk) => { fullContent += chunk; },   // collect silently, not streamed to chat
      onComplete:  () => {},
      onError:     (err) => { streamError = err.message; },
    });

    if (streamError || !fullContent) {
      return { success: false, summary: localMsg(ctx.language, streamError || '生成失败，请稍后重试', streamError || 'Generation failed, please retry') };
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const fileName = `${ts}-mindmap.md`;
    const filePath = nodePath.join(getFolderPath(ctx.courseId, ctx.nodeId, 'theory'), fileName);
    writeFileContent(filePath, fullContent);
    try { indexFile(randomUUID(), ctx.nodeId, ctx.courseId, fullContent, fileName); } catch { /* non-fatal */ }
    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'theory', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return { success: true, fileName, summary: localMsg(ctx.language, `已生成思维导图：${fileName}，保存至「原理资料」文件夹，可在文件列表中打开查看。`, `Mind map generated: ${fileName}, saved to Theory folder.`) };
  },
  formatResult: (r) => r.summary,
});

// ── generate_chapter_summary ──────────────────────────────────────────────────

export const generateChapterSummaryTool: TutorTool<{ chapter?: string }, GenerationResult> = buildTool({
  name: 'generate_chapter_summary',
  description:
    '【做什么】整合当前章节所有节点的原理资料，生成跨节点的章节知识总结（知识点关联图、核心结论、常见误区），保存到「费曼复盘」文件夹。' +
    '【何时调用】用户说"这章学完了，帮我总结"/"整合一下本章"/"章节总结"/"把这一章所有知识点梳理一下"/"综合归纳一下"，或整个章节的节点均已完成学习时。' +
    '【限制】需要章节内已有原理资料才能整合；跨节点操作耗时较长；不同课程的章节不能混合。',
  inputSchema: z.object({ chapter: z.string().optional() }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      chapter: { type: 'string', description: '章节名称（可不填，默认使用当前节点所在章节）' },
    },
  },
  maxResultChars: 300,
  isReadOnly: false,
  execute: async (input, ctx): Promise<GenerationResult> => {
    if (!ctx.nodeId) return { success: false, summary: localMsg(ctx.language, '未关联节点，无法生成章节总结', 'No node selected') };

    const currentNode = nodeRepo.findById(ctx.nodeId);
    if (!currentNode) return { success: false, summary: `节点不存在 / Node not found: ${ctx.nodeId}` };

    const chapterName = input.chapter ?? currentNode.chapter;
    const allNodes = nodeRepo.findByCourse(ctx.courseId);
    const chapterNodes = allNodes.filter((n) => n.chapter === chapterName);

    if (chapterNodes.length === 0) {
      return { success: false, summary: localMsg(ctx.language, `章节「${chapterName}」中没有节点`, `Chapter "${chapterName}" has no nodes`) };
    }

    // Collect theory materials from all chapter nodes
    const nodeMaterials: string[] = [];
    for (const n of chapterNodes) {
      const dir = getFolderPath(ctx.courseId, n.id, 'theory');
      if (!fs.existsSync(dir)) continue;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const content = fs.readFileSync(nodePath.join(dir, entry.name), 'utf-8');
            nodeMaterials.push(`### 节点：${n.name}\n\n${content.slice(0, 1500)}`);
          }
        }
      } catch { /* skip unreadable */ }
    }

    const nodeList = chapterNodes.map((n) => `- ${n.name}（${diffLabel(n.difficulty, ctx.language)}）`).join('\n');
    const materialText = nodeMaterials.length > 0
      ? nodeMaterials.join('\n\n---\n\n')
      : '（各节点暂无原理资料，请先生成各节点的理论讲解）';

    const systemPrompt = `你是章节「${chapterName}」的知识整合专家。

章节包含以下节点：
${nodeList}

请基于以下各节点的学习资料，生成一份跨节点的章节综合总结。

**总结结构**：

## ${chapterName} — 章节总结

### 一、知识点全景
（用简洁的方式列出本章所有核心知识点及其关系）

### 二、核心结论（每点用一句话）
（3-5 个最重要的结论，跨节点提炼）

### 三、知识点关联
（哪些节点的知识有内在联系？如何联系？）

### 四、常见误区（全章）
（学员最容易混淆或误解的 3-5 个点）

### 五、下一步建议
（学完本章后推荐的实践方向或延伸学习）

---

各节点资料：

${materialText}`;

    let fullContent = '';
    let streamError = '';

    await LLMAdapter.stream({
      provider:    ctx.provider,
      model:       ctx.model,
      messages:    [{ role: 'user', content: `请生成「${chapterName}」章节总结。` }],
      systemPrompt,
      maxTokens:   4000,
      temperature: 0.4,
      signal:      ctx.signal,
      onChunk:     (chunk) => { fullContent += chunk; },   // collect silently, not streamed to chat
      onComplete:  () => {},
      onError:     (err) => { streamError = err.message; },
    });

    if (streamError || !fullContent) {
      return { success: false, summary: localMsg(ctx.language, streamError || '生成失败，请稍后重试', streamError || 'Generation failed, please retry') };
    }

    const safeChapter = chapterName.replace(/[/\\?%*:|"<>]/g, '').trim();
    const fileName = `chapter-${safeChapter}-summary.md`;
    const filePath = nodePath.join(getFolderPath(ctx.courseId, ctx.nodeId, 'feynman'), fileName);
    writeFileContent(filePath, fullContent);
    try { indexFile(randomUUID(), ctx.nodeId, ctx.courseId, fullContent, fileName); } catch { /* non-fatal */ }
    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'feynman', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return { success: true, fileName, summary: localMsg(ctx.language, `已生成「${chapterName}」章节总结：${fileName}，保存至「费曼复盘」文件夹。`, `Chapter summary for "${chapterName}" generated: ${fileName}, saved to Feynman Review folder.`) };
  },
  formatResult: (r) => r.summary,
});
