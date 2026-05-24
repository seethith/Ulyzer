import type { EvidenceChunk, EvidencePack, ResearchBudgetUsed, SourceRecord, TokenUsage } from '@shared/types';
import { formatDocumentSummaryTreeForAgent } from '../../documents/document-summary-tree';
import { listDocumentBlocks, listDocumentUnits, getDocumentSummary } from '../../documents/document-store';
import type { StoredDocumentBlock } from '../../documents/document-types';
import { hybridRetrieve } from '../../retrieval/hybrid-retriever';
import { getSourceChunks, listSources } from '../../source/source-library';
import { formatSourceSemanticProfileForAgent } from '../../source/source-semantic-format';
import { evaluateEvidenceCoverage, formatCoverageWarning } from '../../web/evidence-coverage';

const MAX_SOURCES = 12;
const MAX_EVIDENCE_CHUNKS = 42;
const MAX_BLOCK_SCAN = 2400;

const STRUCTURE_RE = /目录|目\s*录|contents|table of contents|第\s*[一二三四五六七八九十百\d]+\s*[章节编]|chapter\s+\d+|课程大纲|教学大纲|syllabus|curriculum|learning objectives|学习目标|前言|preface|概述|overview/i;
const CHAPTER_RE = /第\s*[一二三四五六七八九十百\d]+\s*[章节编]|chapter\s+\d+|part\s+\d+/i;
const PRACTICE_RE = /习题|练习|实验|项目|作业|案例|exercise|problem|lab|project|assignment|case study/i;

