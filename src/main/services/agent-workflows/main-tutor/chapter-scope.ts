import * as path from 'path';
import type { DagNode, TokenUsage } from '@shared/types';
import type { LLMUsageContext } from '../../llm/adapter';
import { streamStructuredCompletion } from '../../llm/structured-stream';
import { resolveModelCapability } from '../../llm/model-capabilities';
import { getCourseDir, writeFileContent } from '../../fs/content.service';
import { createLogger } from '../../../utils/logger';
import { CHAPTER_SCOPE_SYSTEM_PROMPT } from './prompts';
import type { ChapterScopeEntry } from './types';

const log = createLogger('MainTutor');
const SCOPE_BASE_OUTPUT_TOKENS = 2_000;
const SCOPE_TOKENS_PER_MAIN_NODE = 800;
const SCOPE_MAX_OUTPUT_TOKENS = 8_000;

export interface ChapterScopeProgress {
  onStart?: (chapterCount: number) => void;
  onChapterStart?: (chapter: string, index: number, total: number) => void;
  onChapterComplete?: (chapter: string, index: number, total: number) => void;
  onChapterFailed?: (chapter: string, error: unknown) => void;
  onComplete?: (completed: number, total: number) => void;
  onFailed?: (error: unknown) => void;
  onUsage?: (usage: TokenUsage) => void;
  usageContext?: (source: string) => LLMUsageContext;
}

export class ChapterScopeGenerator {
  async generate(
    courseId: string,
    nodes: DagNode[],
    provider: string,
    model: string,
    signal?: AbortSignal,
    progress?: ChapterScopeProgress,
  ): Promise<void> {
    try {
      const chapterMap = new Map<string, DagNode[]>();
      for (const n of nodes) {
        if (!chapterMap.has(n.chapter)) chapterMap.set(n.chapter, []);
        chapterMap.get(n.chapter)!.push(n);
      }

      const chapters = [...chapterMap.entries()];
      progress?.onStart?.(chapters.length);

      const scope: Record<string, ChapterScopeEntry> = {};
      let completed = 0;
      const scopePath = path.join(getCourseDir(courseId), '_chapter_scope.json');

      for (let i = 0; i < chapters.length; i++) {
        const [chapter, cNodes] = chapters[i];
        if (signal?.aborted) break;

        progress?.onChapterStart?.(chapter, i + 1, chapters.length);
        try {
          const entry = await this.generateChapterScope(chapter, cNodes, provider, model, signal, progress?.onUsage, progress?.usageContext);
          writeFileContent(scopePath, JSON.stringify({ ...scope, [chapter]: entry }, null, 2));
          scope[chapter] = entry;
          completed += 1;
          progress?.onChapterComplete?.(chapter, i + 1, chapters.length);
        } catch (err) {
          log.warn('generateChapterScope: 单章知识点分配失败（非致命）', { chapter, error: String(err) });
          progress?.onChapterFailed?.(chapter, err);
        }
      }

      progress?.onComplete?.(completed, chapters.length);
    } catch (err) {
      log.warn('generateChapterScope 失败（非致命）', { error: String(err) });
      progress?.onFailed?.(err);
    }
  }

  private async generateChapterScope(
    chapter: string,
    nodes: DagNode[],
    provider: string,
    model: string,
    signal?: AbortSignal,
    onUsage?: (usage: TokenUsage) => void,
    usageContext?: (source: string) => LLMUsageContext,
  ): Promise<ChapterScopeEntry> {
    const mainNodes = nodes.filter((n) => n.node_type !== 'boss');
    const bossNodes = nodes.filter((n) => n.node_type === 'boss');
    const nodeList = formatChapterNodeList(chapter, mainNodes, bossNodes);
    const userMsg =
      `请只为以下单个章节分配知识点清单，并返回以章节名为唯一 key 的 JSON 对象：\n\n${nodeList}`;

    const raw = (await streamStructuredCompletion({
      provider, model,
      messages: [{ role: 'user', content: userMsg }],
      systemPrompt: CHAPTER_SCOPE_SYSTEM_PROMPT,
      maxTokens: resolveScopeOutputBudget(provider, model, mainNodes.length),
      jsonMode: true,
      kind: 'json',
      usageContext: usageContext?.('chapter_scope'),
      signal,
      onUsage,
    })).text;

    try {
      return parseChapterScope(raw, chapter);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('generateChapterScope: 单章知识点分配 JSON 解析失败，尝试修复', {
        chapter,
        error: String(err),
      });
    }

    try {
      const repaired = await repairChapterScopeJson({
        provider,
        model,
        chapter,
        nodeList,
        raw,
        mainNodeCount: mainNodes.length,
        signal,
        onUsage,
        usageContext,
      });
      return parseChapterScope(repaired, chapter);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('generateChapterScope: 单章知识点分配 JSON 修复失败，使用确定性兜底', {
        chapter,
        error: String(err),
      });
      return buildFallbackChapterScope(chapter, mainNodes, bossNodes);
    }
  }
}

