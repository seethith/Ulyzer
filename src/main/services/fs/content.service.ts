import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { FolderKey, FsEntry } from '@shared/types';
import { getDb } from '../db/sqlite';
import {
  detectFolderLanguageFromNames,
  getFolderNameMap,
  getFolderSortLocale,
  getNodeSubfolderNames,
  getOutlineFolderName,
} from '../agent-i18n/folder-policy';

/**
 * Auto-detect whether a node's workspace was created in English or Chinese
 * by checking whether the 'Outline' (en) or '纲要' (zh) directory exists.
 */
function detectNodeFolderLanguage(courseId: string, nodeId: string): 'zh' | 'en' {
  const nodeDir = getNodeDir(courseId, nodeId);
  try {
    const folderNames = fs.readdirSync(nodeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    return detectFolderLanguageFromNames(folderNames);
  } catch {
    return 'zh';
  }
}

// ── Name helpers ──────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 60) || 'unnamed';
}

function getCourseFolderName(courseId: string): string {
  try {
    const row = getDb().prepare<[string], { name: string }>('SELECT name FROM courses WHERE id = ?').get(courseId);
    if (row?.name) return sanitizeName(row.name);
  } catch { /* DB not ready */ }
  return courseId;
}

function getNodeFolderName(nodeId: string): string {
  try {
    const row = getDb().prepare<[string], { name: string }>('SELECT name FROM dag_nodes WHERE id = ?').get(nodeId);
    if (row?.name) return sanitizeName(row.name);
  } catch { /* DB not ready */ }
  return nodeId;
}

// ── Migration helper ──────────────────────────────────────────────────────────

/**
 * Recursively merge `src` directory into `dst`.
 * Items that already exist in `dst` are left untouched (no overwrites).
 * After merging, `src` is removed if empty.
 */
function mergeDirectories(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const srcItem = path.join(src, item.name);
    const dstItem = path.join(dst, item.name);
    if (item.isDirectory()) {
      mergeDirectories(srcItem, dstItem);
    } else if (!fs.existsSync(dstItem)) {
      try { fs.renameSync(srcItem, dstItem); } catch { /* best-effort */ }
    }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* ignore */ }
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function getContentRoot(): string {
  return path.join(app.getPath('userData'), 'ulyzer-content');
}

export function getCourseDir(courseId: string): string {
  const name = getCourseFolderName(courseId);
  const newPath = path.join(getContentRoot(), name);

  // Migration: rename/merge old UUID-named course dir into human-readable name
  if (name !== courseId) {
    const oldPath = path.join(getContentRoot(), courseId);
    if (fs.existsSync(oldPath)) {
      if (!fs.existsSync(newPath)) {
        try { fs.renameSync(oldPath, newPath); } catch { /* best-effort */ }
      } else {
        mergeDirectories(oldPath, newPath);
      }
    }
  }
  return newPath;
}

export function getNodeDir(courseId: string, nodeId: string): string {
  const nodeName = getNodeFolderName(nodeId);
  const newPath = path.join(getCourseDir(courseId), nodeName);

  // Migration: rename/merge old UUID-named node dir into human-readable name
  if (nodeName !== nodeId) {
    const oldPath = path.join(getCourseDir(courseId), nodeId);
    if (fs.existsSync(oldPath)) {
      if (!fs.existsSync(newPath)) {
        try { fs.renameSync(oldPath, newPath); } catch { /* best-effort */ }
      } else {
        mergeDirectories(oldPath, newPath);
      }
    }
  }
  return newPath;
}

export function getFolderPath(courseId: string, nodeId: string, folderKey: FolderKey): string {
  // Auto-detect node's folder language from disk so old (zh) and new (en) nodes both resolve correctly.
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  const dirName = getFolderNameMap(lang)[folderKey];
  return path.join(getNodeDir(courseId, nodeId), dirName);
}

// ── Directory management ──────────────────────────────────────────────────────

export function ensureCourseDir(courseId: string): void {
  fs.mkdirSync(getCourseDir(courseId), { recursive: true });
}

