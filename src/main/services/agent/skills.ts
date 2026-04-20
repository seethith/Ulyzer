/**
 * Skills system — Markdown-defined reusable prompts for the SubTutor.
 *
 * Each skill is a Markdown file with YAML frontmatter:
 *
 *   ---
 *   name: generate-quiz
 *   description: 为学习节点生成练习题
 *   whenToUse: 学生要求练习或自我测试时
 *   ---
 *
 *   你是出题助手。根据节点内容生成 ${count} 道 ${difficulty} 难度的练习题…
 *
 * Skills are loaded from (in order, later overrides earlier same-name):
 *   1. Built-in skills bundled with the app (resources/skills/builtin/)
 *   2. User custom skills (userData/ulyzer-skills/custom/)
 *
 * Usage: applySkillArgs(skill.prompt, { count: '5', difficulty: 'beginner' })
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Skill {
  name:        string;
  description: string;
  whenToUse:   string;
  /** Raw prompt template, may contain ${variable} placeholders */
  prompt:      string;
  source:      'builtin' | 'user';
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function builtinSkillsDir(): string {
  // In production, resources/ is at process.resourcesPath
  // In development, it's at the project root
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), '..', '..');
  return path.join(base, 'resources', 'skills', 'builtin');
}

function userSkillsDir(): string {
  return path.join(app.getPath('userData'), 'ulyzer-skills', 'custom');
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

function parseSkillFile(filePath: string, source: 'builtin' | 'user'): Skill | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.name) return null;
    return {
      name:        meta.name,
      description: meta.description ?? '',
      whenToUse:   meta.whenToUse ?? meta.when_to_use ?? '',
      prompt:      body,
      source,
    };
  } catch {
    return null;
  }
}

function loadSkillsFromDir(dir: string, source: 'builtin' | 'user'): Skill[] {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    return files
      .map((f) => parseSkillFile(path.join(dir, f), source))
      .filter((s): s is Skill => s !== null);
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Deduplicate skills by name; later entries win (user overrides builtin). */
function dedup(skills: Skill[]): Skill[] {
  const map = new Map<string, Skill>();
  for (const s of skills) map.set(s.name, s);
  return [...map.values()];
}

/**
 * Load all available skills (builtin + user custom).
 * User custom skills with the same name override builtin ones.
 */
export function loadSkills(): Skill[] {
  const builtin = loadSkillsFromDir(builtinSkillsDir(), 'builtin');
  const user    = loadSkillsFromDir(userSkillsDir(),    'user');
  return dedup([...builtin, ...user]);
}

/**
 * Find a skill by name. Returns null if not found.
 */
export function findSkill(name: string): Skill | null {
  return loadSkills().find((s) => s.name === name) ?? null;
}

/**
 * Substitute ${variable} placeholders in a skill prompt.
 *
 * Example: applySkillArgs('生成 ${count} 道题', { count: '5' })
 *          → '生成 5 道题'
 */
export function applySkillArgs(template: string, args: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => args[key] ?? `[${key}]`);
}
