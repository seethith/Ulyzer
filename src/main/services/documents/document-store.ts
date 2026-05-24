import { randomUUID } from 'crypto';
import type {
  DocumentAsset,
  StoredDocumentPageAsset,
  StoredDocumentBlock,
  StoredDocumentUnit,
} from './document-types';
import { getDb } from '../db/sqlite';

interface UnitRow {
  id: string;
  source_id: string;
  course_id: string;
  node_id: string | null;
  unit_index: number;
  unit_type: string;
  locator: string;
  title: string | null;
  page_number: number | null;
  text: string | null;
  char_count: number;
  ocr_state: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface BlockRow {
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

interface PageAssetRow {
  id: string;
  source_id: string;
  unit_id: string | null;
  course_id: string;
  node_id: string | null;
  page_number: number;
  asset_type: 'thumbnail' | 'page_image';
  file_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? {});
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

function toStoredUnit(row: UnitRow): StoredDocumentUnit {
  return {
    id: row.id,
    sourceId: row.source_id,
    courseId: row.course_id,
    nodeId: row.node_id,
    unitIndex: row.unit_index,
    kind: row.unit_type as StoredDocumentUnit['kind'],
    locator: row.locator,
    title: row.title,
    pageNumber: row.page_number,
    text: row.text ?? '',
    charCount: row.char_count,
    ocrState: (row.ocr_state ?? 'not_required') as StoredDocumentUnit['ocrState'],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
  };
}

function toStoredBlock(row: BlockRow): StoredDocumentBlock {
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

function toStoredPageAsset(row: PageAssetRow): StoredDocumentPageAsset {
  return {
    id: row.id,
    sourceId: row.source_id,
    unitId: row.unit_id,
    courseId: row.course_id,
    nodeId: row.node_id,
    pageNumber: row.page_number,
    assetType: row.asset_type,
    filePath: row.file_path,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertDocumentUnits(input: {
  sourceId: string;
  asset: DocumentAsset;
  units: DocumentAsset['units'];
}): void {
  const db = getDb();
  const insertUnit = db.prepare(
    `INSERT INTO source_document_units (
       id, source_id, course_id, node_id, unit_index, unit_type, locator, title,
       page_number, text, char_count, ocr_state, metadata_json
     ) VALUES (
       @id, @source_id, @course_id, @node_id, @unit_index, @unit_type, @locator, @title,
       @page_number, @text, @char_count, @ocr_state, @metadata_json
     )`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO source_document_blocks (
       id, unit_id, source_id, course_id, node_id, block_index, block_type, locator,
       heading_path, page_number, text, metadata_json, char_start, char_end
     ) VALUES (
       @id, @unit_id, @source_id, @course_id, @node_id, @block_index, @block_type, @locator,
       @heading_path, @page_number, @text, @metadata_json, @char_start, @char_end
     )`,
  );

  for (const unit of input.units) {
    const unitId = unit.id ?? randomUUID();
    insertUnit.run({
      id: unitId,
      source_id: input.sourceId,
      course_id: input.asset.courseId,
      node_id: input.asset.nodeId ?? null,
      unit_index: unit.unitIndex,
      unit_type: unit.kind,
      locator: unit.locator,
      title: unit.title ?? null,
      page_number: unit.pageNumber ?? null,
      text: unit.text,
      char_count: unit.charCount,
      ocr_state: unit.ocrState ?? 'not_required',
      metadata_json: jsonString(unit.metadata),
    });

    for (const block of unit.blocks) {
      insertBlock.run({
        id: block.id ?? randomUUID(),
        unit_id: unitId,
        source_id: input.sourceId,
        course_id: input.asset.courseId,
        node_id: input.asset.nodeId ?? null,
        block_index: block.blockIndex,
        block_type: block.type,
        locator: block.locator,
        heading_path: block.headingPath?.length ? JSON.stringify(block.headingPath) : null,
        page_number: block.pageNumber ?? unit.pageNumber ?? null,
        text: block.text,
        metadata_json: jsonString(block.metadata),
        char_start: block.charStart ?? null,
        char_end: block.charEnd ?? null,
      });
    }
  }
}

export function replaceDocumentAsset(sourceId: string, asset: DocumentAsset): {
  units: StoredDocumentUnit[];
  blocks: StoredDocumentBlock[];
} {
  const db = getDb();

  db.transaction(() => {
    db.prepare('DELETE FROM source_document_blocks WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM source_document_units WHERE source_id = ?').run(sourceId);
    insertDocumentUnits({ sourceId, asset, units: asset.units });
  })();

  return {
    units: listDocumentUnits(sourceId),
    blocks: listDocumentBlocks(sourceId),
  };
}

export function replaceDocumentUnits(sourceId: string, asset: DocumentAsset, units: DocumentAsset['units']): void {
  if (units.length === 0) return;
  const unitIndexes = units.map((unit) => unit.unitIndex);
  const placeholders = unitIndexes.map(() => '?').join(',');
  const db = getDb();
  db.transaction(() => {
    const existingUnitIds = db
      .prepare(`SELECT id FROM source_document_units WHERE source_id = ? AND unit_index IN (${placeholders})`)
      .all(sourceId, ...unitIndexes)
      .map((row) => (row as { id: string }).id);
    if (existingUnitIds.length > 0) {
      db.prepare(`DELETE FROM source_document_blocks WHERE unit_id IN (${existingUnitIds.map(() => '?').join(',')})`)
        .run(...existingUnitIds);
    }
    db.prepare(`DELETE FROM source_document_units WHERE source_id = ? AND unit_index IN (${placeholders})`)
      .run(sourceId, ...unitIndexes);
    insertDocumentUnits({ sourceId, asset, units });
  })();
}

export function upsertDocumentPageAsset(input: {
  sourceId: string;
  asset: DocumentAsset;
  pageNumber: number;
  assetType: 'thumbnail' | 'page_image';
  filePath: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
}): void {
  const unit = getDb()
    .prepare<[string, number], { id: string }>(
      'SELECT id FROM source_document_units WHERE source_id = ? AND page_number = ? LIMIT 1',
    )
    .get(input.sourceId, input.pageNumber);
  getDb().prepare(
    `INSERT INTO source_document_page_assets (
       id, source_id, unit_id, course_id, node_id, page_number, asset_type,
       file_path, mime_type, width, height, updated_at
     ) VALUES (
       @id, @source_id, @unit_id, @course_id, @node_id, @page_number, @asset_type,
       @file_path, @mime_type, @width, @height, datetime('now')
     )
     ON CONFLICT(source_id, page_number, asset_type) DO UPDATE SET
       unit_id = excluded.unit_id,
       file_path = excluded.file_path,
       mime_type = excluded.mime_type,
       width = excluded.width,
       height = excluded.height,
       updated_at = datetime('now')`,
  ).run({
    id: randomUUID(),
    source_id: input.sourceId,
    unit_id: unit?.id ?? null,
    course_id: input.asset.courseId,
    node_id: input.asset.nodeId ?? null,
    page_number: input.pageNumber,
    asset_type: input.assetType,
    file_path: input.filePath,
    mime_type: input.mimeType,
    width: input.width ?? null,
    height: input.height ?? null,
  });
}

export function listDocumentPageAssets(sourceId: string, options?: {
  pageNumber?: number;
  assetType?: 'thumbnail' | 'page_image';
  limit?: number;
}): StoredDocumentPageAsset[] {
  const clauses = ['source_id = ?'];
  const params: Array<string | number> = [sourceId];
  if (options?.pageNumber !== undefined) {
    clauses.push('page_number = ?');
    params.push(options.pageNumber);
  }
  if (options?.assetType) {
    clauses.push('asset_type = ?');
    params.push(options.assetType);
  }
  const limit = Math.min(options?.limit ?? 200, 1000);
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM source_document_page_assets
       WHERE ${clauses.join(' AND ')}
       ORDER BY page_number ASC
       LIMIT ?`,
    )
    .all(...params) as PageAssetRow[];
  return rows.map(toStoredPageAsset);
}

export function listDocumentUnits(sourceId: string): StoredDocumentUnit[] {
  const rows = getDb()
    .prepare<[string], UnitRow>(
      `SELECT * FROM source_document_units
       WHERE source_id = ?
       ORDER BY unit_index ASC`,
    )
    .all(sourceId);
  return rows.map(toStoredUnit);
}

export function listDocumentBlocks(sourceId: string, options?: {
  unitId?: string;
  pageNumber?: number;
  pageStart?: number;
  pageEnd?: number;
  limit?: number;
}): StoredDocumentBlock[] {
  const clauses = ['source_id = ?'];
  const params: Array<string | number> = [sourceId];
  if (options?.unitId) {
    clauses.push('unit_id = ?');
    params.push(options.unitId);
  }
  if (options?.pageNumber !== undefined) {
    clauses.push('page_number = ?');
    params.push(options.pageNumber);
  }
  if (options?.pageStart !== undefined) {
    clauses.push('page_number >= ?');
    params.push(options.pageStart);
  }
  if (options?.pageEnd !== undefined) {
    clauses.push('page_number <= ?');
    params.push(options.pageEnd);
  }
  const limit = Math.min(options?.limit ?? 200, 1000);
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM source_document_blocks
       WHERE ${clauses.join(' AND ')}
       ORDER BY page_number ASC, block_index ASC
       LIMIT ?`,
    )
    .all(...params) as BlockRow[];
  return rows.map(toStoredBlock);
}

export function getDocumentSummary(sourceId: string): {
  unitCount: number;
  blockCount: number;
  textUnitCount: number;
  ocrPendingCount: number;
  pageAssetCount: number;
} {
  const row = getDb()
    .prepare<[string, string, string, string, string], {
      unit_count: number;
      block_count: number;
      text_unit_count: number;
      ocr_pending_count: number;
      page_asset_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM source_document_units WHERE source_id = ?) AS unit_count,
         (SELECT COUNT(*) FROM source_document_blocks WHERE source_id = ?) AS block_count,
         (SELECT COUNT(*) FROM source_document_units WHERE source_id = ? AND char_count > 0) AS text_unit_count,
         (SELECT COUNT(*) FROM source_document_units WHERE source_id = ? AND ocr_state = 'pending' AND unit_type IN ('page', 'image')) AS ocr_pending_count,
         (SELECT COUNT(*) FROM source_document_page_assets WHERE source_id = ?) AS page_asset_count`,
    )
    .get(sourceId, sourceId, sourceId, sourceId, sourceId);
  return {
    unitCount: row?.unit_count ?? 0,
    blockCount: row?.block_count ?? 0,
    textUnitCount: row?.text_unit_count ?? 0,
    ocrPendingCount: row?.ocr_pending_count ?? 0,
    pageAssetCount: row?.page_asset_count ?? 0,
  };
}