export interface LibraryRoadmapEvidenceInput {
  courseId: string;
  query: string;
  language?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

function chunkText(text: string, max = 1100): string {
  const normalized = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function blockPage(block: StoredDocumentBlock): number | undefined {
  return block.pageNumber ?? undefined;
}

function blockKey(block: StoredDocumentBlock): string {
  return `${block.sourceId}:${block.id}`;
}

function scoreBlock(block: StoredDocumentBlock): number {
  const text = block.text.slice(0, 600);
  if (STRUCTURE_RE.test(text)) return 0.98;
  if (CHAPTER_RE.test(text)) return 0.9;
  if (PRACTICE_RE.test(text)) return 0.78;
  return 0.58;
}

function addUnique(target: StoredDocumentBlock[], seen: Set<string>, blocks: StoredDocumentBlock[], max: number): void {
  for (const block of blocks) {
    if (target.length >= max) return;
    const key = blockKey(block);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(block);
  }
}

function selectRoadmapBlocks(blocks: StoredDocumentBlock[]): StoredDocumentBlock[] {
  const seen = new Set<string>();
  const selected: StoredDocumentBlock[] = [];
  const byPage = [...blocks].sort((a, b) =>
    (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER)
    || a.blockIndex - b.blockIndex);

  addUnique(selected, seen, byPage.filter((block) => STRUCTURE_RE.test(block.text.slice(0, 1200))), 10);
  addUnique(selected, seen, byPage.filter((block) => CHAPTER_RE.test(block.text.slice(0, 800))), 20);
  addUnique(selected, seen, byPage.slice(0, 12), 24);
  addUnique(selected, seen, byPage.filter((block) => PRACTICE_RE.test(block.text.slice(0, 1200))), 30);
  return selected;
}

function documentMap(source: SourceRecord): string {
  const summary = getDocumentSummary(source.id);
  const summaryTree = formatDocumentSummaryTreeForAgent(source.id, {
    maxOutline: 24,
    maxConcepts: 12,
    maxPractice: 10,
    maxHints: 10,
  });
  const units = listDocumentUnits(source.id)
    .slice(0, summaryTree ? 28 : 60)
    .map((unit) => {
      const page = unit.pageNumber ? `p.${unit.pageNumber}` : unit.locator;
      return `- ${page} · ${unit.kind}${unit.title ? ` · ${unit.title}` : ''} · ${unit.charCount} 字符`;
    });
  return [
    `资料：${source.title}`,
    `source_id：${source.id}`,
    source.remark ? `备注：${source.remark}` : '',
    `来源：${source.url ?? source.filePath ?? source.kind}`,
    formatSourceSemanticProfileForAgent(source, { maxItems: 8 }),
    `索引状态：${source.embeddingStatus ?? 'unknown'}；处理状态：${source.processingState ?? 'unknown'}`,
    `文档结构：${summary.unitCount} 个单元 · ${summary.blockCount} 个内容块 · ${summary.textUnitCount} 个单元含文本 · 页图 ${summary.pageAssetCount} 页`,
    summary.ocrPendingCount > 0 ? `待 OCR 单元：${summary.ocrPendingCount}` : '',
    summaryTree ? `文档摘要树：\n${summaryTree}` : '',
    units.length > 0 ? `文档地图（前 ${units.length} 个单元）：\n${units.join('\n')}` : '',
    '严格参考库提示：路线图章节和节点应优先从上述资料结构、目录、章节、小节与摘录中抽取；不要生成该资料未覆盖的外部章节。',
  ].filter(Boolean).join('\n');
}

function sourceVisibilityScore(source: SourceRecord): number {
  const lexicalPenalty = source.embeddingStatus === 'lexical_only' || source.embeddingStatus === 'skipped' ? -0.05 : 0;
  return source.trustScore + lexicalPenalty;
}

export async function collectLibraryRoadmapEvidence(input: LibraryRoadmapEvidenceInput): Promise<EvidencePack> {
  const allSources = listSources({ courseId: input.courseId, agentType: 'main_tutor' })
    .filter((source) => source.enabled);
  const warnings: string[] = [];
  const budgetUsed: ResearchBudgetUsed = {
    queries: 0,
    pagesFetched: 0,
    reflectionSearches: 0,
    llmReranks: 0,
  };

  if (allSources.length === 0) {
    const coverage = evaluateEvidenceCoverage('roadmap', []);
    return {
      query: input.query,
      taskType: 'roadmap',
      sources: [],
      chunks: [],
      coverage,
      budgetUsed,
      warnings: ['No enabled library sources are available for this roadmap request.'],
    };
  }

  const ranked = new Map<string, SourceRecord>();
  try {
    const retrieved = await hybridRetrieve({
      courseId: input.courseId,
      agentType: 'main_tutor',
      query: input.query,
      taskType: 'roadmap',
      limit: MAX_SOURCES,
      llmRerank: Boolean(input.provider && input.model),
      rerankProvider: input.provider,
      rerankModel: input.model,
      signal: input.signal,
      onUsage: input.onUsage,
    });
    retrieved.sources.forEach((source) => ranked.set(source.id, source));
  } catch {
    warnings.push('参考库相关性检索失败，已退回文档结构读取。');
  }
  [...allSources]
    .sort((a, b) => sourceVisibilityScore(b) - sourceVisibilityScore(a))
    .forEach((source) => {
      if (ranked.size < MAX_SOURCES) ranked.set(source.id, source);
    });

  const sources = [...ranked.values()].slice(0, MAX_SOURCES);
  const chunks: EvidenceChunk[] = [];
  const seenPages = new Set<string>();
  const selectedBlocksBySource: Array<{ source: SourceRecord; blocks: StoredDocumentBlock[] }> = [];

  for (const source of sources) {
    if (source.processingState === 'failed' || source.processingState === 'limited') {
      warnings.push(`参考资料「${source.title}」处理状态为 ${source.processingState}，严格参考库模式下可用内容可能不足。`);
    }
    const overview = documentMap(source);
    chunks.push({
      chunkId: `${source.id}:document-map`,
      sourceId: source.id,
      text: overview,
      locator: 'document map',
      score: 0.95,
      sourceKind: source.kind,
      slot: 'curriculum',
      retrievalMethod: 'lexical',
    });

    const blocks = listDocumentBlocks(source.id, { limit: MAX_BLOCK_SCAN });
    const selected = selectRoadmapBlocks(blocks);
    selectedBlocksBySource.push({ source, blocks: selected });
    if (blocks.length > 0 && selected.length === 0) {
      warnings.push(`参考资料「${source.title}」未识别到目录/章节线索，已读取文档开头。`);
    }
    if ((source.embeddingStatus === 'lexical_only' || source.embeddingStatus === 'skipped') && blocks.length > 0) {
      warnings.push(`参考资料「${source.title}」当前为 ${source.embeddingStatus}，已使用页级结构读取弥补语义检索不足。`);
    }
    if (blocks.length === 0) {
      const fallbackChunks = getSourceChunks(source.id, 3);
      chunks.push(...fallbackChunks.map((chunk) => ({
        ...chunk,
        slot: chunk.slot ?? 'curriculum',
      })));
    }
  }

  const maxRounds = Math.max(0, ...selectedBlocksBySource.map((entry) => entry.blocks.length));
  for (let round = 0; round < maxRounds && chunks.length < MAX_EVIDENCE_CHUNKS; round++) {
    for (const entry of selectedBlocksBySource) {
      if (chunks.length >= MAX_EVIDENCE_CHUNKS) break;
      const block = entry.blocks[round];
      if (!block) continue;
      const page = blockPage(block);
      if (page) seenPages.add(`${entry.source.id}:${page}`);
      const text = chunkText(block.text);
      chunks.push({
        chunkId: block.id,
        sourceId: entry.source.id,
        text,
        locator: block.locator,
        score: scoreBlock(block),
        sourceKind: entry.source.kind,
        page,
        slot: STRUCTURE_RE.test(text) || CHAPTER_RE.test(text) ? 'curriculum' : PRACTICE_RE.test(text) ? 'practice_or_project' : undefined,
        retrievalMethod: 'lexical',
      });
    }
  }

  budgetUsed.pagesFetched = seenPages.size;
  const selectedChunks = chunks.slice(0, MAX_EVIDENCE_CHUNKS);
  const coverage = evaluateEvidenceCoverage('roadmap', selectedChunks);
  const coverageWarning = formatCoverageWarning(coverage, input.language);

  return {
    query: input.query,
    taskType: 'roadmap',
    sources,
    chunks: selectedChunks,
    coverage,
    budgetUsed,
    warnings: coverageWarning ? [...warnings, coverageWarning] : warnings,
  };
}
