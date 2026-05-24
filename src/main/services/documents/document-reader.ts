import type { SourceRecord } from '@shared/types';
import type { StoredDocumentBlock, StoredDocumentUnit } from './document-types';
import { getDocumentSummary, listDocumentBlocks, listDocumentUnits } from './document-store';
import { formatDocumentSummaryTreeForAgent, getDocumentSummaryTree } from './document-summary-tree';
import { formatSourceSemanticProfileForAgent } from '../source/source-semantic-format';
import { formatSourceLearningMetadataForAgent } from '../learning-search/learning-source-metadata';

export interface DocumentReadOptions {
  page?: number;
  pageStart?: number;
  pageEnd?: number;
  unitIndex?: number;
  maxBlocks?: number;
  maxUnits?: number;
}

export interface DocumentReadResult {
  hasDocument: boolean;
  summary: ReturnType<typeof getDocumentSummary>;
  units: StoredDocumentUnit[];
  blocks: StoredDocumentBlock[];
  rangeLabel: string;
}

const DEFAULT_BLOCK_LIMIT = 36;
const DEFAULT_UNIT_LIMIT = 40;
const MAX_BLOCK_LIMIT = 160;
const MAX_UNIT_LIMIT = 120;

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function sourceLine(source: SourceRecord): string {
  return [
    `参考资料：${source.title}`,
    `source_id：${source.id}`,
    source.remark ? `备注：${source.remark}` : null,
    `来源：${source.url ?? source.filePath ?? source.kind}`,
    formatSourceLearningMetadataForAgent(source.id),
    formatSourceSemanticProfileForAgent(source, { maxItems: 6 }),
  ].filter(Boolean).join('\n');
}

function unitLabel(unit: StoredDocumentUnit): string {
  const page = unit.pageNumber !== null && unit.pageNumber !== undefined ? `p.${unit.pageNumber}` : unit.locator;
  const state = unit.ocrState === 'pending' ? '待 OCR' : `${unit.charCount} 字符`;
  return `${page} · ${unit.kind} · ${state}${unit.title ? ` · ${unit.title}` : ''}`;
}

function blockLabel(block: StoredDocumentBlock, index: number): string {
  const page = block.pageNumber !== null && block.pageNumber !== undefined ? `p.${block.pageNumber}` : block.locator;
  const heading = block.headingPath?.length ? ` · ${block.headingPath.join(' > ')}` : '';
  return `[${index + 1}] ${page} · ${block.type}${heading}`;
}

function resolveReadRange(options: DocumentReadOptions): {
  pageNumber?: number;
  pageStart?: number;
  pageEnd?: number;
  rangeLabel: string;
} {
  if (options.page !== undefined) {
    const page = Math.max(1, Math.floor(options.page));
    return { pageNumber: page, rangeLabel: `page ${page}` };
  }
  if (options.pageStart !== undefined || options.pageEnd !== undefined) {
    const start = Math.max(1, Math.floor(options.pageStart ?? options.pageEnd ?? 1));
    const end = Math.max(start, Math.floor(options.pageEnd ?? start));
    return { pageStart: start, pageEnd: end, rangeLabel: `pages ${start}-${end}` };
  }
  return { rangeLabel: 'document opening blocks' };
}

