/**
 * Topic (专题) outline generator.
 *
 * A Topic is a deep-dive on a single KC from a node's outline.
 * Unlike outline versioning (which expands all KCs horizontally),
 * a Topic treats one KC as an independent research subject and
 * expands it vertically to expert/paper depth.
 *
 * Output file: `纲要/_topic_{kcId}_{kcName}.md`
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { getOutlineDirPath, getLatestOutlinePath, writeFileContent } from '../fs/content.service';
import { buildOutlineSearchResults } from '../web/source-strategy';
import { localMsg } from '../prompt/prompt-builder';

export interface TopicGenerateOptions {
  courseId:  string;
  nodeId:    string;
  kcId:      string;   // e.g. "KC3"
  kcName:    string;   // e.g. "变量作用域"
  provider:  LLMProvider;
  model:     string;
  signal?:   AbortSignal;
  language?: string;
  onProgressChunk: (msg: string) => void;
  onComplete?: (usage: TokenUsage) => void;
}

/**
 * Generate a topic outline for a specific KC.
 * Writes to `纲要/_topic_{kcId}_{safeName}.md`.
 * Returns the absolute path of the written file.
 */
export async function generateTopicOutline(
  opts: TopicGenerateOptions,
  node: import('@shared/types').DagNode,
): Promise<string> {
  opts.onProgressChunk(localMsg(opts.language, `📝 正在为「${opts.kcName}」生成专题纲要…\n`, `📝 Generating topic outline for "${opts.kcName}"…\n`));

  // Read parent outline as context (so the AI knows the KC's original definition)
  const parentOutlinePath = getLatestOutlinePath(opts.courseId, opts.nodeId);
  const parentOutlineText = parentOutlinePath
    ? (() => { try { return fs.readFileSync(parentOutlinePath, 'utf-8').trim(); } catch { return ''; } })()
    : '';

  // Web search focused on the specific KC name for deep-dive material
  let webContext = '';
  try {
    const results = await buildOutlineSearchResults(
      opts.kcName, null,
      { provider: opts.provider as string, model: opts.model, signal: opts.signal },
    );
    if (results.length > 0) {
      webContext = results
        .slice(0, 3)
        .map((r) => `[参考] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 400)}`)
        .join('\n\n');
    }
  } catch { /* non-fatal — proceed without web context */ }

  const isEn = opts.language === 'en';

  const parentSection = parentOutlineText
    ? isEn
      ? `**Parent node outline (${node.name}) — original definition of this KC:**\n${parentOutlineText.slice(0, 600)}\n\n`
      : `**父节点纲要（${node.name}）中该 KC 的原始定义：**\n${parentOutlineText.slice(0, 600)}\n\n`
    : '';

  const webSection = webContext
    ? isEn
      ? `**Search references (focus on misconceptions, expert-level details, edge conditions):**\n${webContext}\n\n`
      : `**搜索参考（重点参考误解、专家级细节、边界条件）：**\n${webContext}\n\n`
    : '';

  const systemPrompt = isEn
    ? `You are a knowledge-structure architect. Generate a Topic KC Outline for "${opts.kcName}" (${opts.kcId} from node "${node.name}").\n\n` +
      `**Goal:** Deep-dive topic outline — treat this KC as an independent research subject, analyse its internal structure to expert / survey-paper depth.\n\n` +
      parentSection +
      webSection +
      `**Generation approach (internalize, do not write out):**\n` +
      `① What is the deepest "why" of this KC? What dimensions can be analysed?\n` +
      `② Expand into 5–10 atomic sub-KCs covering: basic definition → mechanism → edge/anomaly → trade-offs → advanced practical use\n` +
      `③ Distill expert-level misconceptions (deep pitfalls not obvious to beginners) and advanced edge conditions from search references\n\n` +
      `**KC Types:** Declarative (knowing "what") / Procedural (knowing "how") / Conditional (knowing "when to use")\n\n` +
      `**Strict output format (no explanations):**\n\n` +
      `# Topic Outline — ${opts.kcName} (from "${node.name}" ${opts.kcId})\n\n` +
      `## Knowledge Units (KCs)\n\n` +
      `### KC1: [Name]\n- Type: [Declarative/Procedural/Conditional]\n- Bloom Level: [level]\n- Prerequisite KCs: [None/KC{n}]\n- Mastery Indicator: [expert-level observable behaviour]\n\n` +
      `...\n\n` +
      `## Common Misconceptions\n1. Misconception: ...  Reality: ...\n\n` +
      `## Edge Conditions\n- ...\n\n` +
      `5–10 sub-KCs; Bloom levels should lean towards [Analyse/Evaluate] [Create]; ` +
      `at least 3 misconceptions (focus on deep/expert-level pitfalls); at least 2 edge conditions; ` +
      `Prerequisite KCs may only reference IDs defined in this outline (use "None" if none).`
    : `你是知识结构规划师，为知识组件「${opts.kcName}」（来自节点「${node.name}」的 ${opts.kcId}）生成专题 KC 纲要。\n\n` +
      `**定位：** 专题深钻纲要——把该 KC 当作独立研究对象，深度剖析其内部结构，达到专家 / 综述论文水平。\n\n` +
      parentSection +
      webSection +
      `**生成思路（内化，不要写出）：**\n` +
      `① 该 KC 最深层的"为什么"是什么？有哪些维度可以剖析？\n` +
      `② 展开 5-10 个原子子 KC，覆盖：基础定义 → 机制原理 → 边界/异常 → 对比/取舍 → 实战高阶用法\n` +
      `③ 从搜索参考提炼专家级误解（初学者不易遇到的深层误区）和高阶边界条件\n\n` +
      `**KC 类型：**\n` +
      `- 陈述性：知道"是什么"\n` +
      `- 程序性：知道"怎么做"\n` +
      `- 条件性：知道"什么情况下用"\n\n` +
      `**严格输出格式（不输出任何解释）：**\n\n` +
      `# 专题纲要 — ${opts.kcName}（来自「${node.name}」${opts.kcId}）\n\n` +
      `## 知识单元（KCs）\n\n` +
      `### KC1: [名称]\n- 类型：[陈述性/程序性/条件性]\n- 布鲁姆层级：[层级]\n- 前置KC：[无/KC{n}]\n- 掌握指标：[专家级可观察行为]\n\n` +
      `...\n\n` +
      `## 常见误解（Misconceptions）\n1. 误解：...  实际：...\n\n` +
      `## 边界条件\n- ...\n\n` +
      `子 KC 数量 5-10 个；布鲁姆层级偏重 [分析/评估] [创造]；` +
      `常见误解至少 3 条（侧重深层/专家级误区）；边界条件至少 2 条；` +
      `前置KC 只能引用本纲要已定义的编号（无前置写"无"）。`;

  let content = '';
  let streamError = '';

  await LLMAdapter.stream({
    provider:    opts.provider,
    model:       opts.model,
    messages:    [{ role: 'user', content: isEn ? `Please generate a topic outline for "${opts.kcName}".` : `请为「${opts.kcName}」生成专题纲要。` }],
    systemPrompt,
    maxTokens:   1200,
    temperature: 0.2,
    signal:      opts.signal,
    onChunk:     (c)     => { content += c; },
    onComplete:  (usage) => { opts.onComplete?.(usage); },
    onError:     (err)   => { streamError = err.message; },
  });

  if (streamError || !content.trim()) {
    throw new Error(streamError || localMsg(opts.language, '专题纲要生成失败，内容为空。', 'Topic outline generation failed: empty response.'));
  }

  // Sanitize kcName for safe filesystem use
  const safeName = opts.kcName.replace(/[/\\:*?"<>|]/g, '-').slice(0, 30);
  const filename  = `_topic_${opts.kcId}_${safeName}.md`;
  const writePath = path.join(getOutlineDirPath(opts.courseId, opts.nodeId), filename);
  writeFileContent(writePath, content);
  opts.onProgressChunk(localMsg(opts.language, `✅ 专题纲要「${opts.kcName}」已保存至纲要文件夹。\n`, `✅ Topic outline for "${opts.kcName}" saved to Outline folder.\n`));

  return writePath;
}
