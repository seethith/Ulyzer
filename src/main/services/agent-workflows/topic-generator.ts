/**
 * Topic (专题) outline generator.
 *
 * A Topic is a deep-dive on a single KC from a node's outline.
 * Unlike outline versioning (which refines the whole blueprint), a Topic treats
 * one KC as a local learning problem and deepens it through representations,
 * misconceptions, guided practice directions, and mastery evidence.
 *
 * Output file: `纲要/_topic_{kcId}_{kcName}.md`
 */
import * as path from 'path';
import type { LLMProvider, SearchMode, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { getOutlineDirPath, writeFileContent } from '../fs/content.service';
import { buildOutlineSearchResults } from '../web/source-strategy';
import { localMsg } from '../prompt/prompt-builder';
import { getArtifactDisplayName } from '../agent-i18n/artifact-names';
import { message } from '../agent-i18n/messages';
import { formatGenerationStepTrace } from './material/material-progress-trace';
import { buildOutlineContextForArtifact } from './outline-context';

export interface TopicGenerateOptions {
  courseId:  string;
  nodeId:    string;
  kcId:      string;   // e.g. "KC3"
  kcName:    string;   // e.g. "变量作用域"
  provider:  LLMProvider;
  model:     string;
  signal?:   AbortSignal;
  language?: string;
  searchMode?: SearchMode;
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
  const workflowStartedAt = Date.now();
  const searchMode = opts.searchMode ?? 'auto';
  const kind = localMsg(opts.language, '专题', 'topic');
  opts.onProgressChunk(localMsg(opts.language, `📝 正在为「${opts.kcName}」生成专题纲要…\n`, `📝 Generating topic outline for "${opts.kcName}"…\n`));
  opts.onProgressChunk(localMsg(
    opts.language,
    `- 专题检索模式：${searchMode}；会按当前对话的搜索策略处理专题参考。\n`,
    `- Topic retrieval mode: ${searchMode}; using the current conversation search policy for topic references.\n`,
  ));

  // Read parent outline context for this KC across v1-v3.
  const parentStartedAt = Date.now();
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '读取父纲要', 'read parent outline'),
    status: 'start',
    detail: localMsg(opts.language, '精确抽取 v1-v3 中与该 KC 相关的定义、题型和复盘线索。', 'Extracting this KC from v1-v3: definition, exercise cues, and review cues.'),
    language: opts.language,
  }));
  const parentOutline = buildOutlineContextForArtifact({
    courseId: opts.courseId,
    nodeId: opts.nodeId,
    artifactKind: 'topic',
    language: opts.language,
    kcId: opts.kcId,
    kcName: opts.kcName,
  });
  const parentOutlineText = parentOutline.text;
  const parentVersion = parentOutline.versionLabel;
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '读取父纲要', 'read parent outline'),
    status: parentOutlineText ? 'done' : 'skip',
    durationMs: Date.now() - parentStartedAt,
    detail: localMsg(opts.language, `版本 ${parentVersion}；读取 ${parentOutlineText.length.toLocaleString('en-US')} 字符。`, `Version ${parentVersion}; read ${parentOutlineText.length.toLocaleString('en-US')} chars.`),
    language: opts.language,
  }));

  // Web search focused on the specific KC name for deep-dive material
  let webContext = '';
  let referenceCount = 0;
  const sourceStartedAt = Date.now();
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '检索专题参考', 'retrieve topic references'),
    status: 'start',
    detail: localMsg(opts.language, `搜索模式 ${searchMode}；围绕 ${opts.kcId} ${opts.kcName} 查找深挖参考。`, `Search mode ${searchMode}; retrieving deep-dive references for ${opts.kcId} ${opts.kcName}.`),
    language: opts.language,
  }));
  try {
    const results = await buildOutlineSearchResults(
      opts.kcName, null,
      {
        provider: opts.provider as string,
        model: opts.model,
        signal: opts.signal,
        courseId: opts.courseId,
        nodeId: opts.nodeId,
        searchMode,
        language: opts.language,
        onUsage: opts.onComplete,
      },
    );
    referenceCount = results.length;
    if (results.length > 0) {
      webContext = results
        .slice(0, 3)
        .map((r) => `[参考] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 400)}`)
        .join('\n\n');
    }
    opts.onProgressChunk(formatGenerationStepTrace({
      kind,
      step: localMsg(opts.language, '检索专题参考', 'retrieve topic references'),
      status: 'done',
      durationMs: Date.now() - sourceStartedAt,
      detail: localMsg(opts.language, `采用参考 ${referenceCount} 条；注入正文上下文 ${webContext.length.toLocaleString('en-US')} 字符。`, `${referenceCount} reference(s); injected ${webContext.length.toLocaleString('en-US')} chars into context.`),
      language: opts.language,
    }));
  } catch (err) {
    opts.onProgressChunk(formatGenerationStepTrace({
      kind,
      step: localMsg(opts.language, '检索专题参考', 'retrieve topic references'),
      status: 'fail',
      durationMs: Date.now() - sourceStartedAt,
      detail: localMsg(opts.language, `非致命，改用父纲要生成：${err instanceof Error ? err.message : String(err)}`, `Non-fatal; using parent outline only: ${err instanceof Error ? err.message : String(err)}`),
      language: opts.language,
    }));
  }

  const isEn = opts.language === 'en';

  const parentSection = parentOutlineText
    ? isEn
      ? `**Parent blueprint context (${node.name}) — KC-specific v1-v3 excerpts:**\n${parentOutlineText.slice(0, 4_000)}\n\n`
      : `**父节点蓝图上下文（${node.name}）— 该 KC 的 v1-v3 相关片段：**\n${parentOutlineText.slice(0, 4_000)}\n\n`
    : '';

  const webSection = webContext
    ? isEn
      ? `**Search references (focus on misconceptions, expert-level details, edge conditions):**\n${webContext}\n\n`
      : `**搜索参考（重点参考误解、专家级细节、边界条件）：**\n${webContext}\n\n`
    : '';

  const systemPrompt = isEn
    ? `You are a knowledge-structure architect. Generate a Topic KC Outline for "${opts.kcName}" (${opts.kcId} from node "${node.name}").\n\n` +
      `**Goal:** Learning-oriented topic blueprint — treat this KC as a focused learning problem. Deepen it only as much as needed to improve explanation, practice, and review quality.\n\n` +
      parentSection +
      webSection +
      `**Generation approach (internalize, do not write out):**\n` +
      `① Clarify what this KC is for and what problem it helps the learner solve.\n` +
      `② Choose the granularity freely: add sub-KCs only when they reveal a real internal structure.\n` +
      `③ Cover useful representations/examples/counterexamples, misconceptions, practice directions, and mastery evidence without repeating the parent blueprint.\n` +
      `④ Evidence & Diagnosis must pair positive mastery evidence with likely errors, so practice and Feynman review can generate targeted tasks.\n\n` +
      `**Strict output format (no explanations):**\n\n` +
      `# Topic Blueprint — ${opts.kcName} (from "${node.name}" ${opts.kcId})\n\n` +
      `## 1. Focus & Boundary\n- Learning purpose: ...\n- In scope: ...\n- Out of scope: ...\n\n` +
      `## 2. Internal Structure\n### KC1: [Name]\n- Learning role: ...\n- Cognitive action: ...\n- Prerequisites: None\n- Core relation: ...\n- Representation + minimal example / key counterexample: ...\n- Common misconception: ...\n- Mastery evidence: ...\n\n...\n\n` +
      `## 3. Learning Path\n- Best first explanation angle: ...\n- Worked example direction: ...\n- Guided practice direction: ...\n- Transfer direction: ...\n- Self-check question: ...\n\n` +
      `## 4. Evidence & Diagnosis\n| KC | Mastery evidence | Common error / misconception | Knowledge gap | Useful practice/review prompt |\n| --- | --- | --- | --- | --- |\n| KC1 | Observable behavior or answer that proves this sub-KC is mastered | Likely wrong answer or misconception | What the error reveals | Question-generation hint; do not write a full exercise |\n\n` +
      `Keep it compact. Sub-KC count is chosen by learning need, not by quota.`
    : `你是知识结构规划师，为知识组件「${opts.kcName}」（来自节点「${node.name}」的 ${opts.kcId}）生成专题 KC 纲要。\n\n` +
      `**定位：** 学习型专题蓝图——把该 KC 当作一个聚焦学习问题，只在能提升讲解、练习和复盘质量时做必要深挖。\n\n` +
      parentSection +
      webSection +
      `**生成思路（内化，不要写出）：**\n` +
      `① 先明确这个 KC 用来解决什么学习问题。\n` +
      `② 自由决定粒度；只有当内部结构确实需要时，才拆出子 KC。\n` +
      `③ 覆盖有用的表征/例子/反例、常见误解、练习方向和掌握证据，但不要重复父蓝图已有内容。\n` +
      `④ 证据与诊断必须同时包含正向掌握表现和常见错误缺口，方便实践资料和费曼复盘生成针对性任务。\n\n` +
      `**严格输出格式（不输出任何解释）：**\n\n` +
      `# 专题蓝图 — ${opts.kcName}（来自「${node.name}」${opts.kcId}）\n\n` +
      `## 1. 聚焦与边界\n- 学习用途：...\n- 本专题包含：...\n- 本专题不包含：...\n\n` +
      `## 2. 内部结构\n### KC1: [名称]\n- 学习作用：...\n- 认知动作：...\n- 前置依赖：无\n- 核心关系：...\n- 表征与例反例：...\n- 常见误解：...\n- 掌握证据：...\n\n...\n\n` +
      `## 3. 学习路径\n- 最适合的讲解角度：...\n- Worked Example 方向：...\n- 引导练习方向：...\n- 迁移方向：...\n- 自检问题：...\n\n` +
      `## 4. 证据与诊断\n| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |\n| --- | --- | --- | --- | --- |\n| KC1 | 能证明该子 KC 已掌握的可观察行为或答案 | 可能出现的错误答案或误解 | 该错误暴露的知识缺口 | 题目/复盘问题的生成提示，不要写完整题目 |\n\n` +
      `保持精炼。子 KC 数量由学习需要决定，不按配额凑数。`;

  const maxTokens = 2000;
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '构建专题提示词', 'build topic prompt'),
    status: 'done',
    detail: localMsg(opts.language, `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；输出上限 ${maxTokens.toLocaleString('en-US')} tokens；子 KC 数量由学习需要决定。`, `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; output cap ${maxTokens.toLocaleString('en-US')} tokens; sub-KC count is need-driven.`),
    language: opts.language,
  }));

  let content = '';
  let streamError = '';

  const generationStartedAt = Date.now();
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '模型生成专题', 'model drafts topic outline'),
    status: 'start',
    detail: localMsg(opts.language, '调用模型输出专题纲要全文。', 'Calling the model to produce the full topic outline.'),
    language: opts.language,
  }));
  await LLMAdapter.stream({
    provider:    opts.provider,
    model:       opts.model,
    messages:    [{ role: 'user', content: isEn ? `Please generate a topic outline for "${opts.kcName}".` : `请为「${opts.kcName}」生成专题纲要。` }],
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    signal:      opts.signal,
    onChunk:     (c)     => { content += c; },
    onComplete:  (usage) => { opts.onComplete?.(usage); },
    onError:     (err)   => { streamError = err.message; },
  });
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '模型生成专题', 'model drafts topic outline'),
    status: streamError || !content.trim() ? 'fail' : 'done',
    durationMs: Date.now() - generationStartedAt,
    detail: streamError
      ? streamError
      : localMsg(opts.language, `输出约 ${content.trim().length.toLocaleString('en-US')} 字符。`, `Output about ${content.trim().length.toLocaleString('en-US')} chars.`),
    language: opts.language,
  }));

  if (streamError || !content.trim()) {
    throw new Error(streamError || message('topicOutlineGenerationFailed', opts.language, {
      error: localMsg(opts.language, '内容为空', 'empty response'),
    }));
  }

  // Sanitize kcName for safe filesystem use
  const safeName = opts.kcName.replace(/[/\\:*?"<>|]/g, '-').slice(0, 30);
  const filename  = `_topic_${opts.kcId}_${safeName}.md`;
  const writePath = path.join(getOutlineDirPath(opts.courseId, opts.nodeId), filename);
  const persistStartedAt = Date.now();
  writeFileContent(writePath, content);
  opts.onProgressChunk(formatGenerationStepTrace({
    kind,
    step: localMsg(opts.language, '写入专题文件', 'persist topic file'),
    status: 'done',
    durationMs: Date.now() - persistStartedAt,
    detail: localMsg(opts.language, `保存到 ${filename}；总耗时 ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)} 秒。`, `Saved as ${filename}; total ${((Date.now() - workflowStartedAt) / 1000).toFixed(1)}s.`),
    language: opts.language,
  }));
  opts.onProgressChunk(message('topicOutlineSavedProgress', opts.language, {
    topic:  opts.kcName,
    folder: getArtifactDisplayName('outline', opts.language),
  }));

  return writePath;
}