export function readStructuredDocument(sourceId: string, options: DocumentReadOptions = {}): DocumentReadResult {
  const summary = getDocumentSummary(sourceId);
  const hasDocument = summary.unitCount > 0 || summary.blockCount > 0;
  if (!hasDocument) {
    return { hasDocument: false, summary, units: [], blocks: [], rangeLabel: 'no structured document' };
  }

  const maxUnits = clampPositiveInt(options.maxUnits, DEFAULT_UNIT_LIMIT, MAX_UNIT_LIMIT);
  const maxBlocks = clampPositiveInt(options.maxBlocks, DEFAULT_BLOCK_LIMIT, MAX_BLOCK_LIMIT);
  const allUnits = listDocumentUnits(sourceId);
  const selectedUnits = options.unitIndex !== undefined
    ? allUnits.filter((unit) => unit.unitIndex === options.unitIndex)
    : allUnits.slice(0, maxUnits);

  if (options.unitIndex !== undefined) {
    const unit = selectedUnits[0];
    return {
      hasDocument,
      summary,
      units: selectedUnits,
      blocks: unit ? listDocumentBlocks(sourceId, { unitId: unit.id, limit: maxBlocks }) : [],
      rangeLabel: unit ? unit.locator : `unit ${options.unitIndex}`,
    };
  }

  const range = resolveReadRange(options);
  const blocks = listDocumentBlocks(sourceId, {
    pageNumber: range.pageNumber,
    pageStart: range.pageStart,
    pageEnd: range.pageEnd,
    limit: maxBlocks,
  });

  return {
    hasDocument,
    summary,
    units: selectedUnits,
    blocks,
    rangeLabel: range.rangeLabel,
  };
}

export function structuredDocumentHint(sourceId: string): string | null {
  const summary = getDocumentSummary(sourceId);
  if (summary.unitCount === 0 && summary.blockCount === 0) return null;
  const tree = getDocumentSummaryTree(sourceId);
  return [
    `文档结构：${summary.unitCount} 个单元 · ${summary.blockCount} 个内容块 · ${summary.textUnitCount} 个单元含文本`,
    tree?.outline.length ? `摘要目录：${tree.outline.length} 条线索` : null,
    summary.pageAssetCount > 0 ? `页面图像：${summary.pageAssetCount} 页已生成低清预览` : null,
    summary.ocrPendingCount > 0 ? `待 OCR 单元：${summary.ocrPendingCount}` : null,
    '可用 read_source 指定 page / page_start / page_end 展开页级内容。',
  ].filter(Boolean).join('\n');
}

export function formatStructuredDocumentForAgent(source: SourceRecord, options: DocumentReadOptions = {}): string | null {
  const result = readStructuredDocument(source.id, options);
  if (!result.hasDocument) return null;

  const lines: string[] = [
    sourceLine(source),
    `文档结构：${result.summary.unitCount} 个单元 · ${result.summary.blockCount} 个内容块 · ${result.summary.textUnitCount} 个单元含文本`,
    result.summary.pageAssetCount > 0 ? `页面图像：${result.summary.pageAssetCount} 页已生成低清预览；文字不足时可提示用户稍等 OCR/页面视觉增强完成。` : '',
    result.summary.ocrPendingCount > 0 ? `待 OCR 单元：${result.summary.ocrPendingCount}` : '',
    `读取范围：${result.rangeLabel}`,
  ].filter(Boolean);

  const hasTargetedRange = options.page !== undefined
    || options.pageStart !== undefined
    || options.pageEnd !== undefined
    || options.unitIndex !== undefined;

  if (!hasTargetedRange && result.units.length > 0) {
    const summaryTree = formatDocumentSummaryTreeForAgent(source.id, {
      maxOutline: 24,
      maxConcepts: 12,
      maxPractice: 10,
      maxHints: 10,
    });
    if (summaryTree) {
      lines.push('\n[文档摘要树]');
      lines.push(summaryTree);
    }
    lines.push('\n[文档地图]');
    for (const unit of result.units) lines.push(`- ${unitLabel(unit)}`);
    if (result.summary.unitCount > result.units.length) {
      lines.push(`- ... 还有 ${result.summary.unitCount - result.units.length} 个单元，可指定 page 或 unit_index 继续读取。`);
    }
  }

  if (result.blocks.length === 0) {
    lines.push('\n当前范围没有可读文本块。若这是扫描 PDF，需要等待 OCR 阶段增强。');
    return lines.join('\n');
  }

  lines.push('\n[正文]');
  for (const [index, block] of result.blocks.entries()) {
    lines.push(`${blockLabel(block, index)}\n${block.text}`);
  }
  if (result.summary.blockCount > result.blocks.length && !hasTargetedRange) {
    lines.push('\n提示：这是开头部分。需要更精确内容时，用 search_library 先搜关键词，或 read_source 指定 page/page_start/page_end。');
  }

  return lines.join('\n\n');
}
