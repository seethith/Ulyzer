import { createHash } from 'crypto';
import { getDb } from '../db/sqlite';
import { getDocumentSummary, listDocumentUnits } from './document-store';
import type { StoredDocumentBlock, StoredDocumentUnit } from './document-types';

export interface DocumentSummaryItem {
  label: string;
  locator?: string;
  page?: number;
  detail?: string;
}

export interface DocumentSummaryTree {
  sourceId: string;
  courseId: string;
  contentHash: string;
  overview: string;
  outline: DocumentSummaryItem[];
  keyConcepts: DocumentSummaryItem[];
  practiceIndex: DocumentSummaryItem[];
  routeHints: DocumentSummaryItem[];
  updatedAt?: string;
}

interface SourceRow {
  id: string;
  course_id: string;
  title: string;
  remark: string | null;
}

interface SummaryRow {
  source_id: string;
  course_id: string;
  content_hash: string | null;
  overview: string | null;
  outline_json: string | null;
  key_concepts_json: string | null;
  practice_index_json: string | null;
  route_hints_json: string | null;
  summary_json: string | null;
  updated_at: string | null;
}

interface SummaryBlockRow {
  id: string;
  unit_id: string;
  source_id: string;
  course_id: string;
  node_id: string | null;
  block_index: number;
  block_type: string;
  locator: string;
  heading_path: string | null;
  page_number: number | null;
  text: string;
  metadata_json: string | null;
  char_start: number | null;
  char_end: number | null;
  created_at: string;
}

const SUMMARY_TREE_VERSION = 'v2_full_structure_budget';
const MAX_CANDIDATE_BLOCKS = 2400;
const MAX_SAMPLED_PAGES = 36;
const MAX_OUTLINE = 90;
const MAX_CONCEPTS = 80;
const MAX_PRACTICE = 60;
const MAX_ROUTE_HINTS = 50;

const STRUCTURE_RE = /目录|目\s*录|contents|table of contents|课程大纲|教学大纲|syllabus|curriculum|learning objectives|学习目标|前言|preface|概述|overview/i;
const CHAPTER_RE = /第\s*[一二三四五六七八九十百\d]+\s*[章节编讲单元]|chapter\s+\d+|part\s+\d+|module\s+\d+|unit\s+\d+/i;
const PRACTICE_RE = /习题|练习|实验|项目|作业|案例|实践|exercise|problem|lab|project|assignment|case study/i;
const OBJECTIVE_RE = /目标|要求|掌握|理解|了解|能够|能力|learning objective|outcome|competenc/i;

function parseJsonArray(value?: string | null): DocumentSummaryItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === 'object' && item !== null ? item as Record<string, unknown> : null))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        label: typeof item.label === 'string' ? item.label : '',
        locator: typeof item.locator === 'string' ? item.locator : undefined,
        page: typeof item.page === 'number' ? item.page : undefined,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
      }))
      .filter((item) => item.label.trim());
  } catch {
    return [];
  }
}

function rowToTree(row: SummaryRow): DocumentSummaryTree {
  return {
    sourceId: row.source_id,
    courseId: row.course_id,
    contentHash: row.content_hash ?? '',
    overview: row.overview ?? '',
    outline: parseJsonArray(row.outline_json),
    keyConcepts: parseJsonArray(row.key_concepts_json),
    practiceIndex: parseJsonArray(row.practice_index_json),
    routeHints: parseJsonArray(row.route_hints_json),
    updatedAt: row.updated_at ?? undefined,
  };
}

function sourceRow(sourceId: string): SourceRow | null {
  return getDb()
    .prepare<[string], SourceRow>('SELECT id, course_id, title, remark FROM source_records WHERE id = ?')
    .get(sourceId) ?? null;
}

function parseJsonRecord(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value?: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function toStoredBlock(row: SummaryBlockRow): StoredDocumentBlock {
  return {
    id: row.id,
    unitId: row.unit_id,
    sourceId: row.source_id,
    courseId: row.course_id,
    nodeId: row.node_id,
    blockIndex: row.block_index,
    type: row.block_type as StoredDocumentBlock['type'],
    locator: row.locator,
    headingPath: parseStringArray(row.heading_path),
    pageNumber: row.page_number,
    text: row.text,
    metadata: parseJsonRecord(row.metadata_json),
    charStart: row.char_start,
    charEnd: row.char_end,
    createdAt: row.created_at,
  };
}

function contentHash(units: StoredDocumentUnit[], blocks: StoredDocumentBlock[]): string {
  const hash = createHash('sha256');
  hash.update(SUMMARY_TREE_VERSION);
  hash.update('|');
  hash.update(String(units.length));
  hash.update('|');
  hash.update(String(blocks.length));
  hash.update('|');
  for (const unit of units) {
    hash.update(`${unit.unitIndex}:${unit.pageNumber ?? ''}:${unit.charCount}:${unit.ocrState};`);
  }
  return `${SUMMARY_TREE_VERSION}:${hash.digest('hex')}`;
}

function cleanLabel(text: string, max = 120): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[·•]+/g, ' ')
    .trim()
    .slice(0, max);
}

