import type { SourceRecord, SourceSemanticProfile } from '@shared/types';

const STATUS_LABELS: Record<SourceSemanticProfile['status'], string> = {
  pending: '正在分析',
  ready: '已分析',
  failed: '分析失败',
  skipped: '已跳过',
};

function compactText(value: string | null | undefined, max: number): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactList(items: string[] | undefined, maxItems: number, maxItemChars = 28): string | null {
  const cleaned = (items ?? [])
    .map((item) => compactText(item, maxItemChars))
    .filter((item): item is string => Boolean(item));
  if (cleaned.length === 0) return null;
  const shown = cleaned.slice(0, maxItems);
  const suffix = cleaned.length > shown.length ? ` 等 ${cleaned.length} 项` : '';
  return `${shown.join('、')}${suffix}`;
}

export function formatSourceSemanticProfileForAgent(
  source: Pick<SourceRecord, 'semanticProfile'>,
  options: { includeUnavailable?: boolean; maxItems?: number } = {},
): string | null {
  const profile = source.semanticProfile;
  if (!profile) return null;

  const includeUnavailable = options.includeUnavailable ?? true;
  const maxItems = options.maxItems ?? 6;
  if (profile.status !== 'ready') {
    if (!includeUnavailable) return null;
    const reason = compactText(profile.error, 120);
    return [
      `AI 概览：${STATUS_LABELS[profile.status]}`,
      reason ? `原因：${reason}` : null,
    ].filter(Boolean).join('\n');
  }

  const lines = [
    'AI 概览（资料语义预处理；用于先判断资料是否值得展开，不是用户备注）：',
    compactText(profile.summary, 220) ? `摘要：${compactText(profile.summary, 220)}` : null,
    compactList(profile.concepts, maxItems) ? `核心概念：${compactList(profile.concepts, maxItems)}` : null,
    compactList(profile.suitableFor, Math.min(maxItems, 5)) ? `适合用途：${compactList(profile.suitableFor, Math.min(maxItems, 5))}` : null,
    compactText(profile.difficulty, 40) ? `难度：${compactText(profile.difficulty, 40)}` : null,
    compactList(profile.contentTypes, Math.min(maxItems, 5)) ? `内容类型：${compactList(profile.contentTypes, Math.min(maxItems, 5))}` : null,
    compactList(profile.nodeHints, Math.min(maxItems, 5), 36) ? `节点提示：${compactList(profile.nodeHints, Math.min(maxItems, 5), 36)}` : null,
    compactText(profile.qualityNotes, 140) ? `质量提示：${compactText(profile.qualityNotes, 140)}` : null,
  ].filter(Boolean);

  return lines.length > 1 ? lines.join('\n') : null;
}
