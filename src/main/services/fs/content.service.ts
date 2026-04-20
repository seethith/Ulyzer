import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { FsEntry } from '@shared/types';
import { getDb } from '../db/sqlite';

const NODE_SUBFOLDERS_ZH = ['纲要', '原理资料', '实践资料', '参考答案', '个人笔记', '费曼复盘'];
const NODE_SUBFOLDERS_EN = ['Outline', 'Theory', 'Practice', 'Answer', 'Notes', 'Feynman Review'];

/** Full folder key → on-disk name maps (zh and en). */
const FOLDER_MAP_ZH: Record<string, string> = {
  theory: '原理资料', practice: '实践资料', answer: '参考答案', notes: '个人笔记',
  outline: '纲要', feynman: '费曼复盘',
};
const FOLDER_MAP_EN: Record<string, string> = {
  theory: 'Theory', practice: 'Practice', answer: 'Answer', notes: 'Notes',
  outline: 'Outline', feynman: 'Feynman Review',
};

/** @deprecated Use getFolderPath — kept for direct Chinese-name callers */
export const GENERATE_FOLDER_MAP = FOLDER_MAP_ZH;

/**
 * Auto-detect whether a node's workspace was created in English or Chinese
 * by checking whether the 'Outline' (en) or '纲要' (zh) directory exists.
 */
function detectNodeFolderLanguage(courseId: string, nodeId: string): 'zh' | 'en' {
  const nodeDir = getNodeDir(courseId, nodeId);
  if (fs.existsSync(path.join(nodeDir, 'Outline'))) return 'en';
  return 'zh';
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

export function getFolderPath(courseId: string, nodeId: string, folderName: string): string {
  // Auto-detect node's folder language from disk so old (zh) and new (en) nodes both resolve correctly.
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  const map  = lang === 'en' ? FOLDER_MAP_EN : FOLDER_MAP_ZH;
  const dirName = map[folderName] ?? folderName;
  return path.join(getNodeDir(courseId, nodeId), dirName);
}

// ── Directory management ──────────────────────────────────────────────────────

export function ensureCourseDir(courseId: string): void {
  fs.mkdirSync(getCourseDir(courseId), { recursive: true });
}

export function ensureNodeDir(courseId: string, nodeId: string, language?: string): void {
  const dir = getNodeDir(courseId, nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const subfolders = language === 'en' ? NODE_SUBFOLDERS_EN : NODE_SUBFOLDERS_ZH;
  for (const sub of subfolders) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

// ── Outline path helpers ──────────────────────────────────────────────────────

/** Returns the outline subfolder path for a node (auto-detects zh/en from disk). */
export function getOutlineDirPath(courseId: string, nodeId: string): string {
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  return path.join(getNodeDir(courseId, nodeId), lang === 'en' ? 'Outline' : '纲要');
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
    const uuidDir = path.join(getCourseDir(courseId), nodeId, '纲要');
    if (uuidDir !== dir) {
      for (const v of ['v3', 'v2', 'v1'] as const) {
        const p = path.join(uuidDir, `_outline_${v}.md`);
        if (fs.existsSync(p)) return p;
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
    return a.name.localeCompare(b.name, 'zh');
  });
  return { name: baseName, path: dirPath, type: 'folder', children };
}

export function listNodeTree(courseId: string, nodeId: string): FsEntry {
  const nodeDir = getNodeDir(courseId, nodeId);
  const nodeName = getNodeFolderName(nodeId);
  const root: FsEntry = { name: nodeName, path: nodeDir, type: 'folder', children: [] };

  // Protected subfolders always appear first, in canonical order (auto-detect zh vs en)
  const lang = detectNodeFolderLanguage(courseId, nodeId);
  const subfolders = lang === 'en' ? NODE_SUBFOLDERS_EN : NODE_SUBFOLDERS_ZH;
  const protectedNames = new Set(subfolders);
  for (const sub of subfolders) {
    root.children!.push(buildTree(path.join(nodeDir, sub), sub));
  }

  // Any additional files/folders created directly in the node root also appear
  try {
    const extras = fs.readdirSync(nodeDir, { withFileTypes: true })
      .filter((item) => !protectedNames.has(item.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
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

export function deleteFileFs(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch { /* ignore */ }
}

export function createFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf-8');
  }
}

export function createFolder(folderPath: string): void {
  fs.mkdirSync(folderPath, { recursive: true });
}

export function renameItem(oldPath: string, newName: string): string {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  fs.renameSync(oldPath, newPath);
  return newPath;
}

export function copyFile(srcPath: string, destDir: string): string {
  const name = path.basename(srcPath);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const destPath = path.join(destDir, `${base}_副本${ext}`);
  fs.copyFileSync(srcPath, destPath);
  return destPath;
}

export function generateFileName(userMessage: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const slug = userMessage
    .slice(0, 20)
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '-')
    .trim();
  return `${ts}-${slug || 'note'}.md`;
}