function blockItem(block: StoredDocumentBlock, label?: string): DocumentSummaryItem | null {
  const clean = cleanLabel(label ?? block.text);
  if (!clean) return null;
  return {
    label: clean,
    locator: block.locator,
    page: block.pageNumber ?? undefined,
    detail: block.headingPath?.length ? block.headingPath.join(' > ') : undefined,
  };
}

function unitItem(unit: StoredDocumentUnit): DocumentSummaryItem | null {
  const label = cleanLabel(unit.title || unit.text.split('\n').find((line) => line.trim()) || unit.locator);
  if (!label) return null;
  return {
    label,
    locator: unit.locator,
    page: unit.pageNumber ?? undefined,
    detail: `${unit.kind} · ${unit.charCount} 字符`,
  };
}

function pushUnique(target: DocumentSummaryItem[], seen: Set<string>, item: DocumentSummaryItem | null, max: number): void {
  if (!item || target.length >= max) return;
  const key = `${item.label}|${item.page ?? ''}|${item.locator ?? ''}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(item);
}

function balancedSample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const headCount = Math.min(Math.floor(max * 0.28), 28);
  const tailCount = Math.min(Math.floor(max * 0.20), 20);
  const middleCount = Math.max(0, max - headCount - tailCount);
  const selected: T[] = [];
  const seen = new Set<number>();
  const add = (index: number) => {
    if (index < 0 || index >= items.length || seen.has(index)) return;
    seen.add(index);
    selected.push(items[index]);
  };
  for (let i = 0; i < headCount; i++) add(i);
  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, items.length - tailCount);
  for (let i = 0; i < middleCount; i++) {
    const index = Math.floor(middleStart + ((middleEnd - middleStart) * (i + 0.5)) / middleCount);
    add(index);
  }
  for (let i = items.length - tailCount; i < items.length; i++) add(i);
  return selected
    .map((item) => ({ item, index: items.indexOf(item) }))
    .sort((a, b) => a.index - b.index)
    .map(({ item }) => item);
}

function unitLooksStructural(unit: StoredDocumentUnit): boolean {
  const sample = `${unit.title ?? ''}\n${unit.text.slice(0, 320)}`;
  return Boolean(unit.title)
    || CHAPTER_RE.test(sample)
    || STRUCTURE_RE.test(sample)
    || OBJECTIVE_RE.test(sample);
}

function sampledPages(units: StoredDocumentUnit[]): number[] {
  const pages = [...new Set(units
    .map((unit) => unit.pageNumber)
    .filter((page): page is number => typeof page === 'number' && Number.isFinite(page)))]
    .sort((a, b) => a - b);
  return balancedSample(pages, MAX_SAMPLED_PAGES);
}

function sqlLikeClauses(column: string, values: string[]): { clause: string; params: string[] } {
  return {
    clause: values.map(() => `${column} LIKE ?`).join(' OR '),
    params: values.map((value) => `%${value}%`),
  };
}

function listSummaryCandidateBlocks(sourceId: string, units: StoredDocumentUnit[]): StoredDocumentBlock[] {
  const terms = [
    '目录', '目 录', 'contents', 'table of contents', '课程大纲', '教学大纲',
    '学习目标', 'learning objectives', '章', '节', '讲', '单元', 'chapter', 'part', 'module', 'unit',
    '习题', '练习', '实验', '项目', '作业', '案例', 'exercise', 'problem', 'lab', 'project',
    '目标', '要求', '掌握', '理解', '了解', '能够', 'outcome',
  ];
  const like = sqlLikeClauses('text', terms);
  const structuralRows = getDb()
    .prepare(
      `SELECT *
       FROM source_document_blocks
       WHERE source_id = ?
         AND (
           block_type IN ('title', 'heading', 'table')
           OR ${like.clause}
         )
       ORDER BY CASE WHEN page_number IS NULL THEN 999999 ELSE page_number END ASC, block_index ASC
       LIMIT ?`,
    )
    .all(sourceId, ...like.params, MAX_CANDIDATE_BLOCKS) as SummaryBlockRow[];

  const pages = sampledPages(units);
  const sampledRows = pages.length > 0
    ? getDb()
        .prepare(
          `SELECT *
           FROM source_document_blocks
           WHERE source_id = ?
             AND page_number IN (${pages.map(() => '?').join(',')})
           ORDER BY CASE WHEN page_number IS NULL THEN 999999 ELSE page_number END ASC, block_index ASC
           LIMIT ?`,
        )
        .all(sourceId, ...pages, Math.min(900, pages.length * 12)) as SummaryBlockRow[]
    : [];

  const byId = new Map<string, StoredDocumentBlock>();
  for (const row of [...structuralRows, ...sampledRows]) {
    if (!row.text.trim()) continue;
    byId.set(row.id, toStoredBlock(row));
  }
  return [...byId.values()].sort((a, b) =>
    (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER)
    || a.blockIndex - b.blockIndex);
}

function headingCandidates(blocks: StoredDocumentBlock[]): StoredDocumentBlock[] {
  return blocks.filter((block) =>
    block.type === 'title'
    || block.type === 'heading'
    || CHAPTER_RE.test(block.text.slice(0, 260))
    || STRUCTURE_RE.test(block.text.slice(0, 260)));
}

function buildOutline(units: StoredDocumentUnit[], blocks: StoredDocumentBlock[]): DocumentSummaryItem[] {
  const outline: DocumentSummaryItem[] = [];
  const seen = new Set<string>();
  const structuralUnits = balancedSample(units.filter(unitLooksStructural), 55);
  for (const unit of structuralUnits) {
    pushUnique(outline, seen, unitItem(unit), 55);
  }
  for (const block of balancedSample(headingCandidates(blocks), MAX_OUTLINE)) {
    pushUnique(outline, seen, blockItem(block), MAX_OUTLINE);
  }
  if (outline.length < 8) {
    for (const unit of balancedSample(units, 30)) pushUnique(outline, seen, unitItem(unit), MAX_OUTLINE);
  }
  return outline;
}

function buildPracticeIndex(blocks: StoredDocumentBlock[]): DocumentSummaryItem[] {
  const items: DocumentSummaryItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const text = block.text.slice(0, 700);
    if (PRACTICE_RE.test(text)) pushUnique(items, seen, blockItem(block), MAX_PRACTICE);
  }
  return items;
}

function buildRouteHints(blocks: StoredDocumentBlock[], outline: DocumentSummaryItem[]): DocumentSummaryItem[] {
  const items: DocumentSummaryItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const text = block.text.slice(0, 900);
    if (OBJECTIVE_RE.test(text) || STRUCTURE_RE.test(text)) pushUnique(items, seen, blockItem(block), MAX_ROUTE_HINTS);
  }
  for (const item of outline.slice(0, 24)) pushUnique(items, seen, item, MAX_ROUTE_HINTS);
  return items;
}

function extractConceptCandidates(outline: DocumentSummaryItem[], blocks: StoredDocumentBlock[]): DocumentSummaryItem[] {
  const items: DocumentSummaryItem[] = [];
  const seen = new Set<string>();
  for (const item of outline) pushUnique(items, seen, item, MAX_CONCEPTS);
  for (const block of blocks) {
    if (items.length >= MAX_CONCEPTS) break;
    if (block.type !== 'table' && block.type !== 'heading' && !OBJECTIVE_RE.test(block.text.slice(0, 700))) continue;
    pushUnique(items, seen, blockItem(block), MAX_CONCEPTS);
  }
  return items;
}

function buildOverview(input: {
  source: SourceRow;
  unitCount: number;
  blockCount: number;
  textUnitCount: number;
  outline: DocumentSummaryItem[];
  practiceIndex: DocumentSummaryItem[];
  routeHints: DocumentSummaryItem[];
}): string {
  const outlineText = input.outline.slice(0, 8).map((item) => item.label).join('；');
  const practiceText = input.practiceIndex.slice(0, 5).map((item) => item.label).join('；');
  const hintText = input.routeHints.slice(0, 5).map((item) => item.label).join('；');
  return [
    `资料《${input.source.title}》已解析为 ${input.unitCount} 个文档单元、${input.blockCount} 个内容块，其中 ${input.textUnitCount} 个单元含文本。`,
    input.source.remark ? `备注：${input.source.remark}` : '',
    outlineText ? `主要结构线索：${outlineText}` : '',
    hintText ? `学习目标/路线线索：${hintText}` : '',
    practiceText ? `练习/实验线索：${practiceText}` : '',
  ].filter(Boolean).join('\n');
}

export function getDocumentSummaryTree(sourceId: string): DocumentSummaryTree | null {
  const row = getDb()
    .prepare<[string], SummaryRow>('SELECT * FROM source_document_summaries WHERE source_id = ?')
    .get(sourceId);
  return row ? rowToTree(row) : null;
}

export function upsertDocumentSummaryTree(sourceId: string, options?: { force?: boolean }): DocumentSummaryTree | null {
  const existing = getDocumentSummaryTree(sourceId);
  if (existing?.contentHash.startsWith(`${SUMMARY_TREE_VERSION}:`) && !options?.force) return existing;

  const source = sourceRow(sourceId);
  if (!source) return null;
  const units = listDocumentUnits(sourceId);
  const blocks = listSummaryCandidateBlocks(sourceId, units);
  const summary = getDocumentSummary(sourceId);
  if (summary.unitCount === 0 && summary.blockCount === 0) return null;

  const hash = contentHash(units, blocks);

  const outline = buildOutline(units, blocks);
  const practiceIndex = buildPracticeIndex(blocks);
  const routeHints = buildRouteHints(blocks, outline);
  const keyConcepts = extractConceptCandidates(outline, blocks);
  const overview = buildOverview({
    source,
    unitCount: summary.unitCount,
    blockCount: summary.blockCount,
    textUnitCount: summary.textUnitCount,
    outline,
    practiceIndex,
    routeHints,
  });

  getDb().prepare(
    `INSERT INTO source_document_summaries (
       source_id, course_id, content_hash, overview, outline_json, key_concepts_json,
       practice_index_json, route_hints_json, summary_json, updated_at
     ) VALUES (
       @source_id, @course_id, @content_hash, @overview, @outline_json, @key_concepts_json,
       @practice_index_json, @route_hints_json, @summary_json, datetime('now')
     )
     ON CONFLICT(source_id) DO UPDATE SET
       course_id = excluded.course_id,
       content_hash = excluded.content_hash,
       overview = excluded.overview,
       outline_json = excluded.outline_json,
       key_concepts_json = excluded.key_concepts_json,
       practice_index_json = excluded.practice_index_json,
       route_hints_json = excluded.route_hints_json,
       summary_json = excluded.summary_json,
       updated_at = datetime('now')`,
  ).run({
    source_id: source.id,
    course_id: source.course_id,
    content_hash: hash,
    overview,
    outline_json: JSON.stringify(outline),
    key_concepts_json: JSON.stringify(keyConcepts),
    practice_index_json: JSON.stringify(practiceIndex),
    route_hints_json: JSON.stringify(routeHints),
    summary_json: JSON.stringify({
      unitCount: summary.unitCount,
      blockCount: summary.blockCount,
      textUnitCount: summary.textUnitCount,
      ocrPendingCount: summary.ocrPendingCount,
      pageAssetCount: summary.pageAssetCount,
    }),
  });

  return getDocumentSummaryTree(sourceId);
}

function formatItems(title: string, items: DocumentSummaryItem[], max: number): string {
  if (items.length === 0) return '';
  const lines = items.slice(0, max).map((item) => {
    const loc = item.page ? `p.${item.page}` : item.locator;
    return `- ${loc ? `${loc} · ` : ''}${item.label}${item.detail ? `（${item.detail}）` : ''}`;
  });
  return `[${title}]\n${lines.join('\n')}`;
}

export function formatDocumentSummaryTreeForAgent(sourceId: string, options?: {
  maxOutline?: number;
  maxConcepts?: number;
  maxPractice?: number;
  maxHints?: number;
}): string | null {
  const tree = upsertDocumentSummaryTree(sourceId);
  if (!tree) return null;
  return [
    tree.overview,
    formatItems('摘要目录', tree.outline, options?.maxOutline ?? 28),
    formatItems('关键概念线索', tree.keyConcepts, options?.maxConcepts ?? 18),
    formatItems('练习/实验线索', tree.practiceIndex, options?.maxPractice ?? 14),
    formatItems('路线规划线索', tree.routeHints, options?.maxHints ?? 14),
  ].filter(Boolean).join('\n\n');
}
