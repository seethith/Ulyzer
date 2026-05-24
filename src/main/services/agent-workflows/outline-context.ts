import * as fs from 'fs';
import * as path from 'path';
import type { OutlineVersionSelection } from '@shared/types';
import { getLatestOutlinePath, getOutlineDirPath } from '../fs/content.service';
import { readOutlineVersionText } from './outline-version';

export type OutlineArtifactKind = 'theory' | 'practice' | 'review' | 'topic' | 'mindmap' | 'generic';

export interface KcEntry {
  id: string;
  name: string;
}

export interface ArtifactOutlineContext {
  text: string;
  path: string | null;
  versionLabel: string;
  primaryVersion: OutlineVersionSelection | undefined;
  kcSourceText: string;
  kcSourceVersion: OutlineVersionSelection | undefined;
}

export interface BuildArtifactOutlineContextOptions {
  courseId: string;
  nodeId: string;
  artifactKind: OutlineArtifactKind;
  outlineVersion?: OutlineVersionSelection;
  language?: string;
  kcId?: string;
  kcName?: string;
}

const VERSION_LABELS: Record<1 | 2 | 3, { zh: string; en: string }> = {
  1: { zh: 'v1 学习蓝图（KC、边界、掌握证据）', en: 'v1 Learning Blueprint (KCs, boundaries, mastery evidence)' },
  2: { zh: 'v2 实践与出题蓝图（题型、变式、补练规则）', en: 'v2 Practice & Exercise Blueprint (exercise types, variations, remediation)' },
  3: { zh: 'v3 复盘与深化蓝图（自检、误解修复、迁移问题）', en: 'v3 Review & Deepening Blueprint (self-check, repair, transfer)' },
};

/** Parse KC IDs and names from a KC-model outline (`### KC1: name`). */
export function parseKcsFromOutline(text: string): KcEntry[] {
  const entries: KcEntry[] = [];
  const re = /^###\s+(KC\d+)\s*[:：]\s*(.+)$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    entries.push({ id: m[1], name: m[2].trim() });
  }
  return entries;
}

function outlineVersionFromSelection(selection?: OutlineVersionSelection): 1 | 2 | 3 | undefined {
  if (selection === 'v1') return 1;
  if (selection === 'v2') return 2;
  if (selection === 'v3') return 3;
  return undefined;
}

export function explicitlyRequestsOutlineVersion(text: string | undefined, selection?: OutlineVersionSelection): boolean {
  if (!text || !selection || selection === 'latest') return false;
  const version = selection.replace(/^v/i, '');
  const normalized = text.replace(/\s+/g, ' ');
  const versionToken = `v\\s*${version}\\b`;
  return [
    new RegExp(`(?:outline|纲要|大纲|蓝图)\\s*(?:version\\s*)?${versionToken}`, 'i'),
    new RegExp(`${versionToken}\\s*(?:outline|纲要|大纲|蓝图)`, 'i'),
    new RegExp(`(?:按|基于|依据|使用|用|按照|from|based\\s+on|use)\\s*(?:当前|最新|latest)?\\s*(?:outline|纲要|大纲|蓝图)?\\s*${versionToken}`, 'i'),
    new RegExp(`用户指定了纲要版本\\s*${versionToken}`, 'i'),
  ].some((re) => re.test(normalized));
}

export function normalizeOutlineVersionForArtifact(input: {
  artifactKind: OutlineArtifactKind;
  outlineVersion?: OutlineVersionSelection;
  userMessage?: string;
}): OutlineVersionSelection | undefined {
  if (!input.outlineVersion || input.outlineVersion === 'latest') return undefined;
  if (explicitlyRequestsOutlineVersion(input.userMessage, input.outlineVersion)) return input.outlineVersion;

  // The three outline files are not sequential material generations anymore:
  // v1 drives theory, v2 drives practice, and v3 drives review. If the model
  // invents an outline_version without the user explicitly asking for it, fall
  // back to the artifact's default blueprint order.
  if (input.artifactKind === 'theory' || input.artifactKind === 'practice' || input.artifactKind === 'review') {
    return undefined;
  }
  return input.outlineVersion;
}

