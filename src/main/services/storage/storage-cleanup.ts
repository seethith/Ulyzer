import { app } from 'electron';
import { randomUUID } from 'crypto';
import { existsSync, lstatSync, readdirSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import type {
  StorageAreaStat,
  StorageCleanupResult,
  StorageStats,
} from '@shared/types';
import { getDb } from '../db/sqlite';
import { getContentRoot } from '../fs/content.service';
import { getLibraryRoot } from '../source/source-assets';

interface CleanupQueueRow {
  id: string;
  path: string;
  kind: string;
  owner_type: string | null;
  owner_id: string | null;
  reason: string | null;
  attempts: number;
  state: 'pending' | 'resolved' | 'failed';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RemoveResult {
  ok: boolean;
  bytes: number;
  error?: string;
}

function userDataRoot(): string {
  return app.getPath('userData');
}

function ocrCacheRoot(): string {
  return join(userDataRoot(), 'ocr-cache');
}

function runtimeCacheRoot(): string {
  return join(getLibraryRoot(), '.runtime', 'local-transcription');
}

function ownedRoots(): string[] {
  return [
    getLibraryRoot(),
    getContentRoot(),
    ocrCacheRoot(),
  ].map((item) => resolve(item));
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function assertOwnedPath(targetPath: string): void {
  const resolvedPath = resolve(targetPath);
  if (!ownedRoots().some((root) => isInside(resolvedPath, root))) {
    throw new Error(`Refuse to clean path outside Ulyzer storage: ${targetPath}`);
  }
}

function pathSize(targetPath: string): number {
  if (!existsSync(targetPath)) return 0;
  const stat = lstatSync(targetPath);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(targetPath)) {
    total += pathSize(join(targetPath, entry));
  }
  return total;
}

function removeOwnedPath(targetPath: string): RemoveResult {
  try {
    assertOwnedPath(targetPath);
    const bytes = pathSize(targetPath);
    if (!existsSync(targetPath)) return { ok: true, bytes: 0 };
    rmSync(targetPath, { recursive: true, force: true });
    return { ok: true, bytes };
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function removeSourceAssetsById(courseDir: string, sourceId: string): RemoveResult {
  try {
    assertOwnedPath(courseDir);
    if (!existsSync(courseDir)) return { ok: true, bytes: 0 };
    let bytes = 0;
    let removed = false;
    for (const entry of readdirSync(courseDir)) {
      if (!entry.startsWith(`${sourceId}-`)) continue;
      const targetPath = join(courseDir, entry);
      bytes += pathSize(targetPath);
      rmSync(targetPath, { recursive: true, force: true });
      removed = true;
    }
    return { ok: true, bytes: removed ? bytes : 0 };
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceAssetSourceId(entryName: string): string | null {
  const match = entryName.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i);
  return match?.[1] ?? null;
}

function sourceIdsForCourse(courseId: string): Set<string> {
  return new Set(
    getDb()
      .prepare<[string], { id: string }>('SELECT id FROM source_records WHERE course_id = ?')
      .all(courseId)
      .map((row) => row.id),
  );
}

function orphanAssetPaths(courseId?: string): string[] {
  const root = getLibraryRoot();
  if (!existsSync(root)) return [];
  const courseIds = courseId
    ? [courseId]
    : readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  const paths: string[] = [];
  for (const cid of courseIds) {
    const dir = join(root, cid);
    if (!existsSync(dir)) continue;
    const sourceIds = sourceIdsForCourse(cid);
    for (const entry of readdirSync(dir)) {
      const sourceId = sourceAssetSourceId(entry);
      if (sourceId && sourceIds.has(sourceId)) continue;
      paths.push(join(dir, entry));
    }
  }
  return paths;
}

export function recordCleanupFailure(input: {
  path?: string | null;
  kind: string;
  ownerType?: string;
  ownerId?: string;
  reason?: string | null;
  error?: unknown;
}): void {
  if (!input.path) return;
  try {
    assertOwnedPath(input.path);
    const db = getDb();
    const existing = db.prepare<[string, string, string | null], { id: string }>(
      `SELECT id FROM storage_cleanup_queue
       WHERE path = ? AND kind = ? AND owner_id IS ? AND state IN ('pending', 'failed')
       LIMIT 1`,
    ).get(input.path, input.kind, input.ownerId ?? null);
    const message = input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null;
    if (existing) {
      db.prepare(
        `UPDATE storage_cleanup_queue
         SET reason = COALESCE(@reason, reason),
             last_error = COALESCE(@last_error, last_error),
             state = 'pending',
             updated_at = datetime('now')
         WHERE id = @id`,
      ).run({
        id: existing.id,
        reason: input.reason ?? null,
        last_error: message,
      });
      return;
    }
    db.prepare(
      `INSERT INTO storage_cleanup_queue (
         id, path, kind, owner_type, owner_id, reason, last_error
       ) VALUES (
         @id, @path, @kind, @owner_type, @owner_id, @reason, @last_error
       )`,
    ).run({
      id: randomUUID(),
      path: input.path,
      kind: input.kind,
      owner_type: input.ownerType ?? null,
      owner_id: input.ownerId ?? null,
      reason: input.reason ?? null,
      last_error: message,
    });
  } catch {
    // Cleanup bookkeeping must never break the primary user action.
  }
}

export function getStorageStats(): StorageStats {
  const areas: StorageAreaStat[] = [
    { key: 'library', label: '参考库资料', path: getLibraryRoot(), bytes: pathSize(getLibraryRoot()), exists: existsSync(getLibraryRoot()) },
    { key: 'content', label: '课程工作区', path: getContentRoot(), bytes: pathSize(getContentRoot()), exists: existsSync(getContentRoot()) },
    { key: 'ocr_cache', label: 'OCR 缓存', path: ocrCacheRoot(), bytes: pathSize(ocrCacheRoot()), exists: existsSync(ocrCacheRoot()) },
    { key: 'runtime_cache', label: '转写运行缓存', path: runtimeCacheRoot(), bytes: pathSize(runtimeCacheRoot()), exists: existsSync(runtimeCacheRoot()) },
  ];
  const queueRows = getDb()
    .prepare<[], { state: string; count: number }>(
      `SELECT state, COUNT(*) AS count
       FROM storage_cleanup_queue
       WHERE state IN ('pending', 'failed')
       GROUP BY state`,
    )
    .all();
  return {
    areas,
    totalBytes: areas.reduce((sum, item) => sum + item.bytes, 0),
    orphanAssetCount: orphanAssetPaths().length,
    pendingCleanupCount: queueRows.find((row) => row.state === 'pending')?.count ?? 0,
    failedCleanupCount: queueRows.find((row) => row.state === 'failed')?.count ?? 0,
  };
}

function markIssueResolved(id: string): void {
  getDb()
    .prepare(`UPDATE storage_cleanup_queue SET state = 'resolved', updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

function markIssueFailed(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE storage_cleanup_queue
       SET state = 'failed',
           attempts = attempts + 1,
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error, id);
}

function retryQueuedCleanups(): StorageCleanupResult {
  const rows = getDb()
    .prepare<[], CleanupQueueRow>(
      `SELECT * FROM storage_cleanup_queue
       WHERE state IN ('pending', 'failed')
       ORDER BY updated_at ASC
       LIMIT 200`,
    )
    .all();
  const result: StorageCleanupResult = {
    removedCount: 0,
    freedBytes: 0,
    retriedCount: rows.length,
    resolvedCount: 0,
    failedCount: 0,
    errors: [],
  };
  for (const row of rows) {
    const removed = row.kind === 'source-assets' && row.owner_id
      ? removeSourceAssetsById(row.path, row.owner_id)
      : removeOwnedPath(row.path);
    if (removed.ok) {
      markIssueResolved(row.id);
      result.resolvedCount += 1;
      result.removedCount += removed.bytes > 0 ? 1 : 0;
      result.freedBytes += removed.bytes;
    } else {
      markIssueFailed(row.id, removed.error ?? 'unknown cleanup error');
      result.failedCount += 1;
      result.errors.push(`${row.path}: ${removed.error ?? 'unknown cleanup error'}`);
    }
  }
  return result;
}

function mergeCleanupResult(target: StorageCleanupResult, source: StorageCleanupResult): StorageCleanupResult {
  target.removedCount += source.removedCount;
  target.freedBytes += source.freedBytes;
  target.retriedCount += source.retriedCount;
  target.resolvedCount += source.resolvedCount;
  target.failedCount += source.failedCount;
  target.errors.push(...source.errors);
  return target;
}

export function cleanupStorageOrphans(): StorageCleanupResult {
  const result: StorageCleanupResult = {
    removedCount: 0,
    freedBytes: 0,
    retriedCount: 0,
    resolvedCount: 0,
    failedCount: 0,
    errors: [],
  };
  for (const targetPath of orphanAssetPaths()) {
    const removed = removeOwnedPath(targetPath);
    if (removed.ok) {
      result.removedCount += removed.bytes > 0 ? 1 : 0;
      result.freedBytes += removed.bytes;
    } else {
      result.failedCount += 1;
      result.errors.push(`${targetPath}: ${removed.error ?? 'unknown cleanup error'}`);
      recordCleanupFailure({
        path: targetPath,
        kind: 'orphan-source-asset',
        reason: '清理孤儿参考资料资产失败',
        error: removed.error,
      });
    }
  }
  return mergeCleanupResult(result, retryQueuedCleanups());
}

export function clearOcrCache(): StorageCleanupResult {
  const removed = removeOwnedPath(ocrCacheRoot());
  return {
    removedCount: removed.ok && removed.bytes > 0 ? 1 : 0,
    freedBytes: removed.bytes,
    retriedCount: 0,
    resolvedCount: 0,
    failedCount: removed.ok ? 0 : 1,
    errors: removed.ok ? [] : [removed.error ?? 'unknown cleanup error'],
  };
}

export function clearRuntimeCache(): StorageCleanupResult {
  const removed = removeOwnedPath(runtimeCacheRoot());
  return {
    removedCount: removed.ok && removed.bytes > 0 ? 1 : 0,
    freedBytes: removed.bytes,
    retriedCount: 0,
    resolvedCount: 0,
    failedCount: removed.ok ? 0 : 1,
    errors: removed.ok ? [] : [removed.error ?? 'unknown cleanup error'],
  };
}
