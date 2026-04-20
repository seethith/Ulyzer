/**
 * Outline version management.
 *
 * Responsibilities:
 *   - Detect current outline version for a node (0 = none, 1-3 = v1-v3)
 *   - Read KC coverage status by parsing _index.md files from theory + practice folders
 *   - Generate the next outline version (v1→v2, v2→v3) using the previous version as context
 *
 * Max outline version is 3. After v3 the user should use the Topic (专题) feature
 * to deep-dive into individual KCs rather than continuing to expand the outline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LLMAdapter } from '../llm/adapter';
import type { LLMProvider, KcCoverageStatus, TokenUsage } from '@shared/types';
import {
  getOutlineDirPath,
  getLatestOutlinePath,
  getFolderPath,
  writeFileContent,
} from '../fs/content.service';

export const MAX_OUTLINE_VERSION = 3;

// ── Version detection ─────────────────────────────────────────────────────────

/** Returns the highest outline version number that exists (0 if none). */
export function getOutlineVersionNumber(courseId: string, nodeId: string): number {
  const dir = getOutlineDirPath(courseId, nodeId);
  for (const v of [3, 2, 1]) {
    if (fs.existsSync(path.join(dir, `_outline_v${v}.md`))) return v;
  }
  return 0;
}

// ── KC parsing helpers ────────────────────────────────────────────────────────

