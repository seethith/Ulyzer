/**
 * StudentMemory — file-based per-course memory for personalised tutoring.
 *
 * Layout (inside app userData):
 *   ulyzer-memory/
 *     {courseId}/
 *       MEMORY.md          ← index (always loaded, < 100 lines)
 *       memory/
 *         mastery.md       ← per-node mastery scores
 *         weaknesses.md    ← recurring error patterns / blind spots
 *         preferences.md   ← preferred explanation style
 *
 * Design principles:
 * - Load is memoized per-session so repeated calls within one session hit disk once.
 * - Write is fire-and-forget; callers use `void updateStudentMemory(...)`.
 * - Output is injected as a dynamic user message, keeping the static system prompt
 *   cacheable by Anthropic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createLogger } from '../../utils/logger';

const log = createLogger('StudentMemory');

// ── Paths ─────────────────────────────────────────────────────────────────────

function memoryRoot(): string {
  return path.join(app.getPath('userData'), 'ulyzer-memory');
}

function courseMemoryDir(courseId: string): string {
  return path.join(memoryRoot(), courseId);
}

function indexPath(courseId: string): string {
  return path.join(courseMemoryDir(courseId), 'MEMORY.md');
}

function memoryFilePath(courseId: string, filename: string): string {
  return path.join(courseMemoryDir(courseId), 'memory', filename);
}

function ensureDirs(courseId: string): void {
  fs.mkdirSync(path.join(courseMemoryDir(courseId), 'memory'), { recursive: true });
}

// ── Per-session memoize cache ─────────────────────────────────────────────────

const cache = new Map<string, { value: string; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — one study session

function cacheGet(key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, { value, at: Date.now() });
}

/** Invalidate cached memory so the next load picks up fresh writes. */
export function invalidateMemoryCache(courseId: string): void {
  cache.delete(courseId);
}

// ── Load ──────────────────────────────────────────────────────────────────────

const MAX_MEMORY_CHARS = 3000;

/**
 * Load the student memory index for a course.
 * Returns an empty string if no memory exists yet.
 * Result is memoized for the session duration.
 */
export function loadStudentMemory(courseId: string): string {
  const cached = cacheGet(courseId);
  if (cached !== undefined) return cached;

  try {
    const idx = fs.readFileSync(indexPath(courseId), 'utf8');
    const value = idx.length > MAX_MEMORY_CHARS
      ? idx.slice(0, MAX_MEMORY_CHARS) + '\n\n[...记忆内容过长，已截断]'
      : idx;
    cacheSet(courseId, value);
    return value;
  } catch {
    cacheSet(courseId, '');
    return '';
  }
}

function rebuildIndex(courseId: string): void {
  const lines: string[] = [
    `# 学生记忆索引（${courseId}）`,
    `更新时间：${new Date().toISOString().slice(0, 16)}`,
    '',
    '## 文件',
    '- [mastery.md](memory/mastery.md) — 各节点掌握度',
    '- [weaknesses.md](memory/weaknesses.md) — 易错点与薄弱概念',
    '',
    '## 近期薄弱点摘要',
  ];

  try {
    const weak = fs.readFileSync(memoryFilePath(courseId, 'weaknesses.md'), 'utf8');
    const recent = weak.split('\n').filter(Boolean).slice(-8);
    lines.push(...recent);
  } catch { /* no weakness file yet */ }

  fs.writeFileSync(indexPath(courseId), lines.join('\n') + '\n', 'utf8');
}

// ── Prompt injection helper ───────────────────────────────────────────────────

/**
 * Returns a memory context string ready to prepend to the dynamic user message.
 * Empty string if no memory exists yet.
 */
export function buildMemoryContext(courseId: string): string {
  const memory = loadStudentMemory(courseId);
  if (!memory) return '';
  return `[学生学习记忆]\n${memory}\n`;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Append newly identified weaknesses to weaknesses.md.
 * Trims the file to the most recent 100 lines if it exceeds that limit.
 * Fire-and-forget safe — errors are logged but not thrown.
 */
export function updateStudentWeaknesses(
  courseId: string,
  nodeId: string,
  nodeName: string,
  weaknesses: string[],
): void {
  if (weaknesses.length === 0) return;
  try {
    ensureDirs(courseId);
    const filePath = memoryFilePath(courseId, 'weaknesses.md');
    const date = new Date().toISOString().slice(0, 10);
    const entry = [
      '',
      `## ${date} — ${nodeName}（${nodeId}）`,
      ...weaknesses.map((w) => `- ${w}`),
      '',
    ].join('\n');

    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf-8');
    }

    let newContent = (existing || '# 薄弱点记录') + entry;
    const lines = newContent.split('\n');
    if (lines.length > 100) {
      newContent = lines.slice(lines.length - 100).join('\n');
    }
    fs.writeFileSync(filePath, newContent, 'utf-8');
    invalidateMemoryCache(courseId);
    rebuildIndex(courseId);
  } catch (err) {
    log.error('updateStudentWeaknesses failed', { error: String(err) });
  }
}
