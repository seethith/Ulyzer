/**
 * SubTutorLoop — agentic material generation, provider-neutral.
 *
 * Architecture: LLMAdapter.streamWithTools(), multi-turn loop.
 *   Turn N: model decides which tool to call (rag_retrieve / web_search /
 *            generate_quiz / check_difficulty / save_file)
 *   Tool executes → result fed back → model continues
 *   When model emits pure text (end_turn) → loop exits
 *
 * Compression layers (cheapest → most expensive):
 *   1. Snip       — truncate single oversized messages  (snipMessage, always on)
 *   2. Microcompact — fold old turns into summary stub  (>20 turns, >85% budget)
 *   3. Context Collapse — LLM-generated summary         (>90% budget)
 */
import * as fs from 'fs';
import * as path from 'path';
import type { GenerateFolder, TokenUsage, FileGeneratedPayload, LLMProvider } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import type { ToolTurnMessage, ToolCallBlock, ToolResultBlock } from '../llm/adapter';
import { NodeRepository } from '../db/repositories/node.repo';
import { buildTieredSources, buildPracticeSources, buildOutlineSearchResults, detectDomain } from '../web/source-strategy';
import { youtubeSearch } from '../web/youtube';
import { checkKcCoverage, MAX_OUTLINE_VERSION } from './outline-version';
import { getFolderPath, getCourseDir, writeFileContent, getLatestOutlinePath, getOutlineV1WritePath } from '../fs/content.service';
import type { ToolContext } from './tutor-tools/index';
import { getTool, getAllTools, truncateResult } from './tutor-tools/index';
import { buildToolDefs } from './tutor-tools/registry';
import { buildSystemPrompt, roleLayer, languageLayer, localMsg } from '../prompt/prompt-builder';
import { classifyError, exponentialBackoff } from '../llm/errors';
import { compressToolHistory, collapseContext } from './agent-loop';
import { createBudget } from './token-budget';
import { createLogger } from '../../utils/logger';

const log = createLogger('SubTutorLoop');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 12;

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner: '入门', intermediate: '进阶', advanced: '高级',
};
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
};
function diffLabel(difficulty: string, language?: string): string {
  const map = language === 'en' ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH;
  return map[difficulty] ?? difficulty;
}

const FOLDER_GUIDE_ZH: Record<string, string> = {
  practice:
    '生成实践资料，读取 [知识纲要] 中每个知识点及其布鲁姆认知层级，按**四层结构**出题，覆盖所有知识点。\n\n' +
    '**工作流：** 调用 generate_quiz 获取出题计划 → 按计划生成四层题目，严格保证四层均有题目且应用层占比最高 → **在同一次响应中调用两次 save_file**（先保存题目文件，再保存参考答案文件）。\n\n' +
    '**四层结构与比例：**\n' +
    '- **第一层（记忆/理解，约 20%）**：针对 [记忆/理解] 知识点，验证基础认知——问答、判断、填空、名词解释。\n' +
    '- **第二层（分析/评估，约 15%）**：针对 [分析/评估] 知识点，引导批判性思考——比较分析、优劣评价、场景判断，要求说明理由。\n' +
    '- **第三层（应用，约 50%）**：针对所有知识点（[应用] 标注的为主），在真实场景中使用知识——\n' +
    '  编程/计算 → 有标准解法的代码题；操作/制作 → 步骤任务；情景/表演 → 模拟演示；创意技能 → 有约束条件的实操任务。\n' +
    '  **每个知识点至少 1 个应用任务。**\n' +
    '- **第四层（创造，约 15%）**：针对 [创造] 知识点，开放性综合任务——明确评价维度（完整性/创意性/技术准确性等），学生自主选择方式完成，无标准答案。\n\n' +
    '**选择题选项必须用列表格式（每个选项单独一行）：**\n  - A. 选项内容\n  - B. 选项内容\n\n' +
    '**⚠️ 每道题末尾必须标注来源（不得省略）：** 从权威资料/题库改编的写 `来源：{平台或书名} {URL或页码}`；AI 自行创作的写 `[AI原创]`。\n\n' +
    '**⚠️ 关键要求——题目与答案必须分两个文件保存：**\n' +
    '1. **题目文件**（folderName: "practice"）：只含题目，不得在题后写答案；每题末尾标注题号（如 Q1、Q2）；文件末尾加一行 `> 参考答案见「参考答案」文件夹。`\n' +
    '2. **参考答案文件**（folderName: "answer"，与题目文件同一次响应中保存）：文件名与题目文件相同（如 题目文件名是 xxx-练习题.md，答案文件名即 xxx-参考答案.md）；' +
    '文件顶部必须加声明：`> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。`；' +
    '每道题按 Q1/Q2… 编号列出：解题思路 → 完整答案 → 常见错误提示；' +
    '编程题额外提供可运行的测试用例（输入/预期输出）；创造层题目给出评分维度说明而非标准答案。',
  theory:
    '生成原理资料，依据 [知识纲要] 中的知识点和深度层级确定本次覆盖范围（[已有资料覆盖情况] 已有内容不重复，优先补充未覆盖层级）。\n' +
    '资料结构**七节固定**，必须严格按以下顺序输出：\n' +
    '## 一、基础概念与原理\n简洁定义，可用 Mermaid 图辅助\n' +
    '## 二、深层理解（问一答）\n以问答形式讲易错点、误区、深层原理；问题必须"用背书无法回答"\n' +
    '## 三、拓展与对比\n相关概念表格对比、关键模型差异\n' +
    '## 四、疑难点与示例\n边界情况、复杂场景代码示例\n' +
    '## 五、学习建议\n针对本节点给出 3-5 条具体可操作的学习路径建议：先学什么、重点攻克什么、容易卡住在哪里以及如何突破、掌握到什么程度才算过关。建议必须具体，不得泛泛而谈，禁止出现任何时间估算（如"2小时"、"一周"等）。\n' +
    '## 六、参考资料\n每条资源给出：完整链接（优先使用上方权威参考来源中的 URL）+ 搜索建议词（链接失效或想找更多时使用）。\n格式：`- [资源名称](完整URL) — 搜索："关键词"`\n视频资源同样格式，URL 来自参考来源时直接用，无 URL 时只给搜索建议词。',
  answer:
    '生成参考答案文件，对应「实践资料」中已有的题目。\n\n' +
    '**格式要求：**\n' +
    '- 文件顶部必须加声明：`> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。`\n' +
    '- 按题号（Q1/Q2…）逐题列出，每题包含：解题思路 → 完整答案 → 常见错误提示\n' +
    '- 编程题额外提供可运行的测试用例（输入/预期输出）\n' +
    '- 创造层开放题给出评分维度说明而非标准答案\n' +
    '- folderName 必须填 "answer"，文件名与对应题目文件相同（将题目文件名中的"练习题"替换为"参考答案"）',
};