function parseKcIds(text: string): string[] {
  const ids: string[] = [];
  const re = /^### (KC\d+):/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Read all KC IDs that appear in "覆盖KC：..." lines across both theory/ and
 * practice/ _index.md files for the node.
 */
function readAllCoveredKcIds(courseId: string, nodeId: string): Set<string> {
  const covered = new Set<string>();
  for (const folder of ['theory', 'practice']) {
    try {
      const indexPath = path.join(getFolderPath(courseId, nodeId, folder), '_index.md');
      if (!fs.existsSync(indexPath)) continue;
      const text = fs.readFileSync(indexPath, 'utf-8');
      for (const m of text.matchAll(/^(?:覆盖KC|KCs covered)：?:?\s*(.+)$/mg)) {
        for (const part of m[1].split(',')) {
          const idMatch = part.trim().match(/^(KC\d+)/);
          if (idMatch) covered.add(idMatch[1]);
        }
      }
    } catch { /* non-fatal */ }
  }
  return covered;
}

// ── Coverage check ────────────────────────────────────────────────────────────

/**
 * Check KC coverage for a node against its latest outline.
 * Returns `isFullyCovered: false` for legacy outlines (no KC markers) since
 * KC-level coverage tracking is not available for them.
 */
export function checkKcCoverage(courseId: string, nodeId: string): KcCoverageStatus {
  const version = getOutlineVersionNumber(courseId, nodeId);
  if (version === 0) {
    return { version: 0, allKcIds: [], coveredKcIds: [], uncoveredKcIds: [], isFullyCovered: false };
  }

  const outlinePath = getLatestOutlinePath(courseId, nodeId);
  const outlineText = outlinePath
    ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8'); } catch { return ''; } })()
    : '';

  const allKcIds = parseKcIds(outlineText);
  if (allKcIds.length === 0) {
    // Legacy outline format — KC coverage tracking not available
    return { version, allKcIds: [], coveredKcIds: [], uncoveredKcIds: [], isFullyCovered: false };
  }

  const coveredSet = readAllCoveredKcIds(courseId, nodeId);
  const coveredKcIds   = allKcIds.filter((id) => coveredSet.has(id));
  const uncoveredKcIds = allKcIds.filter((id) => !coveredSet.has(id));

  return {
    version,
    allKcIds,
    coveredKcIds,
    uncoveredKcIds,
    isFullyCovered: uncoveredKcIds.length === 0 && allKcIds.length > 0,
  };
}

// ── Next-version generation ───────────────────────────────────────────────────

export interface OutlineGenerateNextOptions {
  courseId: string;
  nodeId: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  language?: string;
  onProgressChunk: (msg: string) => void;
  onComplete?: (usage: TokenUsage) => void;
}

const DEPTH_DESC_ZH: Record<number, string> = {
  2: '研究生教材水平：机制分析 + 反例 + 更细粒度的误解，每个 v1 KC 展开为 2-3 个更具体的子 KC',
  3: '综述论文水平：深层推导 + 对比 + 性能边界，每个 v2 KC 进一步展开，补充高阶条件性 KC',
};
const DEPTH_DESC_EN: Record<number, string> = {
  2: 'Graduate-textbook level: mechanism analysis + counterexamples + finer-grained misconceptions; each v1 KC expands into 2–3 more specific sub-KCs',
  3: 'Survey-paper level: deep derivation + comparisons + performance boundaries; each v2 KC expands further with advanced conditional KCs',
};

const KC_COUNT_RANGE: Record<number, string> = {
  2: '10-18',
  3: '18-30',
};

/**
 * Generate the next outline version (v1→v2 or v2→v3) from the current latest outline.
 * Writes the new file to `纲要/_outline_v{n}.md` and returns the new version number.
 * Throws if already at MAX_OUTLINE_VERSION or if no base outline exists.
 */
export async function generateNextOutlineVersion(
  opts: OutlineGenerateNextOptions,
  node: import('@shared/types').DagNode,
): Promise<number> {
  const currentVersion = getOutlineVersionNumber(opts.courseId, opts.nodeId);
  if (currentVersion >= MAX_OUTLINE_VERSION) {
    throw new Error(
      `已达最高版本 v${MAX_OUTLINE_VERSION}，请使用「生成专题」功能深入某个 KC。`
    );
  }

  const nextVersion = currentVersion + 1;

  // Must have a base outline to expand from
  const basePath = getLatestOutlinePath(opts.courseId, opts.nodeId);
  const baseText  = basePath
    ? (() => { try { return fs.readFileSync(basePath, 'utf-8').trim(); } catch { return ''; } })()
    : '';

  if (!baseText) {
    throw new Error('找不到基础纲要，请先生成 v1 纲要。');
  }

  const isEn = opts.language === 'en';
  const depthDescMap = isEn ? DEPTH_DESC_EN : DEPTH_DESC_ZH;

  opts.onProgressChunk(isEn
    ? `📝 Generating outline v${nextVersion} (${depthDescMap[nextVersion] ?? 'deeper expansion'})…\n`
    : `📝 正在生成纲要 v${nextVersion}（${depthDescMap[nextVersion] ?? '深度展开'}）…\n`);

  const systemPrompt = isEn
    ? `You are a knowledge-structure architect. Generate KC Knowledge Outline v${nextVersion} for the learning node "${node.name}".\n\n` +
      `**Task:** Expand each KC from the previous version into 2–3 more granular sub-KCs at the same depth level.\n` +
      `**Depth:** ${depthDescMap[nextVersion] ?? ''}\n\n` +
      `**Rules:**\n` +
      `- Re-number all KCs from KC1 (independent of previous version numbering)\n` +
      `- KC type (Declarative/Procedural/Conditional) may follow the parent KC but can be more specific\n` +
      `- Mastery indicators must be more specific and demanding than the previous version\n` +
      `- Misconceptions and edge conditions must cover deeper issues not addressed in the previous version\n` +
      `- Do not repeat wording from the previous version\n\n` +
      `**Previous outline (v${currentVersion}):**\n\n${baseText}\n\n` +
      `**Strict output format (no explanations):**\n\n` +
      `# Knowledge Outline — ${node.name} (v${nextVersion})\n\n` +
      `## Knowledge Units (KCs)\n\n` +
      `### KC1: [Name]\n- Type: [Declarative/Procedural/Conditional]\n- Bloom Level: [level]\n- Prerequisite KCs: [None/KC{n}]\n- Mastery Indicator: [specific observable behaviour]\n\n` +
      `...\n\n## Common Misconceptions\n1. Misconception: ...  Reality: ...\n\n## Edge Conditions\n- ...\n\n` +
      `Number of KCs: ${KC_COUNT_RANGE[nextVersion] ?? '8-20'}; ` +
      `Bloom levels must be one of: [Remember/Understand] [Analyse/Evaluate] [Apply] [Create]; ` +
      `Prerequisite KCs may only reference IDs defined in this outline (use "None" if none); at least 3 misconceptions; at least 2 edge conditions.`
    : `你是知识结构规划师，为学习节点「${node.name}」生成 KC 知识纲要 v${nextVersion}。\n\n` +
      `**任务：** 对上一版本每个 KC 展开 2-3 个更细粒度的子 KC，形成同一深度层级的完整知识结构。\n` +
      `**深度：** ${depthDescMap[nextVersion] ?? ''}\n\n` +
      `**规则：**\n` +
      `- 新版本 KC 从 KC1 重新顺序编号（与上一版本编号无关）\n` +
      `- KC 类型（陈述性/程序性/条件性）参考父 KC 但可细化方向\n` +
      `- 掌握指标必须比上一版本更具体、更高要求\n` +
      `- 误解和边界条件应覆盖上一版本未涉及的更深层问题\n` +
      `- 不重复上一版本的表述\n\n` +
      `**上一版本纲要（v${currentVersion}）：**\n\n${baseText}\n\n` +
      `**严格输出格式（不输出任何解释）：**\n\n` +
      `# 知识纲要 — ${node.name}（v${nextVersion}）\n\n` +
      `## 知识单元（KCs）\n\n` +
      `### KC1: [名称]\n- 类型：[陈述性/程序性/条件性]\n- 布鲁姆层级：[层级]\n- 前置KC：[无/KC{n}]\n- 掌握指标：[具体可观察行为]\n\n` +
      `...\n\n## 常见误解（Misconceptions）\n1. 误解：...  实际：...\n\n## 边界条件\n- ...\n\n` +
      `KC 数量：${KC_COUNT_RANGE[nextVersion] ?? '8-20'} 个；` +
      `布鲁姆层级只能用：[记忆/理解] [分析/评估] [应用] [创造]；` +
      `前置KC 只能引用本纲要已定义的编号（无前置写"无"）；常见误解至少 3 条；边界条件至少 2 条。`;

  const maxTokens = nextVersion === 2 ? 1800 : 2500;

  let content = '';
  let streamError = '';

  await LLMAdapter.stream({
    provider:    opts.provider,
    model:       opts.model,
    messages:    [{ role: 'user', content: isEn
      ? `Please generate Knowledge Outline v${nextVersion} for "${node.name}".`
      : `请为「${node.name}」生成知识纲要 v${nextVersion}。` }],
    systemPrompt,
    maxTokens,
    temperature: 0.2,
    signal:      opts.signal,
    onChunk:     (c)     => { content += c; },
    onComplete:  (usage) => { opts.onComplete?.(usage); },
    onError:     (err)   => { streamError = err.message; },
  });

  if (streamError || !content.trim()) {
    throw new Error(streamError || (isEn ? `Outline v${nextVersion} generation failed: empty response.` : `纲要 v${nextVersion} 生成失败，内容为空。`));
  }

  const writePath = path.join(getOutlineDirPath(opts.courseId, opts.nodeId), `_outline_v${nextVersion}.md`);
  writeFileContent(writePath, content);
  opts.onProgressChunk(isEn ? `✅ Outline v${nextVersion} generated.\n` : `✅ 纲要 v${nextVersion} 已生成。\n`);

  return nextVersion;
}