function resolveScopeOutputBudget(provider: string, model: string, mainNodeCount: number): number {
  const target = Math.min(
    SCOPE_MAX_OUTPUT_TOKENS,
    SCOPE_BASE_OUTPUT_TOKENS + Math.max(1, mainNodeCount) * SCOPE_TOKENS_PER_MAIN_NODE,
  );
  const capability = resolveModelCapability(provider, model);
  return Math.max(1024, Math.min(target, capability.maxOutputTokens));
}

function formatChapterNodeList(chapter: string, mainNodes: DagNode[], bossNodes: DagNode[]): string {
  const mainList = mainNodes
    .map((node) => `${node.name}${node.description ? `：${node.description}` : ''}`)
    .join('\n  - ');
  const bossList = bossNodes.map((node) => node.name).join('、') || '无';
  return `章节：${chapter}\n  主节点：${mainList ? `\n  - ${mainList}` : '无'}\n  Boss节点：${bossList}`;
}

function parseChapterScope(raw: string, chapter: string): ChapterScopeEntry {
  const parsed = extractJson(raw) as Record<string, ChapterScopeEntry>;
  const entry = parsed[chapter] ?? Object.values(parsed)[0];
  if (!entry || !Array.isArray(entry.nodes) || !entry.scope_distribution || typeof entry.scope_distribution !== 'object') {
    throw new Error('章节知识点分配 JSON 结构无效');
  }
  return {
    nodes: entry.nodes.filter((node): node is string => typeof node === 'string' && node.trim().length > 0),
    scope_distribution: normalizeScopeDistribution(entry.scope_distribution),
    boundary_notes: typeof entry.boundary_notes === 'string' ? entry.boundary_notes : undefined,
  };
}

function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) text = fence[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('LLM 未返回有效 JSON');
  }
}

function normalizeScopeDistribution(value: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [nodeName, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    const points = items
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
      .slice(0, 8);
    if (points.length > 0) out[nodeName] = points;
  }
  return out;
}

async function repairChapterScopeJson(input: {
  provider: string;
  model: string;
  chapter: string;
  nodeList: string;
  raw: string;
  mainNodeCount: number;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
  usageContext?: (source: string) => LLMUsageContext;
}): Promise<string> {
  const repaired = (await streamStructuredCompletion({
    provider: input.provider,
    model: input.model,
    systemPrompt:
      '你是 JSON 修复器。只修复或补全单章知识点范围 JSON。输出必须是合法 JSON 对象，不要 Markdown、代码块或解释。对象必须以章节名为唯一 key，包含 nodes、scope_distribution、boundary_notes。每个非 boss 主节点分配 3-6 个具体知识点。',
    messages: [{
      role: 'user',
      content: [
        '章节与节点：',
        input.nodeList,
        '原始输出（可能为空、截断或不是 JSON）：',
        input.raw || '（空）',
      ].join('\n\n'),
    }],
    maxTokens: resolveScopeOutputBudget(input.provider, input.model, input.mainNodeCount),
    jsonMode: true,
    kind: 'json',
    usageContext: input.usageContext?.('chapter_scope_repair'),
    signal: input.signal,
    onUsage: input.onUsage,
  })).text;
  return repaired;
}

function buildFallbackChapterScope(chapter: string, mainNodes: DagNode[], bossNodes: DagNode[]): ChapterScopeEntry {
  const scope_distribution: Record<string, string[]> = {};
  for (const node of mainNodes) {
    scope_distribution[node.name] = fallbackScopePoints(node);
  }
  return {
    nodes: mainNodes.map((node) => node.name),
    scope_distribution,
    boundary_notes: bossNodes.length > 0
      ? `Boss 节点综合检验本章主节点：${mainNodes.map((node) => node.name).join('、') || '无'}。`
      : `本章范围聚焦：${mainNodes.map((node) => node.name).join('、') || chapter}。`,
  };
}

function fallbackScopePoints(node: DagNode): string[] {
  const name = node.name.trim();
  const fromDescription = splitDescriptionTopics(node.description ?? '')
    .filter((topic) => !name.includes(topic))
    .slice(0, 2);
  return [
    `理解${name}的核心概念`,
    `掌握${name}的基本方法`,
    ...fromDescription.map((topic) => `梳理${topic}`),
    `完成${name}的基础练习`,
    `区分${name}的常见误区`,
  ].slice(0, 6);
}

function splitDescriptionTopics(description: string): string[] {
  return description
    .split(/[，。；;、,.]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 18);
}