const FOLDER_GUIDE_EN: Record<string, string> = {
  practice:
    'Generate practice exercises. Read each KC and its Bloom level from [Knowledge Outline], then produce exercises across **4 tiers**, covering every KC.\n\n' +
    '**Workflow:** Call generate_quiz for the exercise plan → produce all 4 tiers strictly per plan → **call save_file twice in the same response** (first save the exercise file, then the answer key).\n\n' +
    '**4-Tier structure and proportions:**\n' +
    '- **Tier 1 (Remember/Understand, ~20%):** Target [Remember/Understand] KCs — basic comprehension: Q&A, true/false, fill-in-the-blank, term definitions.\n' +
    '- **Tier 2 (Analyse/Evaluate, ~15%):** Target [Analyse/Evaluate] KCs — critical thinking: comparison, evaluation, scenario judgment (always require reasoning).\n' +
    '- **Tier 3 (Apply, ~50%):** Target all KCs (especially [Apply] ones) in real-world scenarios — coding/calculation tasks with standard solutions; operation/creation tasks with step-by-step requirements; scenario simulations; creative tasks with explicit constraints. **At least 1 apply task per KC.**\n' +
    '- **Tier 4 (Create, ~15%):** Target [Create] KCs — open-ended synthesis tasks; specify evaluation criteria (completeness / creativity / technical accuracy etc.); no single correct answer.\n\n' +
    '**Multiple-choice options must use list format (one option per line):**\n  - A. option text\n  - B. option text\n\n' +
    '**⚠️ Each question must end with a source citation (mandatory):** Adapted from authoritative material: `Source: {platform or book} {URL or page}`; AI-original: `[AI Original]`\n\n' +
    '**⚠️ Critical — exercises and answers must be saved in two separate files:**\n' +
    '1. **Exercise file** (folderName: "practice"): questions only, no inline answers; label each question Q1, Q2…; add at the end: `> Answer key is in the "Answer" folder.`\n' +
    '2. **Answer key file** (folderName: "answer", saved in the same response): filename should match the exercise file; must start with: `> ⚠️ AI-generated answer key — for reference only, please verify before use.`; each answer labelled Q1/Q2…: reasoning → full answer → common mistakes; coding questions include runnable test cases (input / expected output); Tier 4 creative questions provide evaluation rubrics instead of standard answers.',
  theory:
    'Generate theory materials based on the KCs and Bloom levels in [Knowledge Outline]. Prioritise depth levels not yet covered — already-covered content listed in [Coverage Index] must not be repeated.\n' +
    'The material must follow this **7-section fixed structure** in exact order:\n' +
    '## 1. Core Concepts & Principles\nConcise definitions; Mermaid diagrams where helpful\n' +
    '## 2. Deep Understanding (Q&A)\nQ&A format covering misconceptions, pitfalls, and underlying principles; every question must be unanswerable by rote memorisation\n' +
    '## 3. Extensions & Comparisons\nTable comparisons of related concepts, key model/paradigm differences\n' +
    '## 4. Edge Cases & Examples\nBoundary conditions, code examples for complex or ambiguous scenarios\n' +
    '## 5. Learning Recommendations\n3–5 specific, actionable study-path suggestions: what to learn first, what to focus on, common stumbling points and how to overcome them. Must be concrete — no vague advice, no time estimates.\n' +
    '## 6. References\nFor each resource: full link (prefer URLs from the authoritative sources above) + search suggestion.\nFormat: `- [Resource Name](full URL) — Search: "keywords"`\nVideo resources use the same format; if no URL is available, provide search keywords only.',
  answer:
    'Generate an answer key file corresponding to an existing exercise file in the Practice folder.\n\n' +
    '**Format requirements:**\n' +
    '- File must begin with: `> ⚠️ AI-generated answer key — for reference only, please verify before use.`\n' +
    '- List each answer by question number (Q1/Q2…): reasoning → full answer → common mistakes\n' +
    '- Coding questions must include runnable test cases (input / expected output)\n' +
    '- Tier 4 creative questions provide evaluation rubrics instead of standard answers\n' +
    '- folderName must be "answer"; the filename should match the corresponding exercise file',
};

function getFolderGuide(folderName: string, language?: string): string {
  const guide = language === 'en' ? FOLDER_GUIDE_EN : FOLDER_GUIDE_ZH;
  return guide[folderName] ?? '';
}

// ── Repositories ──────────────────────────────────────────────────────────────

const nodeRepo = new NodeRepository();

// ── Outline & index helpers ───────────────────────────────────────────────────

function readIndexMd(courseId: string, nodeId: string, folderName: string): string {
  const indexPath = path.join(getFolderPath(courseId, nodeId, folderName), '_index.md');
  try {
    return fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';
  } catch {
    return '';
  }
}

// ── KC coverage helpers ───────────────────────────────────────────────────────

interface KcEntry { id: string; name: string }

/** Parse KC IDs and names from a KC-model outline (### KC1: 名称). Returns [] for legacy outlines. */
function parseKcsFromOutline(text: string): KcEntry[] {
  const entries: KcEntry[] = [];
  const re = /^### (KC\d+):\s*(.+)$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    entries.push({ id: m[1], name: m[2].trim() });
  }
  return entries;
}

/** Extract outline version string (v1/v2/v3) from file path; returns 'v1' for legacy. */
function getOutlineVersion(outlinePath: string | null): string {
  if (!outlinePath) return 'v1';
  const m = path.basename(outlinePath).match(/_outline_(v\d+)\.md/);
  return m ? m[1] : 'v1';
}

/**
 * Append a KC coverage record to _index.md after each file save.
 * - KC-model outlines: records which KC IDs are covered (by name match in content).
 * - Legacy outlines: falls back to H2 heading extraction.
 * Non-fatal — errors are logged and swallowed.
 */
