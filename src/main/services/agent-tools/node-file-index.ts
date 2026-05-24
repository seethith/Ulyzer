import * as fs from 'fs';
import * as nodePath from 'path';
import { createLogger } from '../../utils/logger';
import { getDb } from '../db/sqlite';
import { importTextSource, replaceSourceContent } from '../source/source-library';
import type { ToolContext } from './tutor-tools';

const log = createLogger('node-file-index');

const MAX_INDEX_FILE_BYTES = 4_000_000;
const MAX_INDEX_FILES_PER_OPERATION = 120;

const INDEXABLE_TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml',
]);

function stableNodeSourceId(courseId: string, nodeId: string, relPath: string): string {
  return `node-file-source:${courseId}:${nodeId}:${normalizeIndexRelPath(relPath)}`;
}

function normalizeIndexRelPath(relPath: string): string {
  return nodePath.posix.normalize(relPath.replace(/\\/g, '/')).replace(/^\/+/, '');
}

function isIndexableFile(fullPath: string): boolean {
  try {
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (stat.size > MAX_INDEX_FILE_BYTES) return false;
    return INDEXABLE_TEXT_EXTENSIONS.has(nodePath.extname(fullPath).toLowerCase());
  } catch {
    return false;
  }
}

export function collectIndexableNodeFiles(root: string, fullPath: string): Array<{ rel: string; fullPath: string }> {
  const resolvedRoot = nodePath.resolve(root);
  const resolvedPath = nodePath.resolve(fullPath);
  const files: Array<{ rel: string; fullPath: string }> = [];

  const addFile = (filePath: string): void => {
    if (files.length >= MAX_INDEX_FILES_PER_OPERATION) return;
    if (!isIndexableFile(filePath)) return;
    const rel = nodePath.relative(resolvedRoot, filePath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('../')) return;
    files.push({ rel, fullPath: filePath });
  };

  const walk = (pathToRead: string): void => {
    if (files.length >= MAX_INDEX_FILES_PER_OPERATION) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(pathToRead);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      addFile(pathToRead);
      return;
    }
    if (!stat.isDirectory()) return;

    for (const entry of fs.readdirSync(pathToRead, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      walk(nodePath.join(pathToRead, entry.name));
      if (files.length >= MAX_INDEX_FILES_PER_OPERATION) break;
    }
  };

  walk(resolvedPath);
  return files;
}

export function removeNodeFileIndex(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  relPath: string,
  fullPath?: string,
): void {
  try {
    disableNodeSourceIndex(ctx, relPath, fullPath);
  } catch (err) {
    log.warn('删除节点文件索引失败', { nodeId: ctx.nodeId, relPath, error: String(err) });
  }
}

export function reindexNodeFile(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  relPath: string,
  fullPath: string,
): void {
  const rel = normalizeIndexRelPath(relPath);
  try {
    disableNodeSourceIndex(ctx, rel, fullPath);
    if (!isIndexableFile(fullPath)) return;
    const content = fs.readFileSync(fullPath, 'utf-8');
    upsertNodeSourceIndex(ctx, rel, fullPath, content);
  } catch (err) {
    log.warn('重建节点文件索引失败', { nodeId: ctx.nodeId, relPath: rel, error: String(err) });
  }
}

export function reindexNodePath(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  root: string,
  fullPath: string,
): void {
  for (const file of collectIndexableNodeFiles(root, fullPath)) {
    reindexNodeFile(ctx, file.rel, file.fullPath);
  }
}

export function removeNodePathIndexes(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  root: string,
  fullPath: string,
): void {
  const files = collectIndexableNodeFiles(root, fullPath);
  if (files.length === 0) {
    const rel = nodePath.relative(root, fullPath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('../')) removeNodeFileIndex(ctx, rel, fullPath);
    return;
  }
  for (const file of files) removeNodeFileIndex(ctx, file.rel, file.fullPath);
}

function disableNodeSourceIndex(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  relPath: string,
  fullPath?: string,
): void {
  try {
    const rel = normalizeIndexRelPath(relPath);
    const id = stableNodeSourceId(ctx.courseId, ctx.nodeId, rel);
    getDb().prepare('UPDATE source_records SET enabled = 0 WHERE id = ?').run(id);
    if (fullPath) {
      getDb()
        .prepare(
          `UPDATE source_records
           SET enabled = 0
           WHERE course_id = ? AND node_id = ? AND file_path = ? AND kind = 'generated'`,
        )
        .run(ctx.courseId, ctx.nodeId, fullPath);
    }
  } catch (err) {
    log.warn('停用节点文件资料索引失败', { nodeId: ctx.nodeId, relPath, error: String(err) });
  }
}

function upsertNodeSourceIndex(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  relPath: string,
  fullPath: string,
  content: string,
): void {
  try {
    const rel = normalizeIndexRelPath(relPath);
    const id = stableNodeSourceId(ctx.courseId, ctx.nodeId, rel);
    const title = nodePath.posix.basename(rel);
    const exists = Boolean(getDb().prepare<[string], { id: string }>('SELECT id FROM source_records WHERE id = ?').get(id));
    if (exists) {
      replaceSourceContent({ sourceId: id, title, content, mimeType: 'text/markdown' });
      getDb()
        .prepare(
          `UPDATE source_records
           SET enabled = 1, title = ?, file_path = ?, kind = 'generated', origin = 'ai_generated'
           WHERE id = ?`,
        )
        .run(title, fullPath, id);
    } else {
      importTextSource({
        id,
        courseId: ctx.courseId,
        nodeId: ctx.nodeId,
        title,
        content,
        filePath: fullPath,
        kind: 'generated',
        origin: 'ai_generated',
        mimeType: 'text/markdown',
      });
    }
  } catch (err) {
    log.warn('同步节点文件到参考库索引失败', { nodeId: ctx.nodeId, relPath, error: String(err) });
  }
}