export function ensureNodeDir(courseId: string, nodeId: string, language?: string): void {
  const dir = getNodeDir(courseId, nodeId);
  const existedBefore = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (existedBefore) return;
  const subfolders = getNodeSubfolderNames(language);
  for (const sub of subfolders) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

// ── Outline path helpers ──────────────────────────────────────────────────────

/** Returns the outline subfolder path for a node (auto-detects zh/en from disk). */
export function getOutlineDirPath(courseId: string, nodeId: string): string {
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  return path.join(getNodeDir(courseId, nodeId), getOutlineFolderName(lang));
}

/**
 * Returns the path of the latest existing outline file, checking in order:
 * `纲要/_outline_v3.md` → `_outline_v2.md` → `_outline_v1.md` → legacy `_outline.md`.
 * Returns `null` if no outline exists.
 */
export function getLatestOutlinePath(courseId: string, nodeId: string): string | null {
  const dir = getOutlineDirPath(courseId, nodeId);
  for (const v of ['v3', 'v2', 'v1'] as const) {
    const p = path.join(dir, `_outline_${v}.md`);
    if (fs.existsSync(p)) return p;
  }
  // Legacy fallback: _outline.md in node root (pre-纲要 structure)
  const legacy = path.join(getNodeDir(courseId, nodeId), '_outline.md');
  if (fs.existsSync(legacy)) return legacy;

  // Safety fallback: if getNodeFolderName DB lookup failed and fell back to UUID,
  // the resolved dir above may already use the UUID — but if the folder was saved
  // under the human-readable name while the current lookup returned the UUID (or vice
  // versa), try the UUID-keyed path under the course directory as a last resort.
  try {
    for (const outlineFolderName of [getOutlineFolderName('zh'), getOutlineFolderName('en')]) {
      const uuidDir = path.join(getCourseDir(courseId), nodeId, outlineFolderName);
      if (uuidDir !== dir) {
        for (const v of ['v3', 'v2', 'v1'] as const) {
          const p = path.join(uuidDir, `_outline_${v}.md`);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

/** Returns the canonical write path for a freshly generated v1 outline. */
export function getOutlineV1WritePath(courseId: string, nodeId: string): string {
  return path.join(getOutlineDirPath(courseId, nodeId), '_outline_v1.md');
}

// ── Tree listing ──────────────────────────────────────────────────────────────

function buildTree(dirPath: string, baseName: string): FsEntry {
  const children: FsEntry[] = [];
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const itemPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        children.push(buildTree(itemPath, item.name));
      } else {
        children.push({ name: item.name, path: itemPath, type: 'file' });
      }
    }
  } catch { /* ignore */ }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, getFolderSortLocale());
  });
  return { name: baseName, path: dirPath, type: 'folder', children };
}

export function listNodeTree(courseId: string, nodeId: string): FsEntry {
  const nodeDir = getNodeDir(courseId, nodeId);
  const nodeName = getNodeFolderName(nodeId);
  const root: FsEntry = { name: nodeName, path: nodeDir, type: 'folder', children: [] };

  // Existing standard subfolders appear first, in canonical order (auto-detect zh vs en).
  // Missing standard folders are not synthesized here: users may rename/delete them in the explorer.
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  const subfolders = getNodeSubfolderNames(lang);
  const listedStandardNames = new Set<string>();
  for (const sub of subfolders) {
    const subPath = path.join(nodeDir, sub);
    try {
      if (!fs.statSync(subPath).isDirectory()) continue;
      root.children!.push(buildTree(subPath, sub));
      listedStandardNames.add(sub);
    } catch {
      // The user may have deleted or renamed this standard folder.
    }
  }

  // Any additional files/folders created directly in the node root also appear
  try {
    const extras = fs.readdirSync(nodeDir, { withFileTypes: true })
      .filter((item) => !listedStandardNames.has(item.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, getFolderSortLocale(lang));
      });
    for (const item of extras) {
      const itemPath = path.join(nodeDir, item.name);
      root.children!.push(
        item.isDirectory()
          ? buildTree(itemPath, item.name)
          : { name: item.name, path: itemPath, type: 'file' },
      );
    }
  } catch { /* ignore */ }

  return root;
}

// ── Startup migration ─────────────────────────────────────────────────────────

/**
 * Rename all UUID-named course/node folders to human-readable names.
 * Should be called once at app startup, after the DB is ready.
 * Safe to call multiple times — already-renamed folders are a no-op.
 */
export function migrateAllFolders(): void {
  try {
    const db = getDb();
    const courses = db.prepare<[], { id: string }>('SELECT id FROM courses').all();
    for (const course of courses) {
      getCourseDir(course.id);
      const nodes = db.prepare<[string], { id: string }>('SELECT id FROM dag_nodes WHERE course_id = ?').all(course.id);
      for (const node of nodes) {
        getNodeDir(course.id, node.id);
      }
    }
  } catch { /* DB not ready — skip silently */ }
}

// ── File operations ───────────────────────────────────────────────────────────