function appendToIndexMd(
  courseId: string,
  nodeId: string,
  folderName: string,
  filename: string,
  content: string,
  language?: string,
): void {
  try {
    const folderPath  = getFolderPath(courseId, nodeId, folderName);
    const indexPath   = path.join(folderPath, '_index.md');
    const date        = new Date().toISOString().slice(0, 10);
    const FOLDER_LABEL_ZH: Record<string, string> = { theory: '原理资料', practice: '实践资料', answer: '参考答案', notes: '个人笔记' };
    const FOLDER_LABEL_EN: Record<string, string> = { theory: 'Theory', practice: 'Practice', answer: 'Answer', notes: 'Notes' };
    const folderLabel = (language === 'en' ? FOLDER_LABEL_EN : FOLDER_LABEL_ZH)[folderName] ?? folderName;

    // Try KC-based coverage (new format)
    const outlinePath = getLatestOutlinePath(courseId, nodeId);
    const outlineText = outlinePath
      ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8'); } catch { return ''; } })()
      : '';
    const kcs = parseKcsFromOutline(outlineText);

    let entry: string;
    if (kcs.length > 0) {
      const coveredIds = kcs.map((kc) => kc.id);
      const kcList = coveredIds.length > 0
        ? coveredIds.map((id) => {
            const kc = kcs.find((k) => k.id === id);
            return kc ? `${id} (${kc.name})` : id;
          }).join(', ')
        : localMsg(language, '（未匹配到 KC）', '(no KCs matched)');
      const version = getOutlineVersion(outlinePath);
      entry = language === 'en'
        ? `\n## ${filename} (${date})\nKCs covered: ${kcList}\nOutline version: ${version}\n`
        : `\n## ${filename}（${date}）\n覆盖KC：${kcList}\n深度版本：${version}\n`;
    } else {
      // Legacy fallback: extract H2 headings
      const headings = content
        .split('\n')
        .filter((line) => /^##\s/.test(line))
        .map((line)  => line.replace(/^##\s+/, '').trim())
        .join(language === 'en' ? ', ' : '、');
      entry = language === 'en'
        ? `\n## ${filename}\nCovers: ${headings || '(no section headings)'}\nDate: ${date}\n`
        : `\n## ${filename}\n覆盖：${headings || '（无章节标题）'}\n时间：${date}\n`;
    }

    let existing = '';
    if (fs.existsSync(indexPath)) {
      existing = fs.readFileSync(indexPath, 'utf-8');
    } else {
      existing = language === 'en' ? `# ${folderLabel} Index\n` : `# ${folderLabel}索引\n`;
    }

    writeFileContent(indexPath, existing + entry);
  } catch (err) {
    log.warn('写入 _index.md 失败（非致命）', { error: String(err) });
  }
}

/** Returns true if the outline already has Bloom-level annotations (Chinese or English). */
function outlineHasBloomTags(text: string): boolean {
  return /\[(记忆\/理解|分析\/评估|应用|创造|Remember\/Understand|Analyse\/Evaluate|Apply|Create)\]/.test(text);
}

const BLOOM_TARGET_LABEL_ZH: Record<string, string> = {
  remember_understand: '记忆/理解',
  analyze_evaluate:    '分析/评估',
  apply:               '应用',
  create:              '创造',
};
const BLOOM_TARGET_LABEL_EN: Record<string, string> = {
  remember_understand: 'Remember/Understand',
  analyze_evaluate:    'Analyse/Evaluate',
  apply:               'Apply',
  create:              'Create',
};

/** Minimal options for v1 outline generation — subset of SubTutorLoopRequest. */
export interface OutlineV1GenOpts {
  courseId: string;
  nodeId:   string;
  provider: LLMProvider;
  model:    string;
  signal?:  AbortSignal;
  language?: string;
  onProgressChunk: (msg: string) => void;
}

/** Generate v1 outline from scratch. Exported for use by the IPC handler when no outline exists yet. */
export async function generateOutlineV1(
  opts: OutlineV1GenOpts,
  node: import('@shared/types').DagNode,
): Promise<void> {
  return generateOutline(opts, node);
}

/** Dedicated LLM call to generate outline (written to 纲要/_outline_v1.md). */
async function generateOutline(
  req: OutlineV1GenOpts,
  node: import('@shared/types').DagNode,
): Promise<void> {
  req.onProgressChunk(localMsg(req.language, '📝 正在生成认知图谱（知识纲要）…\n', '📝 Generating knowledge outline…\n'));

  // ── Phase 1a: Read chapter_scope for this node ─────────────────────────────
  let nodeScope: string[]   = [];
  let boundaryNotes         = '';
  try {
    const scopePath = path.join(getCourseDir(req.courseId), '_chapter_scope.json');
    if (fs.existsSync(scopePath)) {
      const scopeData = JSON.parse(fs.readFileSync(scopePath, 'utf-8')) as Record<string, {
        scope_distribution?: Record<string, string[]>;
        boundary_notes?: string;
      }>;
      const chapterData = scopeData[node.chapter];
      if (chapterData?.scope_distribution?.[node.name]) {
        nodeScope = chapterData.scope_distribution[node.name];
      }
      if (chapterData?.boundary_notes) boundaryNotes = chapterData.boundary_notes;
    }
  } catch { /* non-fatal */ }

  // ── Phase 1b: Read adjacent node outlines (prereqs + same-chapter nodes) ──
  const allNodes    = nodeRepo.findByCourse(req.courseId);
  const prereqIds   = new Set(node.prerequisites ?? []);
  const adjacentIds = new Set(
    allNodes
      .filter((n) => prereqIds.has(n.id) || (n.chapter === node.chapter && n.id !== node.id))
      .map((n) => n.id),
  );

  const adjacentSections: string[] = [];
  for (const adj of allNodes.filter((n) => adjacentIds.has(n.id)).slice(0, 4)) {
    const adjPath = getLatestOutlinePath(req.courseId, adj.id);
    try {
      if (adjPath && fs.existsSync(adjPath)) {
        const content = fs.readFileSync(adjPath, 'utf-8').trim();
        if (content) {
          const label = prereqIds.has(adj.id)
            ? localMsg(req.language, '前置节点', 'prerequisite node')
            : localMsg(req.language, '同章节点', 'same-chapter node');
          adjacentSections.push(
            req.language === 'en'
              ? `### "${adj.name}" (${label}) — already covered:\n${content.slice(0, 500)}`
              : `### 「${adj.name}」（${label}）已覆盖的知识点：\n${content.slice(0, 500)}`,
          );
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Phase 1c: Web search for misconceptions / prerequisites / common mistakes ─
  let webContext = '';
  try {
    const outlineResults = await buildOutlineSearchResults(
      node.name, node.description ?? null,
      { provider: req.provider as string, model: req.model, signal: req.signal },
    );
    if (outlineResults.length > 0) {
      webContext = outlineResults
        .slice(0, 3)
        .map((r) => req.language === 'en'
          ? `[Reference] ${r.title}\nSource: ${r.url}\n${r.content.slice(0, 400)}`
          : `[参考] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 400)}`)
        .join('\n\n');
    }
  } catch { /* non-fatal — proceed without web context */ }

  // ── Phase 2: Build KC model system prompt ─────────────────────────────────
  const bloomTargetMap = req.language === 'en' ? BLOOM_TARGET_LABEL_EN : BLOOM_TARGET_LABEL_ZH;
  const bloomTarget  = node.bloom_target ? (bloomTargetMap[node.bloom_target] ?? node.bloom_target) : null;
  const isMotorSkill = node.learning_type === 'motor_skill';
  const isEn = req.language === 'en';

  const scopeSection = nodeScope.length > 0
    ? (isEn
        ? `\n\n**Knowledge scope for this node (from chapter_scope — stay strictly within this list):**\n`
        : `\n\n**本节点知识点范围（来自路线规划 chapter_scope，严格在此范围内）：**\n`) +
      nodeScope.map((k) => `- ${k}`).join('\n') +
      (boundaryNotes ? (isEn ? `\nBoundary notes: ${boundaryNotes}` : `\n边界备注：${boundaryNotes}`) : '')
    : '';

  const adjacentSection = adjacentSections.length > 0
    ? (isEn
        ? `\n\n**Already covered in adjacent nodes (avoid repeating these topics):**\n${adjacentSections.join('\n\n')}`
        : `\n\n**相邻节点已覆盖内容（生成时避免重复下列知识点）：**\n${adjacentSections.join('\n\n')}`)
    : '';

  const webSection = webContext
    ? (isEn
        ? `\n\n**Search references (focus on misconceptions, prerequisites, common mistakes to populate Misconceptions and Edge Conditions):**\n${webContext}`
        : `\n\n**搜索参考（重点参考其中的常见误解、前置知识、易犯错误，填充 Misconceptions 和边界条件）：**\n${webContext}`)
    : '';

  const bloomNote = bloomTarget
    ? (isEn
        ? `\n\n**Bloom level emphasis:** This node's bloomTarget is "${bloomTarget}" — KCs at this level should be the majority (~50%+).`
        : `\n\n**布鲁姆层级偏重：** 该节点 bloomTarget 为「${bloomTarget}」，此层级的 KC 占比应最高（约 50%+）。`)
    : '';

  const motorSkillNote = isMotorSkill
    ? (isEn
        ? `\n\n**Motor-skill node:** Procedural KCs must include specific operation steps ("how to do it"); conditional KCs must include self-check criteria ("signs of correct completion").`
        : `\n\n**动作技能节点：** 程序性 KC 的掌握指标必须包含具体操作步骤（"如何做"）；条件性 KC 需包含自检标准（"正确完成的标志"）。`)
    : '';

  const systemPrompt = isEn
    ? `You are a knowledge-structure architect. Generate a KC-based Knowledge Outline v1 for the learning node "${node.name}" (${node.chapter}, ${diffLabel(node.difficulty, req.language)}).\n\n` +
      `**Output the outline structure only — no teaching content.**` +
      scopeSection + adjacentSection + webSection + bloomNote + motorSkillNote +
      `\n\n**Generation logic (internalise, do not write out):**\n` +
      `① What specific, observable tasks will the learner be able to perform after completing this node? (Work backwards from outcomes to KCs)\n` +
      `② Decompose the endpoint goal into 3–6 atomic KCs; establish prerequisite dependencies between KCs\n` +
      `③ Assign type / Bloom level / mastery indicator to each KC; extract misconceptions and edge conditions from the search references\n\n` +
      `**KC Types:**\n` +
      `- Declarative: knows "what" (definitions / concepts / facts)\n` +
      `- Procedural: knows "how" (operations / steps / methods)\n` +
      `- Conditional: knows "when to use" (judgements / strategies / trade-offs)\n\n` +
      `**Strict output format:**\n\n` +
      `# Knowledge Outline — ${node.name} (v1)\n\n` +
      `## Knowledge Units (KCs)\n\n` +
      `### KC1: [Name]\n` +
      `- Type: Declarative\n` +
      `- Bloom Level: [Remember/Understand]\n` +
      `- Prerequisite KCs: None\n` +
      `- Mastery Indicator: [specific observable behaviour]\n\n` +
      `### KC2: [Name]\n` +
      `- Type: Procedural\n` +
      `- Bloom Level: [Apply]\n` +
      `- Prerequisite KCs: KC1\n` +
      `- Mastery Indicator: [specific observable behaviour]\n\n` +
      `...\n\n` +
      `## Common Misconceptions\n` +
      `1. Misconception: [incorrect belief]  Reality: [correct understanding]\n` +
      `2. Misconception: ...  Reality: ...\n\n` +
      `## Edge Conditions\n` +
      `- [edge case or counter-intuitive scenario and why]\n\n` +
      `Number of KCs: 5–8; Bloom levels must be one of: [Remember/Understand] [Analyse/Evaluate] [Apply] [Create];\n` +
      `Prerequisite KCs may only reference KC IDs already defined in this outline (use "None" if none); at least 2 misconceptions; at least 1 edge condition.`
    : `你是知识结构规划师，为学习节点「${node.name}」（${node.chapter}，${diffLabel(node.difficulty, req.language)}难度）生成 KC 知识纲要 v1。\n\n` +
      `**只输出纲要结构，不输出任何教学内容。**` +
      scopeSection + adjacentSection + webSection + bloomNote + motorSkillNote +
      `\n\n**生成思路（内化，不要写出）：**\n` +
      `① 该节点学完后学生能完成哪些具体可观察的任务？（从终点反推 KC）\n` +
      `② 把终点目标拆成 3-6 个原子 KC，建立 KC 间前置依赖\n` +
      `③ 为每个 KC 定类型/层级/掌握指标；从搜索参考中提炼误解和边界条件\n\n` +
      `**KC 类型：**\n` +
      `- 陈述性：知道"是什么"（定义/概念/事实）\n` +
      `- 程序性：知道"怎么做"（操作/步骤/方法）\n` +
      `- 条件性：知道"什么情况下用"（判断/策略/取舍）\n\n` +
      `**严格输出格式：**\n\n` +
      `# 知识纲要 — ${node.name}（v1）\n\n` +
      `## 知识单元（KCs）\n\n` +
      `### KC1: [名称]\n` +
      `- 类型：陈述性\n` +
      `- 布鲁姆层级：[记忆/理解]\n` +
      `- 前置KC：无\n` +
      `- 掌握指标：[具体可观察的行为描述]\n\n` +
      `### KC2: [名称]\n` +
      `- 类型：程序性\n` +
      `- 布鲁姆层级：[应用]\n` +
      `- 前置KC：KC1\n` +
      `- 掌握指标：[具体可观察的行为描述]\n\n` +
      `...\n\n` +
      `## 常见误解（Misconceptions）\n` +
      `1. 误解：[错误认知]  实际：[正确理解]\n` +
      `2. 误解：...  实际：...\n\n` +
      `## 边界条件\n` +
      `- [特殊情况或反直觉场景及原因]\n\n` +
      `KC 数量 5-8 个；布鲁姆层级只能用：[记忆/理解] [分析/评估] [应用] [创造]；\n` +
      `前置KC 只能引用本纲要已定义的编号（无前置写"无"）；常见误解至少 2 条；边界条件至少 1 条。`;

  const maxTokens = 1100
    + (nodeScope.length > 0        ? 200 : 0)
    + (adjacentSections.length > 0 ? 100 : 0)
    + (webContext                   ? 100 : 0);

  let outlineContent = '';
  let streamError    = '';

  await LLMAdapter.stream({
    provider:    req.provider,
    model:       req.model,
    messages:    [{ role: 'user', content: req.language === 'en'
      ? `Node: ${node.name}, difficulty: ${node.difficulty}, description: ${node.description ?? 'none'}. Please generate the knowledge outline.`
      : `节点：${node.name}，难度：${node.difficulty}，描述：${node.description ?? '无'}。请生成知识纲要。` }],
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    signal:      req.signal,
    onChunk:     (chunk) => { outlineContent += chunk; },
    onComplete:  () => {},
    onError:     (err)  => { streamError = err.message; },
  });

  if (streamError || !outlineContent.trim()) {
    throw new Error(streamError || localMsg(req.language, '知识纲要生成失败，内容为空', 'Outline generation failed: empty response'));
  }

  writeFileContent(getOutlineV1WritePath(req.courseId, req.nodeId), outlineContent);
  req.onProgressChunk(localMsg(req.language, '✅ 知识纲要已生成，开始生成资料…\n', '✅ Knowledge outline ready, starting material generation…\n'));
}

// ── Request / result types ────────────────────────────────────────────────────

export interface SubTutorLoopRequest {
  sessionId: string;
  courseId:  string;
  nodeId:    string;
  provider:  LLMProvider;
  model:     string;
  targetFolder: GenerateFolder;
  userMessage:  string;
  signal?:      AbortSignal;
  /** UI language — used to instruct AI to respond in the correct language */
  language?: string;
  onChunk:          (chunk: string) => void;
  /** Progress messages (tool status, compression notices) — not saved to chat history */
  onProgressChunk:  (chunk: string) => void;
  onComplete:       (usage: TokenUsage) => void;
  onError:          (errorMsg: string) => void;
  onFileGenerated:  (payload: FileGeneratedPayload) => void;
}

// ── Concurrency lock ──────────────────────────────────────────────────────────
// Prevents two SubTutorLoop instances from running for the same node+folder at
// the same time (e.g. AGENT_GENERATE + AGENT_CHAT generate_theory both firing).

const activeRuns = new Set<string>();

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * Run the agentic SubTutor loop using the provider-neutral LLMAdapter.
 * Returns true if a file was successfully saved, false otherwise.
 */
export async function runSubTutorLoop(req: SubTutorLoopRequest): Promise<boolean> {
  const lockKey = `${req.nodeId}:${req.targetFolder}`;
  if (activeRuns.has(lockKey)) {
    log.warn('Duplicate loop request skipped', { nodeId: req.nodeId, folder: req.targetFolder });
    return false;
  }
  activeRuns.add(lockKey);
  try {

  const node = nodeRepo.findById(req.nodeId);
  if (!node) {
    req.onError(localMsg(req.language, `节点不存在: ${req.nodeId}`, `Node not found: ${req.nodeId}`));
    return false;
  }

  // Check / generate knowledge outline (in 纲要/ subfolder).
  // If missing OR lacks Bloom tags (old format), regenerate to get cognitive graph.
  const existingOutlinePath = getLatestOutlinePath(req.courseId, req.nodeId);
  const existingOutline = existingOutlinePath
    ? (() => { try { return fs.readFileSync(existingOutlinePath, 'utf-8'); } catch { return ''; } })()
    : '';
  if (!existingOutline || !outlineHasBloomTags(existingOutline)) {
    try {
      await generateOutline(req, node);
    } catch (err) {
      req.onError(localMsg(req.language, `知识纲要生成失败：${err instanceof Error ? err.message : String(err)}`, `Outline generation failed: ${err instanceof Error ? err.message : String(err)}`));
      return false;
    }
  }

  // Read outline (freshly written above if regenerated)
  const outlineText = (() => {
    try {
      const p = getLatestOutlinePath(req.courseId, req.nodeId);
      return p ? fs.readFileSync(p, 'utf-8').trim() : '';
    } catch { return ''; }
  })();

  // Passive coverage notification — non-blocking, informs the user of upgrade opportunity.
  // Does NOT auto-upgrade; the user must explicitly request the next version.
  try {
    const kcStatus = checkKcCoverage(req.courseId, req.nodeId);
    if (kcStatus.isFullyCovered && kcStatus.version > 0) {
      if (kcStatus.version < MAX_OUTLINE_VERSION) {
        req.onProgressChunk(localMsg(req.language,
          `💡 当前纲要 v${kcStatus.version} 所有 ${kcStatus.allKcIds.length} 个 KC 已有资料覆盖，可点击「升级纲要」生成 v${kcStatus.version + 1} 获得更深层知识结构。\n`,
          `💡 Outline v${kcStatus.version}: all ${kcStatus.allKcIds.length} KCs covered. Click "Upgrade Outline" to generate v${kcStatus.version + 1} for a deeper knowledge structure.\n`,
        ));
      } else {
        req.onProgressChunk(localMsg(req.language,
          `💡 纲要已到 v${MAX_OUTLINE_VERSION}（最深层级），建议通过「生成专题」深入某个 KC。\n`,
          `💡 Outline is at v${MAX_OUTLINE_VERSION} (deepest level). Use "Deep Dive" to go further into a specific KC.\n`,
        ));
      }
    }
  } catch { /* non-fatal */ }

  const isPractice = req.targetFolder === 'practice' || req.targetFolder === 'answer';

  // Fetch tiered sources
  req.onProgressChunk(localMsg(req.language, '📚 正在检索权威参考来源…\n', '📚 Retrieving authoritative reference sources…\n'));
  const domain = detectDomain(node.name, node.description);

  const [tieredSources, practiceSources, videoResults] = await Promise.all([
    buildTieredSources(
      node.name, node.description, node.difficulty,
      { learning_type: node.learning_type, bloom_target: node.bloom_target },
      { provider: req.provider, model: req.model, signal: req.signal },
    ),
    isPractice
      ? buildPracticeSources(
          node.name, domain, 'academic_qa', undefined,
          { provider: req.provider, model: req.model, signal: req.signal },
        )
      : Promise.resolve([]),
    (req.targetFolder === 'theory' || req.targetFolder === 'practice')
      ? youtubeSearch(node.name, { keywords: ['教程', '讲解'], maxResults: 3 }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const allSources = [...tieredSources, ...practiceSources]
    .sort((a, b) => a.tier - b.tier)
    .slice(0, 8);
  // Practice content needs more context per result (1500 chars vs 500) to capture full answers
  const contentMaxChars = isPractice ? 1500 : 500;
  const sourceText = allSources.length > 0
    ? allSources
        .map((s) => `### [Tier ${s.tier}] ${s.title}\n${req.language === 'en' ? 'Source' : '来源'}：${s.url}\n${s.content.slice(0, contentMaxChars)}`)
        .join('\n\n')
    : '';

  // Build prerequisite names for context
  const allNodes   = nodeRepo.findByCourse(req.courseId);
  const prereqNames = (node.prerequisites ?? [])
    .map((pid) => allNodes.find((n) => n.id === pid)?.name ?? pid)
    .join(req.language === 'en' ? ', ' : '、');

  // Read coverage index
  const indexText = isPractice || req.targetFolder === 'theory'
    ? readIndexMd(req.courseId, req.nodeId, req.targetFolder)
    : '';

  // Learning-type specific note injected into practice/answer generation
  const motorSkillPracticeNote =
    isPractice && node.learning_type === 'motor_skill'
      ? '\n\n**动作技能节点（motor_skill）实践题格式要求：**\n' +
        '第三层（应用）题目必须以"操作任务"格式为主（占应用层 70% 以上），不得以选择题或填空题替代：\n' +
        '- 描述学员需要完成的具体操作动作（而非"选出正确步骤"）\n' +
        '- 给出操作正确的自检标准（"完成后应看到 / 感受到什么"）\n' +
        '- 标注常见操作错误和注意事项\n' +
        '选择题和简答题只出现在第一层（记忆/理解）和第二层（分析/评估），应用层不出选择题。'
      : '';

  // Initial user message with sources injected
  const folderGuide = getFolderGuide(req.targetFolder, req.language);
  // Messages that carry no custom formatting requirements — use folder guide as-is.
  // Prefix-match so preset messages like "请按照…，要求" + user additions still match.
  const DEFAULT_PREFIXES = [
    '请帮我生成相关学习资料',
    '帮我生成原理资料',
    '帮我生成实践资料',
    '帮我生成费曼复盘清单',
    '帮我总结复盘',
    '请按照当前节点的知识纲要，为我生成一份原理资料',
    '请按照当前节点的知识纲要，为我生成一套练习题',
    '我已学完本节点，请为我生成一份费曼复盘清单',
    // English presets
    'Following the current node outline, please generate theory material',
    'Following the current node outline, please generate practice exercises',
    "I've finished this node. Please generate a Feynman review checklist",
    'Please generate (or upgrade) the knowledge outline for the current node',
  ];
  const trimmed = req.userMessage?.trim() ?? '';
  const hasCustom = !!trimmed && !DEFAULT_PREFIXES.some((p) => trimmed.startsWith(p));

  const guideSection = hasCustom
    ? (req.language === 'en'
        ? `**Custom user requirements (highest priority):**\n${req.userMessage}\n\n**Reference format (follow unless it conflicts with the above):**\n${folderGuide}`
        : `**用户自定义要求（优先级最高，格式要求以此为准）：**\n${req.userMessage}\n\n**参考格式（在不违背用户要求的前提下参考）：**\n${folderGuide}`)
    : (req.language === 'en'
        ? `User request: ${req.userMessage}\n\n${folderGuide}`
        : `用户要求：${req.userMessage}\n\n${folderGuide}`);

  const videoText = videoResults.length > 0
    ? videoResults.map((v) => `- [${v.title}](${v.url}) — ${v.channelTitle}`).join('\n')
    : '';

  const isEn = req.language === 'en';
  const messages: ToolTurnMessage[] = [
    {
      role:    'user',
      content:
        (isEn
          ? `Node: ${node.name} (${node.chapter}, ${diffLabel(node.difficulty, req.language)})\n` +
            `Prerequisites completed: ${prereqNames || 'none'}\n` +
            `Request type: ${req.targetFolder}\n\n`
          : `节点：${node.name}（${node.chapter}，${diffLabel(node.difficulty, req.language)}难度）\n` +
            `前置已学：${prereqNames || '无'}\n` +
            `请求类型：${req.targetFolder}\n\n`) +
        (outlineText
          ? (isEn ? `[Knowledge Outline (with Bloom levels)]\n${outlineText}\n\n` : `[知识纲要（含布鲁姆认知层级）]\n${outlineText}\n\n`)
          : '') +
        (indexText
          ? (isEn ? `[Coverage Index]\n${indexText}\n\n` : `[已有资料覆盖情况]\n${indexText}\n\n`)
          : '') +
        `${guideSection}${motorSkillPracticeNote}\n\n` +
        `---\n\n` +
        (isEn ? `# Authoritative Reference Sources (Tier 1 first — facts must be grounded in these)\n\n` : `# 权威参考来源（Tier 1 优先，事实部分以此为准）\n\n`) +
        (sourceText || (isEn ? '(No authoritative sources found — generate from reliable knowledge and mark all content [AI Generated])' : '（未找到权威来源，请基于可靠知识生成，并全文标注 [AI 生成]）')) +
        (videoText
          ? (isEn ? `\n\n---\n\n# Tutorial Video References (from YouTube — link directly when writing reference sections)\n\n${videoText}` : `\n\n---\n\n# 教学视频参考（来自 YouTube，写入参考资料时可直接引用链接）\n\n${videoText}`)
          : ''),
    },
  ];

  // Static system prompt — fully cacheable by Anthropic server-side
  const systemPrompt = await buildSystemPrompt(roleLayer('subtutor'), languageLayer(req.language));

  // Accumulate token usage across all turns
  const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
  let fileSaved = false;

  // Token budget: tracks cumulative usage; triggers history compression at 85%/90%
  const budget = createBudget();

  // Tool execution context
  const ctx: ToolContext = {
    sessionId: req.sessionId,
    courseId:  req.courseId,
    nodeId:    req.nodeId,
    provider:  req.provider,
    model:     req.model,
    signal:    req.signal,
    language:  req.language,
    onProgress: (msg) => req.onProgressChunk(msg + '\n'),
    onFileGenerated: (payload) => {
      fileSaved = true;
      req.onFileGenerated({ ...payload, usage: { ...accUsage } });
    },
  };

  // Pre-build tool definitions once (same across all turns)
  const tools = buildToolDefs();

  log.info('循环开始', { nodeId: req.nodeId, provider: req.provider, model: req.model, folder: req.targetFolder });

  // Counts how many times we've injected a "please continue" message after max_tokens truncation
  let continuationCount = 0;

  // For practice requests: track whether the answer file has been saved yet
  let practiceAnswerSaved = false;

  // ── Loop ──────────────────────────────────────────────────────────────────
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (req.signal?.aborted) return fileSaved;

    // Pre-call compression: if the previous turn pushed budget over threshold,
    // compress NOW before sending another potentially large request to the API.
    if (budget.shouldCollapse() && messages.length > 4) {
      req.onProgressChunk(localMsg(req.language, '\n⚠️ 上下文接近极限，正在生成摘要…\n', '\n⚠️ Context near limit, generating summary…\n'));
      const [initialMsg, ...rest] = messages;
      const collapsed = await collapseContext(rest, {
        provider:   req.provider,
        model:      req.model,
        signal:     req.signal,
        onProgress: (m) => req.onProgressChunk(m),
      });
      messages.splice(0, messages.length, initialMsg, ...collapsed);
      budget.reset();
    } else if (budget.shouldCompress() && messages.length > 4) {
      req.onProgressChunk(localMsg(req.language, '\n⚠️ 上下文接近上限，正在压缩历史…\n', '\n⚠️ Context approaching limit, compressing history…\n'));
      const [initialMsg, ...rest] = messages;
      const compressed = compressToolHistory(rest);
      messages.splice(0, messages.length, initialMsg, ...compressed);
    }

    try {
      const response = await LLMAdapter.streamWithTools({
        provider:    req.provider,
        model:       req.model,
        systemPrompt,
        messages,
        tools,
        maxTokens:   8192,
        signal:      req.signal,
        onChunk:     () => {},  // file content stays in files; overview emitted explicitly after save_file
      });

      // Accumulate usage
      accUsage.inputTokens  += response.usage.inputTokens;
      accUsage.outputTokens += response.usage.outputTokens;
      accUsage.costCny      += response.usage.costCny;
      budget.add(response.usage.inputTokens, response.usage.outputTokens);

      // ── Compression: Context Collapse at 90% (LLM summary), then Microcompact at 85% ──
      if (budget.shouldCollapse() && messages.length > 4) {
        req.onProgressChunk(localMsg(req.language, '\n⚠️ 上下文接近极限，正在生成摘要…\n', '\n⚠️ Context near limit, generating summary…\n'));
        const [initialMsg, ...rest] = messages;
        const collapsed = await collapseContext(rest, {
          provider:   req.provider,
          model:      req.model,
          signal:     req.signal,
          onProgress: (m) => req.onProgressChunk(m),
        });
        messages.splice(0, messages.length, initialMsg, ...collapsed);
        budget.reset();
      } else if (budget.shouldCompress() && messages.length > 4) {
        req.onProgressChunk(localMsg(req.language, '\n⚠️ 上下文接近上限，正在压缩历史…\n', '\n⚠️ Context approaching limit, compressing history…\n'));
        const [initialMsg, ...rest] = messages;
        const compressed = compressToolHistory(rest);
        messages.splice(0, messages.length, initialMsg, ...compressed);
      }

      if (req.signal?.aborted) return fileSaved;

      // ── max_tokens: output was cut off — inject a continuation prompt ────
      if (response.stopReason === 'max_tokens') {
        if (continuationCount < 3) {
          continuationCount++;
          req.onProgressChunk(localMsg(req.language, `⏩ 输出已截断，正在续写（第 ${continuationCount}/3 次）…\n`, `⏩ Output truncated, continuing (attempt ${continuationCount}/3)…\n`));
          messages.push(response.assistantTurn);
          messages.push({ role: 'user', content: localMsg(req.language, '请继续，从刚才中断的地方接着写，不要重复已有内容。', 'Please continue from where you left off. Do not repeat content already written.') });
          continue;
        }
        req.onProgressChunk(localMsg(req.language, '⚠️ 已达最大续写次数，以当前内容结束。\n', '⚠️ Maximum continuation attempts reached, ending with current content.\n'));
        req.onComplete(accUsage);
        return fileSaved;
      }

      // ── end_turn: model finished, exit loop ──────────────────────────────
      if (response.stopReason === 'end_turn') {
        req.onComplete(accUsage);
        return fileSaved;
      }

      // ── tool_use: execute tools, feed results back, continue ─────────────
      if (response.stopReason === 'tool_use') {
        // Append assistant turn (text + tool call refs) to history
        messages.push(response.assistantTurn);

        // Helper: execute one tool call and return a provider-neutral result block
        const execCall = async (tc: ToolCallBlock): Promise<ToolResultBlock> => {
          req.onProgressChunk(localMsg(req.language, `\n🔧 执行工具：**${tc.name}**\n`, `\n🔧 Running tool: **${tc.name}**\n`));
          try {
            const tool = getTool(tc.name);
            let resultText: string;
            if (!tool) {
              resultText = localMsg(req.language,
                `错误：未知工具 ${tc.name}，可用工具：${getAllTools().map((t) => t.name).join('、')}。`,
                `Error: unknown tool ${tc.name}. Available tools: ${getAllTools().map((t) => t.name).join(', ')}.`);
            } else {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const out = await tool.execute(tc.input as any, ctx);
              resultText = truncateResult(tool.formatResult(out), tool.maxResultChars);
            }
            return { toolCallId: tc.id, content: resultText };
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            log.warn('工具执行失败', { tool: tc.name, error: errMsg, turn });
            req.onProgressChunk(localMsg(req.language, `⚠️ 工具执行失败：${errMsg}\n`, `⚠️ Tool execution failed: ${errMsg}\n`));
            return { toolCallId: tc.id, content: localMsg(req.language, `工具执行失败：${errMsg}。请检查参数后重试。`, `Tool failed: ${errMsg}. Check the parameters and retry.`), isError: true };
          }
        };

        // Read-only tools run concurrently; write tools run serially to prevent file conflicts
        const readOnlyCalls = response.toolCalls.filter((tc) =>  getTool(tc.name)?.isReadOnly);
        const writableCalls = response.toolCalls.filter((tc) => !getTool(tc.name)?.isReadOnly);

        const readResults  = await Promise.all(readOnlyCalls.map(execCall));
        const writeResults: ToolResultBlock[] = [];
        for (const tc of writableCalls) writeResults.push(await execCall(tc));

        // Restore original tool call order so the API receives results in the same order
        const resultById = new Map([...readResults, ...writeResults].map((r) => [r.toolCallId, r]));
        const toolResults: ToolResultBlock[] = response.toolCalls.map((tc) => resultById.get(tc.id)!);

        messages.push({ role: 'tool_results', results: toolResults });

        // If save_file was called this turn, process all saves and emit overviews.
        // For practice requests: loop continues until the answer file is also saved.
        const saveCalls = response.toolCalls.filter((tc) => tc.name === 'save_file');
        if (saveCalls.length > 0) {
          const FOLDER_LABEL_MAP: Record<string, string> = req.language === 'en'
            ? { theory: 'Theory', practice: 'Practice', answer: 'Answer', notes: 'Notes' }
            : { theory: '原理资料', practice: '实践资料', answer: '参考答案', notes: '个人笔记' };
          let practiceFilename = '';
          for (const saveCall of saveCalls) {
            const savedContent    = (saveCall.input as { content?: string }).content ?? '';
            const savedFilename   = (saveCall.input as { filename?: string }).filename ?? '';
            const savedFolderName = (saveCall.input as { folderName?: string }).folderName ?? '';
            // Auto-update _index.md (zero extra LLM calls)
            if (savedFilename && (savedFolderName === 'theory' || savedFolderName === 'practice' || savedFolderName === 'answer')) {
              appendToIndexMd(req.courseId, req.nodeId, savedFolderName, savedFilename, savedContent, req.language);
            }
            // Track answer file saved
            if (savedFolderName === 'answer') practiceAnswerSaved = true;
            // Remember practice filename so we can prompt AI for the answer file
            if (savedFolderName === 'practice' && savedFilename) practiceFilename = savedFilename;
            // Emit a short system overview instead of the full file content
            if (savedFilename) {
              const folderLabel = FOLDER_LABEL_MAP[savedFolderName] ?? savedFolderName;
              const headings = savedContent
                .split('\n')
                .filter((line) => /^#{1,3}\s/.test(line))
                .slice(0, 5)
                .map((line) => line.replace(/^#{1,3}\s+/, '').trim())
                .join('、');
              const overview = req.language === 'en'
                ? `✅ File saved to [${folderLabel}]: **${savedFilename}**\n` + (headings ? `Covers: ${headings}` : '')
                : `✅ 文件已保存至「${folderLabel}」：**${savedFilename}**\n` + (headings ? `涵盖：${headings}` : '');
              req.onChunk(overview + '\n');
            }
          }

          // Practice request: must also save answer file before exiting
          if (req.targetFolder === 'practice' && !practiceAnswerSaved) {
            const answerFilename = practiceFilename
              ? (req.language === 'en'
                  ? practiceFilename.replace(/practice/, 'answer')
                  : practiceFilename.replace(/练习题/, '参考答案'))
              : '';
            messages.push({
              role: 'user',
              content: req.language === 'en'
                ? `Exercise file saved. Now call save_file (folderName: "answer") to save the corresponding answer key.` +
                  (answerFilename ? ` Filename: ${answerFilename}` : '') +
                  `\nStart the file with: > ⚠️ AI-generated answer key — for reference only, please verify before use.` +
                  `\nFor each question Q1/Q2…: reasoning → full answer → common mistakes; coding questions include test cases; Tier 4 creative questions provide evaluation rubrics.`
                : `题目文件已保存。现在请调用 save_file（folderName: "answer"）保存对应的参考答案文件。` +
                  (answerFilename ? `文件名：${answerFilename}` : '') +
                  `\n文件顶部加声明：> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。` +
                  `\n按 Q1/Q2… 逐题给出：解题思路 → 完整答案 → 常见错误提示；编程题加测试用例；创造层题给评分维度。`,
            });
            req.onProgressChunk(localMsg(req.language, '📝 正在生成参考答案…\n', '📝 Generating answer key…\n'));
            continue;
          }

          req.onComplete(accUsage);
          return fileSaved;
        }

        continue;
      }

      // Unexpected stop reason — treat as done
      req.onComplete(accUsage);
      return fileSaved;

    } catch (err) {
      if (req.signal?.aborted) return fileSaved;

      const classified = classifyError(err);

      if (classified.type === 'context_too_long') {
        log.warn('上下文过长，主动压缩后重试', { turn, nodeId: req.nodeId });
        req.onProgressChunk(localMsg(req.language, '\n⚠️ 上下文过长，正在压缩历史…\n', '\n⚠️ Context too long, compressing history…\n'));
        const [init, ...rest] = messages;
        messages.splice(0, messages.length, init, ...compressToolHistory(rest));
        continue;
      }

      if (classified.type === 'rate_limit') {
        log.warn('请求频率超限，退避重试', { turn, nodeId: req.nodeId });
        req.onProgressChunk(localMsg(req.language, `⏳ 请求频率超限，稍后重试…\n`, `⏳ Rate limit reached, retrying shortly…\n`));
        await exponentialBackoff(turn);
        continue;
      }

      if (classified.type === 'abort') return fileSaved;

      // All other errors are non-retryable — onError closes the stream in the renderer.
      log.error('循环终止', { type: classified.type, error: classified.message, nodeId: req.nodeId });
      req.onError(classified.message);
      return fileSaved;
    }
  }

  log.warn('超出最大轮次', { maxTurns: MAX_TURNS, nodeId: req.nodeId });
  req.onError(localMsg(req.language, '处理轮次超限，请简化请求后重试', 'Maximum turns exceeded, please simplify your request'));
  return fileSaved;

  } finally {
    activeRuns.delete(lockKey);
  }
}
