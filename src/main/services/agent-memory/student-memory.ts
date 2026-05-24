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
 * - Output is injected as a dynamic user message, keeping the static system prompt
 *   cacheable by Anthropic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

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