export function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeFileContent(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function deleteFileFsResult(filePath: string): { success: boolean; error?: string } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

function assertExists(targetPath: string, label = '项目'): void {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label}不存在：${path.basename(targetPath)}`);
  }
}

function assertTargetAvailable(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(`目标位置已存在同名文件或文件夹：${path.basename(targetPath)}`);
  }
}

function assertDirectory(targetPath: string, label = '目标文件夹'): void {
  assertExists(targetPath, label);
  if (!fs.statSync(targetPath).isDirectory()) {
    throw new Error(`${label}不是文件夹：${path.basename(targetPath)}`);
  }
}

function normalizePathForCompare(targetPath: string): string {
  return path.resolve(targetPath);
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePathForCompare(parentPath);
  const candidate = normalizePathForCompare(candidatePath);
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function nextCopyTargetPath(srcPath: string, destDir: string): string {
  const name = path.basename(srcPath);
  const ext = fs.statSync(srcPath).isDirectory() ? '' : path.extname(name);
  const base = ext ? path.basename(name, ext) : name;
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? '_副本' : `_副本${index}`;
    const candidate = path.join(destDir, `${base}${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法创建副本：${name} 的副本数量过多`);
}

function nextImportTargetPath(srcPath: string, destDir: string): string {
  const name = path.basename(srcPath);
  const original = path.join(destDir, name);
  if (!fs.existsSync(original)) return original;

  const ext = fs.statSync(srcPath).isDirectory() ? '' : path.extname(name);
  const base = ext ? path.basename(name, ext) : name;
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? '_导入' : `_导入${index}`;
    const candidate = path.join(destDir, `${base}${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法导入：${name} 的同名文件过多`);
}

function nextClipboardPasteTargetPath(srcPath: string, destDir: string): string {
  const name = path.basename(srcPath);
  const original = path.join(destDir, name);
  if (!fs.existsSync(original)) return original;

  const ext = fs.statSync(srcPath).isDirectory() ? '' : path.extname(name);
  const base = ext ? path.basename(name, ext) : name;
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? '_副本' : `_副本${index}`;
    const candidate = path.join(destDir, `${base}${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法粘贴：${name} 的副本数量过多`);
}

export function createFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertTargetAvailable(filePath);
  fs.writeFileSync(filePath, '', 'utf-8');
}

export function createFolder(folderPath: string): void {
  assertTargetAvailable(folderPath);
  fs.mkdirSync(folderPath, { recursive: true });
}

export function renameItem(oldPath: string, newName: string): string {
  assertExists(oldPath);
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  if (normalizePathForCompare(oldPath) === normalizePathForCompare(newPath)) return oldPath;
  assertTargetAvailable(newPath);
  fs.renameSync(oldPath, newPath);
  return newPath;
}

export function copyFile(srcPath: string, destDir: string): string {
  assertExists(srcPath, '源项目');
  assertDirectory(destDir);
  const destPath = nextCopyTargetPath(srcPath, destDir);
  if (fs.statSync(srcPath).isDirectory()) {
    if (isSameOrDescendant(srcPath, destDir)) {
      throw new Error('不能把文件夹复制到它自己或它的子文件夹中');
    }
    fs.cpSync(srcPath, destPath, { recursive: true, errorOnExist: true, force: false });
  } else {
    fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_EXCL);
  }
  return destPath;
}

export function importPaths(srcPaths: string[], destDir: string): string[] {
  assertDirectory(destDir);
  const imported: string[] = [];
  for (const srcPath of srcPaths) {
    assertExists(srcPath, '源项目');
    const destPath = nextImportTargetPath(srcPath, destDir);
    if (fs.statSync(srcPath).isDirectory()) {
      if (isSameOrDescendant(srcPath, destDir)) {
        throw new Error('不能把文件夹导入到它自己或它的子文件夹中');
      }
      fs.cpSync(srcPath, destPath, { recursive: true, errorOnExist: true, force: false });
    } else {
      fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_EXCL);
    }
    imported.push(destPath);
  }
  return imported;
}

export function copyPathsToDirectory(srcPaths: string[], destDir: string): string[] {
  assertDirectory(destDir);
  const copied: string[] = [];
  for (const srcPath of srcPaths) {
    assertExists(srcPath, '源项目');
    const destPath = nextClipboardPasteTargetPath(srcPath, destDir);
    if (fs.statSync(srcPath).isDirectory()) {
      if (isSameOrDescendant(srcPath, destDir)) {
        throw new Error('不能把文件夹粘贴到它自己或它的子文件夹中');
      }
      fs.cpSync(srcPath, destPath, { recursive: true, errorOnExist: true, force: false });
    } else {
      fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_EXCL);
    }
    copied.push(destPath);
  }
  return copied;
}

export function moveItem(srcPath: string, destDir: string): string {
  assertExists(srcPath, '源项目');
  assertDirectory(destDir);
  if (isSameOrDescendant(srcPath, destDir)) {
    throw new Error('不能把文件夹移动到它自己或它的子文件夹中');
  }
  const currentParent = normalizePathForCompare(path.dirname(srcPath));
  const targetParent = normalizePathForCompare(destDir);
  if (currentParent === targetParent) return srcPath;
  const destPath = path.join(destDir, path.basename(srcPath));
  assertTargetAvailable(destPath);
  fs.renameSync(srcPath, destPath);
  return destPath;
}