function selectionFromVersion(version: 1 | 2 | 3 | undefined): OutlineVersionSelection | undefined {
  return version ? (`v${version}` as OutlineVersionSelection) : undefined;
}

function getOutlinePathForSelection(
  courseId: string,
  nodeId: string,
  selection?: OutlineVersionSelection,
): string | null {
  if (!selection || selection === 'latest') return getLatestOutlinePath(courseId, nodeId);
  const outlinePath = path.join(getOutlineDirPath(courseId, nodeId), `_outline_${selection}.md`);
  return fs.existsSync(outlinePath) ? outlinePath : null;
}

function readSelectedOutlineText(
  courseId: string,
  nodeId: string,
  selection?: OutlineVersionSelection,
): { text: string; path: string | null; version: OutlineVersionSelection | undefined } {
  const outlinePath = getOutlinePathForSelection(courseId, nodeId, selection);
  const text = outlinePath
    ? (() => { try { return fs.readFileSync(outlinePath, 'utf-8').trim(); } catch { return ''; } })()
    : '';
  const match = outlinePath ? path.basename(outlinePath).match(/_outline_(v[1-3])\.md/) : null;
  return { text, path: outlinePath, version: (match?.[1] as OutlineVersionSelection | undefined) ?? undefined };
}

function localText(language: string | undefined, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}

function clampText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trim()}\n\n...`;
}

function extractSectionsByHeadingKeywords(text: string, keywords: RegExp[], maxChars: number): string {
  const lines = text.split('\n');
  const sections: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^##\s+/.test(line) || !keywords.some((keyword) => keyword.test(line))) continue;
    const block: string[] = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s+/.test(lines[j])) break;
      block.push(lines[j]);
    }
    sections.push(block.join('\n').trim());
  }
  return sections.length > 0 ? clampText(sections.join('\n\n'), maxChars) : clampText(text, maxChars);
}

function extractKcSection(text: string, kcId?: string, kcName?: string): string {
  const normalizedName = kcName?.trim();
  const headingRe = /^###\s+(KC\d+)\s*[:：]\s*(.+)$/mg;
  const matches: Array<{ index: number; end: number; id: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ index: m.index, end: headingRe.lastIndex, id: m[1], name: m[2].trim() });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const nameMatches = normalizedName && match.name.includes(normalizedName);
    if (match.id !== kcId && !nameMatches) continue;
    const next = matches[i + 1]?.index ?? text.length;
    return text.slice(match.index, next).trim();
  }
  return '';
}

function extractKcNearbyLines(text: string, kcId?: string, kcName?: string): string {
  const keys = [kcId, kcName?.trim()].filter(Boolean) as string[];
  if (keys.length === 0) return '';
  const lines = text.split('\n');
  const selected = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!keys.some((key) => lines[i].includes(key))) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j += 1) {
      selected.add(j);
    }
  }
  return [...selected].sort((a, b) => a - b).map((i) => lines[i]).join('\n').trim();
}

function focusForKind(kind: OutlineArtifactKind, isPrimary: boolean, text: string): string {
  if (isPrimary) return clampText(text, kind === 'topic' ? 6_000 : 14_000);
  if (kind === 'theory') {
    return extractSectionsByHeadingKeywords(text, [
      /目标|Goals|Boundary|边界/i,
      /核心|Knowledge|Evidence|掌握/i,
      /题型|Practice|Exercise/i,
    ], 5_000);
  }
  if (kind === 'practice') {
    return extractSectionsByHeadingKeywords(text, [
      /目标|Goals|Boundary|边界/i,
      /核心|Knowledge|KC/i,
      /掌握|Evidence|误解|Diagnosis|复盘|Review/i,
    ], 6_000);
  }
  if (kind === 'review') {
    return extractSectionsByHeadingKeywords(text, [
      /核心|Knowledge|KC/i,
      /掌握|Evidence|Diagnosis|误解/i,
      /错误|Remediation|补练|Practice/i,
    ], 6_000);
  }
  if (kind === 'mindmap') {
    return extractSectionsByHeadingKeywords(text, [
      /目标|Goals/i,
      /核心|Knowledge|KC/i,
      /关系|Relation|Flow|流程/i,
    ], 6_000);
  }
  return clampText(text, 6_000);
}

function extractTopicVersionText(text: string, version: 1 | 2 | 3, kcId?: string, kcName?: string): string {
  const section = extractKcSection(text, kcId, kcName);
  const nearby = extractKcNearbyLines(text, kcId, kcName);
  const focused = [section, nearby].filter(Boolean).join('\n\n');
  if (focused.trim()) return clampText(focused, version === 1 ? 5_000 : 4_000);
  return clampText(text, version === 1 ? 2_000 : 1_500);
}

function defaultVersionOrder(kind: OutlineArtifactKind): Array<1 | 2 | 3> {
  if (kind === 'practice') return [2, 1, 3];
  if (kind === 'review') return [3, 1, 2];
  if (kind === 'topic') return [1, 2, 3];
  if (kind === 'mindmap') return [1, 2];
  return [1, 2];
}

function labelFor(version: 1 | 2 | 3, isPrimary: boolean, language?: string): string {
  const base = localText(language, VERSION_LABELS[version].zh, VERSION_LABELS[version].en);
  return isPrimary
    ? localText(language, `${base}（主依据）`, `${base} (primary)`)
    : localText(language, `${base}（辅助）`, `${base} (support)`);
}

function buildLabeledBlock(label: string, text: string): string {
  return text.trim() ? `## ${label}\n\n${text.trim()}` : '';
}

