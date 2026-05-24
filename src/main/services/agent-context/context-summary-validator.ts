import type { ThreadMessageRow } from '../db/repositories/chat-thread-context.repo';

export interface MustKeepItem {
  text: string;
  reason: 'correction' | 'constraint' | 'file' | 'todo' | 'goal';
  messageId: string;
}

export interface ContextSummaryValidation {
  score: number;
  missingFacts: string[];
  conflicts: string[];
  mustKeepItems: MustKeepItem[];
}

const MUST_KEEP_RE =
  /必须|不要|不能|以后|一直|记住|纠正|更正|不是.+是|目标|计划|未完成|下一步|TODO|todo|must|never|always|remember|correct|correction|not .+ but|goal|next step/i;
const FILE_RE =
  /(?:[A-Za-z0-9_\-.]+\.(?:md|txt|json|ts|tsx|js|jsx|py|pdf|docx|pptx|xlsx)|(?:\/[^\s，。；,;]+){2,})/g;

function compact(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function sentenceCandidates(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])|\n+/)
    .map((part) => compact(part, 240))
    .filter((part) => part.length >= 6);
}

function itemReason(text: string): MustKeepItem['reason'] {
  if (/不是.+是|纠正|更正|correct|correction|not .+ but/i.test(text)) return 'correction';
  if (/必须|不要|不能|以后|一直|记住|must|never|always|remember/i.test(text)) return 'constraint';
  if (/未完成|下一步|TODO|todo|next step/i.test(text)) return 'todo';
  if (/目标|计划|goal/i.test(text)) return 'goal';
  return 'file';
}

function normalizedContains(haystack: string, needle: string): boolean {
  const cleanHaystack = haystack.toLowerCase().replace(/\s+/g, ' ');
  const cleanNeedle = needle.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!cleanNeedle) return true;
  if (cleanHaystack.includes(cleanNeedle)) return true;
  const words = cleanNeedle
    .split(/[^\p{L}\p{N}_./-]+/u)
    .filter((word) => word.length >= 2)
    .slice(0, 8);
  if (words.length === 0) return true;
  const hits = words.filter((word) => cleanHaystack.includes(word)).length;
  return hits / words.length >= 0.65;
}

export function extractMustKeepItems(rows: ThreadMessageRow[], limit = 24): MustKeepItem[] {
  const items: MustKeepItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.role !== 'user') continue;
    for (const sentence of sentenceCandidates(row.content)) {
      if (!MUST_KEEP_RE.test(sentence)) continue;
      const text = compact(sentence);
      if (seen.has(text)) continue;
      seen.add(text);
      items.push({ text, reason: itemReason(text), messageId: row.id });
      if (items.length >= limit) return items;
    }
    for (const match of row.content.matchAll(FILE_RE)) {
      const text = compact(match[0], 180);
      if (seen.has(text)) continue;
      seen.add(text);
      items.push({ text, reason: 'file', messageId: row.id });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

export function validateContextSummary(summary: string, rows: ThreadMessageRow[]): ContextSummaryValidation {
  const mustKeepItems = extractMustKeepItems(rows);
  const missingFacts = mustKeepItems
    .filter((item) => !normalizedContains(summary, item.text))
    .map((item) => item.text);
  const score = mustKeepItems.length === 0
    ? 1
    : Math.max(0, 1 - missingFacts.length / mustKeepItems.length);
  return {
    score,
    missingFacts,
    conflicts: [],
    mustKeepItems,
  };
}

export function appendMissingMustKeeps(summary: string, validation: ContextSummaryValidation, language?: string): string {
  if (validation.missingFacts.length === 0) return summary;
  const title = language === 'en'
    ? 'Must preserve from the original transcript'
    : '必须保留的原始对话要点';
  return [
    summary.trim(),
    '',
    `${title}:`,
    ...validation.missingFacts.map((item) => `- ${item}`),
  ].join('\n');
}