export function buildOutlineContextForArtifact(options: BuildArtifactOutlineContextOptions): ArtifactOutlineContext {
  const requestedVersion = outlineVersionFromSelection(options.outlineVersion);
  const order = requestedVersion
    ? [requestedVersion, ...defaultVersionOrder(options.artifactKind).filter((version) => version !== requestedVersion)]
    : defaultVersionOrder(options.artifactKind);
  const primaryVersion = order[0];
  const v1 = readOutlineVersionText(options.courseId, options.nodeId, 1);
  const texts: Record<1 | 2 | 3, string> = {
    1: v1,
    2: readOutlineVersionText(options.courseId, options.nodeId, 2),
    3: readOutlineVersionText(options.courseId, options.nodeId, 3),
  };

  const parts = order.flatMap((version) => {
    const raw = texts[version];
    if (!raw.trim()) return [];
    const isPrimary = version === primaryVersion;
    const hasFocus = Boolean(options.kcId || options.kcName?.trim());
    const body = options.artifactKind === 'topic' || (options.artifactKind === 'mindmap' && hasFocus)
      ? extractTopicVersionText(raw, version, options.kcId, options.kcName)
      : focusForKind(options.artifactKind, isPrimary, raw);
    return buildLabeledBlock(labelFor(version, isPrimary, options.language), body);
  }).filter(Boolean);

  const selected = requestedVersion
    ? readSelectedOutlineText(options.courseId, options.nodeId, options.outlineVersion)
    : readSelectedOutlineText(options.courseId, options.nodeId, 'latest');
  const text = parts.join('\n\n---\n\n') || selected.text;
  const includedVersions = order.filter((version) => texts[version].trim());
  return {
    text,
    path: selected.path,
    versionLabel: includedVersions.length > 0
      ? includedVersions.map((version) => `v${version}`).join('+')
      : selected.version ?? 'none',
    primaryVersion: selectionFromVersion(primaryVersion),
    kcSourceText: v1 || selected.text,
    kcSourceVersion: v1 ? 'v1' : selected.version,
  };
}
