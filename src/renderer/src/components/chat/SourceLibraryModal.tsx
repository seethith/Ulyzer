import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronUp, ExternalLink, Link, Pencil, RotateCw, Search, Trash2, Upload, X } from 'lucide-react';
import i18n from '../../i18n';
import { IPC } from '@shared/ipc-channels';
import {
  SOURCE_LIBRARY_FILE_ACCEPT,
} from '@shared/attachment-formats';
import type {
  AgentType,
  IpcResponse,
  PickedLocalFile,
  ResearchTaskType,
  SourceExercise,
  SourceExerciseStatus,
  SourceLibraryStats,
  SourceRecord,
  SourceScope,
  SourceSearchResult,
} from '@shared/types';

interface RefLibraryModalProps {
  open: boolean;
  onClose: () => void;
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
}

type VisibleScope = 'main_private' | 'node_private';
type ImportDialogType = 'url' | 'file' | 'text' | 'collect' | 'main';
type LibraryViewMode = 'sources' | 'exercises';

type ReadyTone = 'ready' | 'pending' | 'warning';

interface LibraryStatusIssue {
  key: string;
  label: string;
  detail: string;
  tone: 'normal' | 'warning';
  items: string[];
}

interface LibraryStatus {
  title: string;
  detail: string;
  tone: 'normal' | 'warning';
  problemSources: SourceRecord[];
  pendingSources: SourceRecord[];
  issues: LibraryStatusIssue[];
}

interface CollectedWebResult {
  title: string;
  url: string;
  content: string;
  trustScore: number;
  publishedDate?: string;
  sourceTier?: CollectSourceTier;
  riskLevel?: CollectRiskLevel;
  riskReasons?: string[];
  trustLevel?: string;
  provider?: 'tavily' | 'exa' | 'library' | 'reflection';
  normalizedUrl?: string;
  recommended?: boolean;
}

type CollectRiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type CollectSourceTier =
  | 'canonical'
  | 'vetted_education'
  | 'scholarly'
  | 'supplemental'
  | 'community'
  | 'library_upload'
  | 'library_generated'
  | 'unknown'
  | 'risky';

interface PendingLocalFile {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

function tabsForAgent(agentType: AgentType): Array<{ key: VisibleScope; label: string }> {
  return agentType === 'main_tutor'
    ? [
        { key: 'main_private', label: i18n.t('source_library.tab_main_private') },
      ]
    : [
        { key: 'node_private', label: i18n.t('source_library.tab_node_private') },
      ];
}

function canEditScope(agentType: AgentType, scope: VisibleScope): boolean {
  if (agentType === 'main_tutor') return scope === 'main_private';
  return scope === 'node_private';
}

function canToggleSource(agentType: AgentType, source: SourceRecord): boolean {
  if (source.linkedToNode) return true;
  if (agentType === 'main_tutor') return source.scope === 'main_private';
  return source.scope === 'node_private';
}

function canRemoveSource(agentType: AgentType, source: SourceRecord): boolean {
  if (source.linkedToNode) return true;
  if (agentType === 'main_tutor') return source.scope === 'main_private';
  return source.scope === 'node_private';
}

function canEditSourceMetadata(agentType: AgentType, source: SourceRecord): boolean {
  if (source.linkedToNode) return false;
  if (agentType === 'main_tutor') return source.scope === 'main_private';
  return source.scope === 'node_private';
}

function sourceVisibleScope(source: SourceRecord): SourceScope {
  return source.displayScope ?? (source.linkedToNode ? 'node_private' : source.scope);
}

function sourceReadyTone(source: SourceRecord): ReadyTone {
  if ((source.documentOcrFailedCount ?? 0) > 0) return 'warning';
  if ((source.documentOcrPendingCount ?? 0) > 0) return 'pending';
  if (source.processingState === 'limited') return 'warning';
  if (source.processingState === 'failed') return 'warning';
  if (source.processingState === 'pending' || source.processingState === 'partial') return 'pending';
  if (source.processingError) return 'warning';
  if (source.embeddingStatus === 'failed') return 'warning';
  return 'ready';
}

function hasPendingDocumentWork(source: SourceRecord): boolean {
  return source.processingState === 'pending'
    || source.processingState === 'partial'
    || (source.documentOcrPendingCount ?? 0) > 0;
}

function hasProblemDocumentWork(source: SourceRecord): boolean {
  if (hasPendingDocumentWork(source)) return false;
  return source.processingState === 'failed'
    || Boolean(source.processingError)
    || source.embeddingStatus === 'failed'
    || (source.documentOcrFailedCount ?? 0) > 0;
}

function isRetryableSource(source: SourceRecord): boolean {
  return Boolean(source.processingError)
    || source.processingState === 'failed'
    || source.processingState === 'pending'
    || source.processingState === 'partial'
    || source.embeddingStatus === 'failed'
    || (source.documentOcrPendingCount ?? 0) > 0
    || (source.documentOcrFailedCount ?? 0) > 0;
}

function pendingStatusLabel(source: SourceRecord): string {
  const pendingOcr = source.documentOcrPendingCount ?? 0;
  if (pendingOcr > 0) return i18n.t('source_library.ocr_pages', { count: pendingOcr });
  if (source.processingError?.includes('OCR')) return i18n.t('source_library.ocr_running');
  return i18n.t('source_library.preparing');
}

function sourceReadyLabel(source: SourceRecord): string {
  if ((source.documentOcrFailedCount ?? 0) > 0) return i18n.t('source_library.ocr_failed_count', { count: source.documentOcrFailedCount });
  if ((source.documentOcrPendingCount ?? 0) > 0) return pendingStatusLabel(source);
  if (source.processingState === 'limited') return isVideoLinkSource(source) ? i18n.t('source_library.metadata_only') : i18n.t('source_library.link_only');
  if (source.processingState === 'failed') return i18n.t('source_library.needs_fix');
  if (source.processingState === 'pending' || source.processingState === 'partial') return pendingStatusLabel(source);
  if (source.processingError) return i18n.t('source_library.needs_fix');
  if (source.embeddingStatus === 'failed') return i18n.t('source_library.needs_fix');
  return i18n.t('source_library.ready');
}

function readyBadgeStyle(source: SourceRecord): React.CSSProperties {
  const tone = sourceReadyTone(source);
  if (tone === 'warning') {
    return {
      ...badgeStyle,
      color: 'var(--warning, #b7791f)',
      background: 'rgba(245, 158, 11, 0.12)',
      borderColor: 'rgba(245, 158, 11, 0.28)',
    };
  }
  if (tone === 'pending') {
    return {
      ...badgeStyle,
      color: 'var(--accent)',
      background: 'rgba(59, 130, 246, 0.12)',
      borderColor: 'rgba(59, 130, 246, 0.22)',
    };
  }
  return {
    ...badgeStyle,
    color: 'rgb(22, 101, 52)',
    background: 'rgba(34, 197, 94, 0.10)',
    borderColor: 'rgba(34, 197, 94, 0.22)',
  };
}

function sourceDisplayName(source: SourceRecord): string {
  return source.title || source.filePath || source.url || i18n.t('source_library.untitled');
}

function isVideoLinkSource(source: SourceRecord): boolean {
  const media = (source.mediaType ?? '').toLowerCase();
  return media.includes('video-link') || media.includes('youtube');
}

function itemList(items: string[], limit = 3): string {
  return `${items.slice(0, limit).join('、')}${items.length > limit ? '…' : ''}`;
}

function sourceIssueReason(source: SourceRecord): string {
  const reasons = [
    source.processingState === 'limited' ? (isVideoLinkSource(source) ? i18n.t('source_library.metadata_only_available') : i18n.t('source_library.link_metadata_only')) : '',
    source.processingState === 'failed' ? i18n.t('source_library.parse_failed') : '',
    source.processingError ? source.processingError : '',
    source.embeddingStatus === 'failed' ? i18n.t('source_library.index_failed') : '',
    (source.documentOcrFailedCount ?? 0) > 0 ? i18n.t('source_library.ocr_failed_units', { count: source.documentOcrFailedCount }) : '',
  ].filter(Boolean);
  return reasons.join('；') || i18n.t('source_library.status_abnormal');
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildDuplicateTitleIssues(sources: SourceRecord[]): LibraryStatusIssue[] {
  const groups = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    const key = normalizeTitle(source.title);
    if (key.length < 6) continue;
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  const duplicates = [...groups.values()].filter((items) => items.length > 1);
  if (duplicates.length === 0) return [];
  const items = duplicates.map((group) => `${sourceDisplayName(group[0])} ×${group.length}`);
  return [{
    key: 'duplicate-title',
    label: i18n.t('source_library.dup_title_count', { count: duplicates.length }),
    detail: i18n.t('source_library.dup_title_detail', { items: itemList(items) }),
    tone: 'warning',
    items,
  }];
}

function buildDuplicateHostIssues(sources: SourceRecord[]): LibraryStatusIssue[] {
  const groups = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    if (!source.host) continue;
    groups.set(source.host, [...(groups.get(source.host) ?? []), source]);
  }
  const duplicates = [...groups.entries()].filter(([, items]) => items.length > 1);
  if (duplicates.length === 0) return [];
  const items = duplicates.map(([host, group]) => `${host} ×${group.length}：${itemList(group.map(sourceDisplayName), 2)}`);
  return [{
    key: 'duplicate-host',
    label: i18n.t('source_library.dup_host_count', { count: duplicates.length }),
    detail: i18n.t('source_library.dup_host_detail', { items: itemList(items) }),
    tone: 'warning',
    items,
  }];
}

function buildQualityIssues(sources: SourceRecord[], stats: SourceLibraryStats | null): LibraryStatusIssue[] {
  const issues: LibraryStatusIssue[] = [];
  const lowQuality = sources
    .filter((source) => source.kind === 'web' && source.trustScore < 0.6)
    .map((source) => i18n.t('source_library.low_trust_item', { name: sourceDisplayName(source), score: source.trustScore.toFixed(2) }));
  if (lowQuality.length >= 3 || (stats?.lowQualitySources ?? 0) >= 3) {
    issues.push({
      key: 'low-quality-web',
      label: i18n.t('source_library.low_trust_count', { count: lowQuality.length || stats?.lowQualitySources || 0 }),
      detail: i18n.t('source_library.low_trust_detail', { items: itemList(lowQuality) }),
      tone: 'warning',
      items: lowQuality,
    });
  }

  if (stats && (stats.totalSources >= 24 || stats.chunkCount >= 1800)) {
    issues.push({
      key: 'too-many',
      label: i18n.t('source_library.many_sources'),
      detail: i18n.t('source_library.many_sources_detail', { sources: stats.totalSources, chunks: stats.chunkCount }),
      tone: 'warning',
      items: stats.archiveCandidateTitles.length > 0
        ? stats.archiveCandidateTitles.map((title) => i18n.t('source_library.archive_candidate_item', { title }))
        : [i18n.t('source_library.cleanup_hint')],
    });
  }

  if (stats && stats.archiveCandidateCount > 0 && issues.every((issue) => issue.key !== 'too-many')) {
    issues.push({
      key: 'archive-candidate',
      label: i18n.t('source_library.archive_candidate_count', { count: stats.archiveCandidateCount }),
      detail: i18n.t('source_library.archive_candidate_detail', { items: itemList(stats.archiveCandidateTitles) }),
      tone: 'warning',
      items: stats.archiveCandidateTitles,
    });
  }
  return issues;
}

function sourceOriginLabel(source: SourceRecord): string {
  switch (source.origin) {
    case 'chat_attachment': return i18n.t('source_library.origin_attachment');
    case 'web_collected': return i18n.t('source_library.origin_auto');
    case 'ai_generated': return i18n.t('source_library.origin_ai');
    case 'user_import':
    default: return i18n.t('source_library.origin_user');
  }
}

function buildOriginIssues(sources: SourceRecord[]): LibraryStatusIssue[] {
  const groups: Array<{ key: string; label: string; origin: SourceRecord['origin']; warnAt: number }> = [
    { key: 'origin-user', label: i18n.t('source_library.origin_user'), origin: 'user_import', warnAt: Number.POSITIVE_INFINITY },
    { key: 'origin-chat', label: i18n.t('source_library.origin_attachment_group'), origin: 'chat_attachment', warnAt: 12 },
    { key: 'origin-web', label: i18n.t('source_library.origin_auto_group'), origin: 'web_collected', warnAt: 8 },
    { key: 'origin-ai', label: i18n.t('source_library.origin_ai_group'), origin: 'ai_generated', warnAt: 10 },
  ];
  return groups.flatMap((group) => {
    const matched = sources.filter((source) => source.origin === group.origin);
    if (matched.length === 0) return [];
    const names = matched.map(sourceDisplayName);
    const warning = matched.length >= group.warnAt;
    if (!warning) return [];
    return [{
      key: group.key,
      label: i18n.t('source_library.origin_group_many', { group: group.label, count: matched.length }),
      detail: `${group.label}：${itemList(names)}`,
      tone: 'warning',
      items: names,
    } satisfies LibraryStatusIssue];
  });
}

function buildLibraryStatus(sources: SourceRecord[]): LibraryStatus {
  const problemSources = sources.filter(hasProblemDocumentWork);
  const pendingSources = sources.filter(hasPendingDocumentWork);
  const problemItems = problemSources.map((source) => `${sourceDisplayName(source)}（${sourceIssueReason(source)}）`);
  const pendingItems = pendingSources.map((source) => `${sourceDisplayName(source)}（${pendingStatusLabel(source)}）`);

  if (problemSources.length > 0) {
    return {
      title: i18n.t('source_library.problem_title', { count: problemSources.length }),
      detail: i18n.t('source_library.problem_detail', { items: itemList(problemItems) }),
      tone: 'warning',
      problemSources,
      pendingSources,
      issues: [{
        key: 'processing-problem',
        label: i18n.t('source_library.problem_count', { count: problemSources.length }),
        detail: i18n.t('source_library.problem_detail', { items: itemList(problemItems) }),
        tone: 'warning',
        items: problemItems,
      }],
    };
  }

  if (pendingSources.length > 0) {
    return {
      title: i18n.t('source_library.preparing_title', { count: pendingSources.length }),
      detail: i18n.t('source_library.preparing_detail', { items: itemList(pendingItems, 2) }),
      tone: 'normal',
      problemSources,
      pendingSources,
      issues: [{
        key: 'processing-pending',
        label: i18n.t('source_library.processing_count', { count: pendingSources.length }),
        detail: i18n.t('source_library.processing_detail', { items: itemList(pendingItems) }),
        tone: 'normal',
        items: pendingItems,
      }],
    };
  }

  if (sources.length > 0) {
    return {
      title: i18n.t('source_library.lib_ready'),
      detail: i18n.t('source_library.lib_ready_desc'),
      tone: 'normal',
      problemSources,
      pendingSources,
      issues: [],
    };
  }

  return {
    title: i18n.t('source_library.lib_empty'),
    detail: i18n.t('source_library.lib_empty_desc'),
    tone: 'normal',
    problemSources,
    pendingSources,
    issues: [],
  };
}

function enhanceLibraryStatus(
  base: LibraryStatus,
  stats: SourceLibraryStats | null,
  sources: SourceRecord[],
): LibraryStatus {
  const issues = [
    ...base.issues,
    ...buildOriginIssues(sources),
    ...buildDuplicateTitleIssues(sources),
    ...buildDuplicateHostIssues(sources),
    ...buildQualityIssues(sources, stats),
  ];
  const warningIssues = issues.filter((issue) => issue.tone === 'warning');
  if (base.problemSources.length > 0 || base.pendingSources.length > 0) return { ...base, issues };

  if (warningIssues.length > 0) {
    const first = warningIssues[0];
    return {
      ...base,
      title: warningIssues.length === 1 ? first.label : i18n.t('source_library.warning_summary', { count: warningIssues.length }),
      detail: warningIssues.map((issue) => issue.detail).join('；'),
      tone: 'warning',
      issues,
    };
  }

  return { ...base, issues };
}

function sourceMediaLabel(source: SourceRecord): string {
  const media = (source.mediaType ?? '').toLowerCase();
  const title = (source.title ?? source.filePath ?? '').toLowerCase();
  if (source.kind === 'generated') return i18n.t('source_library.origin_ai');
  if (media.includes('site=bilibili')) return 'Bilibili';
  if (media.includes('site=youtube') || media.includes('youtube')) return 'YouTube';
  if (media.includes('site=vimeo')) return 'Vimeo';
  if (media.includes('site=tiktok')) return 'TikTok';
  if (media.includes('site=douyin')) return i18n.t('source_library.media_douyin');
  if (media.includes('site=xigua')) return i18n.t('source_library.media_xigua');
  if (media.includes('site=acfun')) return 'AcFun';
  if (media.includes('site=niconico')) return 'Niconico';
  if (media.includes('site=dailymotion')) return 'Dailymotion';
  if (media.includes('site=ted')) return 'TED';
  if (media.includes('site=khanacademy')) return 'Khan';
  if (media.includes('site=coursera')) return 'Coursera';
  if (media.includes('site=edx')) return 'edX';
  if (media.includes('video-link')) return i18n.t('source_library.media_video');
  if (media.includes('pdf')) return 'PDF';
  if (media.includes('wordprocessingml') || media.includes('docx')) return 'DOCX';
  if (media.includes('presentationml') || media.includes('pptx')) return 'PPTX';
  if (media.includes('spreadsheetml') || media.includes('xlsx')) return 'XLSX';
  if (media.includes('rtf')) return 'RTF';
  if (media.includes('epub')) return 'EPUB';
  if (media.includes('opendocument.text') || media.includes('odt')) return 'ODT';
  if (media.includes('opendocument.spreadsheet') || media.includes('ods')) return 'ODS';
  if (media.includes('opendocument.presentation') || media.includes('odp')) return 'ODP';
  if (media.includes('opml')) return 'OPML';
  if (media.includes('freemind') || media.includes('mm')) return 'MM';
  if (media.includes('xmind')) return 'XMind';
  if (media.includes('csv') || title.endsWith('.csv')) return 'CSV';
  if (media.includes('tab-separated-values') || media.includes('tsv') || title.endsWith('.tsv')) return 'TSV';
  if (media.startsWith('image/')) return i18n.t('source_library.media_image');
  if (media.startsWith('audio/')) return i18n.t('source_library.media_audio');
  if (media.startsWith('video/')) return i18n.t('source_library.media_video');
  if (media.startsWith('text/') || source.kind === 'upload') return i18n.t('source_library.media_text');
  if (source.kind === 'web') return i18n.t('source_library.media_web');
  return i18n.t('source_library.media_reference');
}

function sourceOriginBadgeStyle(source: SourceRecord): React.CSSProperties {
  if (source.origin === 'web_collected') {
    return {
      ...badgeStyle,
      color: 'rgb(146, 64, 14)',
      background: 'rgba(245, 158, 11, 0.08)',
      borderColor: 'rgba(245, 158, 11, 0.20)',
    };
  }
  if (source.origin === 'chat_attachment') {
    return {
      ...badgeStyle,
      color: 'rgb(29, 78, 216)',
      background: 'rgba(59, 130, 246, 0.08)',
      borderColor: 'rgba(59, 130, 246, 0.18)',
    };
  }
  if (source.origin === 'ai_generated') {
    return {
      ...badgeStyle,
      color: 'rgb(107, 33, 168)',
      background: 'rgba(168, 85, 247, 0.08)',
      borderColor: 'rgba(168, 85, 247, 0.18)',
    };
  }
  return badgeStyle;
}

function sourceDocumentBadges(source: SourceRecord): Array<{ label: string; tone?: ReadyTone; title?: string }> {
  const badges: Array<{ label: string; tone?: ReadyTone; title?: string }> = [];
  if ((source.documentUnitCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.doc_units_short', { count: source.documentUnitCount }),
      title: i18n.t('source_library.doc_units_title', { count: source.documentUnitCount }),
    });
  }
  if ((source.documentBlockCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.doc_blocks_short', { count: source.documentBlockCount }),
      title: i18n.t('source_library.doc_blocks_title', { count: source.documentBlockCount }),
    });
  }
  if ((source.documentOcrPendingCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.ocr_pending_short', { count: source.documentOcrPendingCount }),
      tone: 'pending',
      title: i18n.t('source_library.ocr_pending_title', { count: source.documentOcrPendingCount }),
    });
  }
  if ((source.documentOcrFailedCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.ocr_failed_count', { count: source.documentOcrFailedCount }),
      tone: 'warning',
      title: i18n.t('source_library.ocr_failed_title', { count: source.documentOcrFailedCount }),
    });
  }
  if ((source.documentPageAssetCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.page_assets_short', { count: source.documentPageAssetCount }),
      title: i18n.t('source_library.page_assets_title', { count: source.documentPageAssetCount }),
    });
  }
  if ((source.exerciseCount ?? 0) > 0) {
    badges.push({
      label: i18n.t('source_library.exercise_short', { count: source.usableExerciseCount ?? source.exerciseCount }),
      tone: (source.usableExerciseCount ?? 0) > 0 ? 'ready' : 'warning',
      title: i18n.t('source_library.exercise_title', { total: source.exerciseCount, usable: source.usableExerciseCount ?? 0, withAnswer: source.exerciseWithAnswerCount ?? 0 }),
    });
  }
  return badges;
}

function semanticUsageLabel(value: string): string {
  const map: Record<string, string> = {
    route_planning: i18n.t('source_library.usage_route'),
    theory_material: i18n.t('source_library.usage_theory'),
    practice_generation: i18n.t('source_library.usage_practice'),
    project_case: i18n.t('source_library.usage_project'),
    official_reference: i18n.t('source_library.usage_official'),
    background_reading: i18n.t('source_library.usage_extended'),
    troubleshooting: i18n.t('source_library.usage_debug'),
    assessment: i18n.t('source_library.usage_assessment'),
  };
  return map[value] ?? value;
}

function semanticContentTypeLabel(value: string): string {
  const map: Record<string, string> = {
    concept_explanation: i18n.t('source_library.content_concept'),
    examples: i18n.t('source_library.content_example'),
    exercises: i18n.t('source_library.content_exercise'),
    solutions: i18n.t('source_library.content_answer'),
    code: i18n.t('source_library.content_code'),
    formulas: i18n.t('source_library.content_formula'),
    tables: i18n.t('source_library.content_table'),
    figures: i18n.t('source_library.content_diagram'),
    syllabus: i18n.t('source_library.content_outline'),
    case_study: i18n.t('source_library.content_case'),
    reference: i18n.t('source_library.content_reference_doc'),
  };
  return map[value] ?? value;
}

function semanticStatusLabel(source: SourceRecord): string {
  const status = source.semanticProfile?.status;
  if (status === 'ready') return i18n.t('source_library.semantic_analyzed');
  if (status === 'pending') return i18n.t('source_library.semantic_analyzing');
  if (status === 'failed') return i18n.t('source_library.semantic_failed');
  if (status === 'skipped') return i18n.t('source_library.semantic_skipped');
  return i18n.t('source_library.semantic_unanalyzed');
}

function semanticBadgeStyle(status?: string): React.CSSProperties {
  if (status === 'ready') return documentBadgeStyle('ready');
  if (status === 'pending') return documentBadgeStyle('pending');
  if (status === 'failed') return documentBadgeStyle('warning');
  return badgeStyle;
}

function inferCollectTaskType(query: string): ResearchTaskType {
  if (/路线|课程|大纲|教学大纲|学习路径|roadmap|syllabus|curriculum|outline/i.test(query)) return 'roadmap';
  if (/练习|题目|习题|实践|作业|评分|rubric|practice|exercise|problem|assignment/i.test(query)) return 'practice';
  if (/答案|解析|answer|solution/i.test(query)) return 'answer';
  if (/最新|版本|api|release|current|latest/i.test(query)) return 'freshness';
  return 'theory';
}

function collectTierLabel(tier?: CollectSourceTier): string {
  switch (tier) {
    case 'canonical': return i18n.t('source_library.tier_authority');
    case 'vetted_education': return i18n.t('source_library.tier_education');
    case 'scholarly': return i18n.t('source_library.tier_academic');
    case 'supplemental': return i18n.t('source_library.tier_supplement');
    case 'community': return i18n.t('source_library.tier_community');
    case 'library_upload': return i18n.t('source_library.tier_library');
    case 'library_generated': return i18n.t('source_library.tier_ai');
    case 'risky': return i18n.t('source_library.tier_risk');
    case 'unknown':
    default: return i18n.t('source_library.tier_general');
  }
}

function collectRiskLabel(level?: CollectRiskLevel): string {
  switch (level) {
    case 'low': return i18n.t('source_library.risk_low');
    case 'medium': return i18n.t('source_library.risk_check');
    case 'high': return i18n.t('source_library.risk_high');
    case 'blocked': return i18n.t('source_library.risk_blocked');
    default: return i18n.t('source_library.risk_unrated');
  }
}

function collectTrustLabel(result: CollectedWebResult): string {
  const score = Number.isFinite(result.trustScore) ? result.trustScore : 0;
  return i18n.t('source_library.trust_pct', { pct: Math.round(score * 100) });
}

function collectHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function collectSnippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function collectRiskBadgeStyle(level?: CollectRiskLevel): React.CSSProperties {
  if (level === 'low') {
    return {
      ...badgeStyle,
      color: 'rgb(22, 101, 52)',
      background: 'rgba(34, 197, 94, 0.10)',
      borderColor: 'rgba(34, 197, 94, 0.22)',
    };
  }
  if (level === 'medium') return documentBadgeStyle('warning');
  if (level === 'high' || level === 'blocked') {
    return {
      ...badgeStyle,
      color: 'rgb(185, 28, 28)',
      background: 'rgba(239, 68, 68, 0.10)',
      borderColor: 'rgba(239, 68, 68, 0.24)',
    };
  }
  return badgeStyle;
}

function documentBadgeStyle(tone?: ReadyTone): React.CSSProperties {
  if (tone === 'pending') {
    return {
      ...badgeStyle,
      color: 'var(--accent)',
      background: 'rgba(59, 130, 246, 0.08)',
      borderColor: 'rgba(59, 130, 246, 0.18)',
    };
  }
  if (tone === 'warning') {
    return {
      ...badgeStyle,
      color: 'var(--warning, #b7791f)',
      background: 'rgba(245, 158, 11, 0.10)',
      borderColor: 'rgba(245, 158, 11, 0.24)',
    };
  }
  return badgeStyle;
}

export const RefLibraryModal: React.FC<RefLibraryModalProps> = ({
  open,
  onClose,
  courseId,
  nodeId,
  agentType,
}) => {
  // Subscribe so the modal re-renders on language change; helpers read i18n.t directly.
  const { i18n: i18nInstance } = useTranslation();
  const tabs = useMemo(() => tabsForAgent(agentType), [agentType, i18nInstance.language]);
  const [activeTab, setActiveTab] = useState<VisibleScope>(tabs[0].key);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [viewMode, setViewMode] = useState<LibraryViewMode>('sources');
  const [url, setUrl] = useState('');
  const [urlRemark, setUrlRemark] = useState('');
  const [fileRemark, setFileRemark] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteRemark, setPasteRemark] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SourceSearchResult[]>([]);
  const [sourceExercises, setSourceExercises] = useState<SourceExercise[]>([]);
  const [exerciseStatusFilter, setExerciseStatusFilter] = useState<'usable' | 'all'>('usable');
  const [exerciseBusy, setExerciseBusy] = useState(false);
  const [stats, setStats] = useState<SourceLibraryStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [importDialog, setImportDialog] = useState<ImportDialogType | null>(null);
  const [collectQuery, setCollectQuery] = useState('');
  const [collectTarget, setCollectTarget] = useState('');
  const [collectRemark, setCollectRemark] = useState('');
  const [collectedResults, setCollectedResults] = useState<CollectedWebResult[]>([]);
  const [collectBusy, setCollectBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingLocalFile[]>([]);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [mainSourceQuery, setMainSourceQuery] = useState('');
  const [mainSourceCandidates, setMainSourceCandidates] = useState<SourceRecord[]>([]);
  const [selectedMainSourceIds, setSelectedMainSourceIds] = useState<string[]>([]);
  const [mainSourceBusy, setMainSourceBusy] = useState(false);
  const [mainSourceError, setMainSourceError] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<SourceRecord | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const [reanalyzingSourceIds, setReanalyzingSourceIds] = useState<string[]>([]);
  const [extractingSourceIds, setExtractingSourceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(tabs[0].key);
    setUrl('');
    setUrlRemark('');
    setFileRemark('');
    setPasteTitle('');
    setPasteRemark('');
    setPasteContent('');
    setQuery('');
    setSearchResults([]);
    setSourceExercises([]);
    setViewMode('sources');
    setExerciseStatusFilter('usable');
    setExerciseBusy(false);
    setImportDialog(null);
    setCollectQuery('');
    setCollectTarget('');
    setCollectRemark('');
    setCollectedResults([]);
    setPendingFiles([]);
    setStatusExpanded(false);
    setMainSourceQuery('');
    setMainSourceCandidates([]);
    setSelectedMainSourceIds([]);
    setMainSourceBusy(false);
    setMainSourceError(null);
    setEditingSource(null);
    setEditTitle('');
    setEditRemark('');
    setReanalyzingSourceIds([]);
    setExtractingSourceIds([]);
  }, [open, tabs]);

  const editable = canEditScope(agentType, activeTab);

  const loadSources = useCallback(async () => {
    if (!open) return;
    const res = await window.api.invoke(IPC.SOURCE_LIST, {
      courseId,
      nodeId,
      agentType,
      scope: activeTab,
    }) as IpcResponse<SourceRecord[]>;
    if (res.success) setSources(res.data ?? []);
  }, [open, courseId, nodeId, agentType, activeTab]);

  useEffect(() => {
    loadSources().catch(() => {});
  }, [loadSources]);

  const loadStats = useCallback(async () => {
    if (!open) return;
    const res = await window.api.invoke(IPC.SOURCE_STATS, {
      courseId,
      nodeId,
      agentType,
      scope: activeTab,
    }) as IpcResponse<SourceLibraryStats>;
    if (res.success) setStats(res.data ?? null);
  }, [open, courseId, nodeId, agentType, activeTab]);

  useEffect(() => {
    loadStats().catch(() => {});
  }, [loadStats]);

  const loadSourceExercises = useCallback(async (value = query) => {
    if (!open) return;
    setExerciseBusy(true);
    try {
      const res = await window.api.invoke(IPC.SOURCE_EXERCISES, {
        courseId,
        nodeId,
        agentType,
        scope: activeTab,
        query: value.trim() || undefined,
        onlyUsable: exerciseStatusFilter === 'usable',
        limit: 120,
      }) as IpcResponse<SourceExercise[]>;
      if (res.success) setSourceExercises(res.data ?? []);
    } finally {
      setExerciseBusy(false);
    }
  }, [open, query, courseId, nodeId, agentType, activeTab, exerciseStatusFilter]);

  useEffect(() => {
    if (!open || viewMode !== 'exercises') return;
    loadSourceExercises().catch(() => {});
  }, [open, viewMode, loadSourceExercises]);

  const loadMainSourceCandidates = useCallback(async (value = mainSourceQuery) => {
    if (!open || agentType !== 'sub_tutor' || !nodeId) return;
    setMainSourceBusy(true);
    try {
      const res = await window.api.invoke(IPC.SOURCE_LINK_CANDIDATES, {
        courseId,
        nodeId,
        query: value.trim() || undefined,
        limit: 80,
      }) as IpcResponse<SourceRecord[]>;
      if (res.success) {
        setMainSourceCandidates(res.data ?? []);
        setMainSourceError(null);
      } else {
        setMainSourceCandidates([]);
        setMainSourceError(res.error ?? i18n.t('source_library.load_main_failed'));
      }
    } catch (error) {
      setMainSourceCandidates([]);
      setMainSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMainSourceBusy(false);
    }
  }, [open, agentType, courseId, nodeId, mainSourceQuery]);

  useEffect(() => {
    if (importDialog !== 'main') return;
    loadMainSourceCandidates().catch(() => {});
  }, [importDialog, loadMainSourceCandidates]);

  const searchLibrary = useCallback(async (value = query) => {
    const trimmed = value.trim();
    setQuery(value);
    if (!trimmed) {
      setSearchResults([]);
        return;
      }
      const res = await window.api.invoke(IPC.SOURCE_SEARCH, {
      courseId,
      nodeId,
      agentType,
      scope: activeTab,
      query: trimmed,
      limit: 8,
    }) as IpcResponse<SourceSearchResult[]>;
    if (res.success) setSearchResults(res.data ?? []);
  }, [query, courseId, nodeId, agentType, activeTab]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (viewMode === 'exercises') {
      loadSourceExercises(value).catch(() => {});
      return;
    }
    searchLibrary(value).catch(() => {});
  }, [viewMode, loadSourceExercises, searchLibrary]);

  useEffect(() => {
    if (!open) return;
    const hasPending = sources.some((source) =>
      source.processingState === 'pending'
      || source.processingState === 'partial'
      || source.semanticProfile?.status === 'pending',
    );
    if (!hasPending) return;
    const timer = window.setInterval(() => {
      loadSources().catch(() => {});
      loadStats().catch(() => {});
      if (query.trim()) searchLibrary(query).catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [open, sources, loadSources, loadStats, query, searchLibrary]);

  const importUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed || !editable) return;
    setBusy(true);
    try {
      const res = await window.api.invoke(IPC.SOURCE_IMPORT_URL, {
        courseId,
        nodeId: activeTab === 'node_private' ? nodeId : undefined,
        scope: activeTab,
        url: trimmed,
        remark: urlRemark.trim() || undefined,
      }) as IpcResponse<SourceRecord>;
      if (res.success) {
        setUrl('');
        setUrlRemark('');
        setImportDialog(null);
        await loadSources();
        await loadStats();
      }
    } finally {
      setBusy(false);
    }
  };

  const queuePickedFiles = (files: PickedLocalFile[]) => {
    if (!files.length || !editable) return;
    const staged = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.path}-${Math.random().toString(36).slice(2, 7)}`,
      path: file.path,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
    }));
    setPendingFiles((current) => {
      const seen = new Set(current.map((item) => `${item.name}:${item.size}:${item.path}`));
      return [
        ...current,
        ...staged.filter((item) => !seen.has(`${item.name}:${item.size}:${item.path}`)),
      ];
    });
  };

  const chooseLocalFiles = async () => {
    if (!editable || busy) return;
    const res = await window.api.invoke(IPC.FS_PICK_FILES, {
      accept: SOURCE_LIBRARY_FILE_ACCEPT,
      multiple: true,
      title: i18n.t('source_library.pick_local'),
    }) as IpcResponse<PickedLocalFile[]>;
    if (res.success) queuePickedFiles(res.data ?? []);
  };

  const removePendingFile = (id: string) => {
    setPendingFiles((current) => current.filter((item) => item.id !== id));
  };

  const importPendingFiles = async () => {
    if (!pendingFiles.length || !editable) return;
    setBusy(true);
    try {
      for (const item of pendingFiles) {
        await window.api.invoke(IPC.SOURCE_IMPORT_FILE, {
          courseId,
          nodeId: activeTab === 'node_private' ? nodeId : undefined,
          scope: activeTab,
          title: item.name,
          remark: fileRemark.trim() || undefined,
          originalPath: item.path,
          filePath: item.path,
          mimeType: item.mimeType || '',
        });
      }
      await loadSources();
      await loadStats();
      setFileRemark('');
      setPendingFiles([]);
      setImportDialog(null);
      if (viewMode === 'exercises') await loadSourceExercises(query);
    } finally {
      setBusy(false);
    }
  };

  const importPastedText = async () => {
    const content = pasteContent.trim();
    if (!content || !editable) return;
    setBusy(true);
    try {
      await window.api.invoke(IPC.SOURCE_IMPORT_TEXT, {
        courseId,
        nodeId: activeTab === 'node_private' ? nodeId : undefined,
        scope: activeTab,
        title: pasteTitle.trim() || i18n.t('source_library.paste_text'),
        remark: pasteRemark.trim() || undefined,
        content,
        mimeType: 'text/plain',
      });
      setPasteTitle('');
      setPasteRemark('');
      setPasteContent('');
      setImportDialog(null);
      await loadSources();
      await loadStats();
      if (viewMode === 'exercises') await loadSourceExercises(query);
    } finally {
      setBusy(false);
    }
  };

  const replaceSourceInLocalState = useCallback((nextSource: SourceRecord) => {
    setSources((current) => current.map((item) => (
      item.id === nextSource.id
        ? { ...item, ...nextSource }
        : item
    )));
    setSearchResults((current) => current.map((result) => (
      result.source.id === nextSource.id
        ? { ...result, source: { ...result.source, ...nextSource } }
        : result
    )));
  }, []);

  const toggleSource = async (source: SourceRecord) => {
    if (!canToggleSource(agentType, source)) return;
    const res = source.linkedToNode && nodeId
      ? await window.api.invoke(IPC.SOURCE_LINK_UPDATE, {
        courseId,
        nodeId,
        sourceId: source.id,
        enabled: !source.enabled,
      }) as IpcResponse<SourceRecord | null>
      : await window.api.invoke(IPC.SOURCE_UPDATE, source.id, { enabled: !source.enabled }) as IpcResponse<SourceRecord>;
    if (res.success && res.data) {
      replaceSourceInLocalState(res.data);
    }
    await loadStats();
  };

  const beginEditSource = (source: SourceRecord) => {
    if (!canEditSourceMetadata(agentType, source) || busy) return;
    setEditingSource(source);
    setEditTitle(source.title ?? '');
    setEditRemark(source.remark ?? '');
  };

  const saveSourceMetadata = async () => {
    if (!editingSource || !canEditSourceMetadata(agentType, editingSource)) return;
    const title = editTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      const remark = editRemark.trim();
      const res = await window.api.invoke(IPC.SOURCE_UPDATE, editingSource.id, {
        title,
        remark: remark || null,
      }) as IpcResponse<SourceRecord>;
      if (res.success && res.data) {
        replaceSourceInLocalState(res.data);
        setEditingSource(null);
        setEditTitle('');
        setEditRemark('');
        await loadStats();
        if (query.trim()) await searchLibrary(query);
      }
    } finally {
      setBusy(false);
    }
  };

  const rebuildSemanticProfile = async (source: SourceRecord) => {
    if (reanalyzingSourceIds.includes(source.id)) return;
    setReanalyzingSourceIds((current) => [...current, source.id]);
    try {
      const res = await window.api.invoke(IPC.SOURCE_SEMANTIC_PROFILE_REBUILD, {
        sourceId: source.id,
        force: true,
      }) as IpcResponse<SourceRecord | null>;
      if (res.success && res.data) {
        replaceSourceInLocalState(res.data);
      } else {
        await loadSources();
      }
    } finally {
      setReanalyzingSourceIds((current) => current.filter((id) => id !== source.id));
    }
  };

  const reextractSourceExercises = async (source: SourceRecord) => {
    if (extractingSourceIds.includes(source.id)) return;
    setExtractingSourceIds((current) => [...current, source.id]);
    try {
      await window.api.invoke(IPC.SOURCE_EXERCISE_REEXTRACT, {
        sourceId: source.id,
        force: true,
      });
      await loadSources();
      await loadStats();
      if (viewMode === 'exercises') await loadSourceExercises(query);
    } finally {
      setExtractingSourceIds((current) => current.filter((id) => id !== source.id));
    }
  };

  const updateExerciseStatus = async (exercise: SourceExercise, status: SourceExerciseStatus) => {
    const res = await window.api.invoke(IPC.SOURCE_EXERCISE_UPDATE, {
      exerciseId: exercise.id,
      status,
    }) as IpcResponse<SourceExercise | null>;
    if (res.success && res.data) {
      setSourceExercises((current) => current.map((item) => item.id === exercise.id ? res.data! : item));
    } else {
      await loadSourceExercises(query);
    }
    await loadSources();
    await loadStats();
  };

  const openSourceExternally = async (source: SourceRecord) => {
    if (source.url) {
      await window.api.invoke(IPC.SHELL_OPEN_URL, source.url);
      return;
    }
    if (source.originalPath) {
      await window.api.invoke(IPC.FS_OPEN_PATH, source.originalPath);
      return;
    }
    if (source.filePath) {
      await window.api.invoke(IPC.FS_OPEN_PATH, source.filePath);
    }
  };

  const openCollectedResult = async (result: CollectedWebResult) => {
    await window.api.invoke(IPC.SHELL_OPEN_URL, result.url);
  };

  const removeSource = async (source: SourceRecord) => {
    if (!canRemoveSource(agentType, source)) return;
    if (source.linkedToNode && nodeId) {
      await window.api.invoke(IPC.SOURCE_LINK_REMOVE, {
        courseId,
        nodeId,
        sourceId: source.id,
      });
    } else {
      await window.api.invoke(IPC.SOURCE_DELETE, source.id);
    }
    await loadSources();
    await loadStats();
  };

  const refreshOrRepairLibrary = async () => {
    setBusy(true);
    try {
      const problematicSources = sources.filter(isRetryableSource);
      for (const source of problematicSources) {
        await window.api.invoke(IPC.SOURCE_REINDEX, { sourceId: source.id, force: true });
      }
      await loadSources();
      await loadStats();
      if (query.trim()) await searchLibrary(query);
    } finally {
      setBusy(false);
    }
  };

  const runCollectSearch = async () => {
    const base = collectQuery.trim();
    const target = collectTarget.trim();
    if (!base) return;
    setCollectBusy(true);
    try {
      const searchText = target ? `${base} ${target}` : base;
      const res = await window.api.invoke(IPC.WEB_SEARCH, searchText, {
        searchDepth: 'basic',
        maxResults: 8,
        learningSource: true,
        taskType: inferCollectTaskType(searchText),
      }) as IpcResponse<CollectedWebResult[]>;
      if (res.success) {
        setCollectedResults(res.data ?? []);
      } else {
        setCollectedResults([]);
      }
    } finally {
      setCollectBusy(false);
    }
  };

  const removeCollectedResult = (urlToRemove: string) => {
    setCollectedResults((current) => current.filter((result) => result.url !== urlToRemove));
  };

  const importCollectedResults = async () => {
    if (!collectedResults.length) return;
    setCollectBusy(true);
    try {
      for (const result of collectedResults) {
        await window.api.invoke(IPC.SOURCE_IMPORT_URL, {
          courseId,
          nodeId: activeTab === 'node_private' ? nodeId : undefined,
          scope: activeTab,
          origin: 'web_collected',
          url: result.url,
          title: result.title,
          remark: collectRemark.trim() || collectTarget.trim() || undefined,
          searchExcerpt: result.content,
          trustScore: result.trustScore,
          query: collectQuery.trim(),
        });
      }
      setCollectQuery('');
      setCollectTarget('');
      setCollectRemark('');
      setCollectedResults([]);
      setImportDialog(null);
      await loadSources();
      await loadStats();
      if (query.trim()) await searchLibrary(query);
    } finally {
      setCollectBusy(false);
    }
  };

  const toggleMainSourceSelection = (sourceId: string) => {
    setSelectedMainSourceIds((current) => (
      current.includes(sourceId)
        ? current.filter((id) => id !== sourceId)
        : [...current, sourceId]
    ));
  };

  const importSelectedMainSources = async () => {
    if (!nodeId || selectedMainSourceIds.length === 0) return;
    setMainSourceBusy(true);
    try {
      const res = await window.api.invoke(IPC.SOURCE_LINK_ADD, {
        courseId,
        nodeId,
        sourceIds: selectedMainSourceIds,
        reason: 'node_library_import',
      }) as IpcResponse<SourceRecord[]>;
      if (res.success) {
        setSelectedMainSourceIds([]);
        setMainSourceQuery('');
        setMainSourceCandidates([]);
        setMainSourceError(null);
        setImportDialog(null);
        await loadSources();
        await loadStats();
        if (query.trim()) await searchLibrary(query);
      } else {
        setMainSourceError(res.error ?? i18n.t('source_library.import_main_failed'));
      }
    } catch (error) {
      setMainSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setMainSourceBusy(false);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  const scopedSources = sources.filter((source) => sourceVisibleScope(source) === activeTab);
  const visibleSources = (query.trim()
    ? searchResults.map((result) => result.source)
    : scopedSources).filter((source) => sourceVisibleScope(source) === activeTab);
  const libraryStatus = enhanceLibraryStatus(buildLibraryStatus(scopedSources), stats, scopedSources);
  const retryableSourceCount = scopedSources.filter(isRetryableSource).length;
  const canImportMainSources = agentType === 'sub_tutor' && activeTab === 'node_private' && Boolean(nodeId);

  return createPortal(
    <div
      className="ui-animated-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.38)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        className="ui-animated-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, calc(100vw - 64px))',
          height: 'min(760px, calc(100vh - 48px))',
          position: 'relative',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <style>
          {`
            @keyframes ulyzerSpin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            @keyframes ulyzerPulse {
              0%, 100% { opacity: 0.42; }
              50% { opacity: 1; }
            }
          `}
        </style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 8px', borderBottom: '1px solid var(--border)' }}>
          <BookOpen size={15} style={{ color: 'var(--accent)' }} />
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{i18n.t('source_library.header')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
            {tabs.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => { setActiveTab(tab.key); setQuery(''); setSearchResults([]); setStatusExpanded(false); }}
                  style={{
                    border: '1px solid ' + (active ? 'var(--accent-b)' : 'var(--border)'),
                    background: active ? 'var(--accent-s)' : 'var(--surface2)',
                    color: active ? 'var(--accent)' : 'var(--text2)',
                    borderRadius: 20,
                    padding: '4px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'var(--sans)',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
            {([
              ['sources', i18n.t('source_library.tab_sources')],
              ['exercises', `${i18n.t('source_library.tab_exercises')}${stats?.exerciseCount ? ` ${stats.usableExerciseCount}/${stats.exerciseCount}` : ''}`],
            ] as Array<[LibraryViewMode, string]>).map(([mode, label]) => {
              const active = viewMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setViewMode(mode);
                    setQuery('');
                    setSearchResults([]);
                    if (mode === 'exercises') loadSourceExercises('').catch(() => {});
                  }}
                  style={{
                    border: '1px solid ' + (active ? 'var(--accent-b)' : 'var(--border)'),
                    background: active ? 'var(--accent-s)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text3)',
                    borderRadius: 8,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'var(--sans)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--text3)', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{
          padding: '8px 14px 10px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            justifyContent: 'space-between',
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {libraryStatus.pendingSources.length > 0 ? (
                  <RotateCw
                    size={13}
                    style={{ color: 'var(--accent)', animation: 'ulyzerSpin 1.3s linear infinite', flexShrink: 0 }}
                  />
                ) : libraryStatus.problemSources.length > 0 || libraryStatus.tone === 'warning' ? (
                  <AlertTriangle size={13} style={{ color: 'var(--warning, #b7791f)', flexShrink: 0 }} />
                ) : (
                  <Check size={13} style={{ color: 'rgb(22, 101, 52)', flexShrink: 0 }} />
                )}
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: libraryStatus.tone === 'warning' ? 'var(--warning, #b7791f)' : 'var(--text)',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {libraryStatus.title}
                </div>
                {libraryStatus.issues.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setStatusExpanded((value) => !value)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text3)',
                      padding: '1px 3px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: 'var(--sans)',
                      flexShrink: 0,
                    }}
                  >
                    {statusExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {statusExpanded ? i18n.t('source_library.collapse') : i18n.t('source_library.details')}
                  </button>
                ) : null}
              </div>
              <div
                title={libraryStatus.detail}
                style={{
                  fontSize: 11,
                  color: 'var(--text3)',
                  marginTop: 4,
                  lineHeight: 1.5,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {libraryStatus.detail}
              </div>
            </div>
            {retryableSourceCount > 0 ? (
              <button
                onClick={() => refreshOrRepairLibrary().catch(() => {})}
                disabled={busy}
                title={i18n.t('source_library.retry_tooltip', { count: retryableSourceCount })}
                style={{
                  ...textButtonStyle,
                  flexShrink: 0,
                  opacity: busy ? 0.55 : 1,
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                <RotateCw size={13} />
                {i18n.t('source_library.retry_button')}
              </button>
            ) : null}
          </div>
          {statusExpanded && libraryStatus.issues.length > 0 ? (
            <div style={{
              marginTop: 9,
              maxHeight: 168,
              overflowY: 'auto',
              paddingRight: 4,
            }}>
              {libraryStatus.issues.map((issue) => (
                <div key={issue.key} style={{
                  padding: '5px 0',
                  borderTop: '1px solid var(--border)',
                  minWidth: 0,
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    color: issue.tone === 'warning' ? 'var(--warning, #b7791f)' : 'var(--text)',
                  }}>
                    {issue.tone === 'warning' ? <AlertTriangle size={11} /> : <RotateCw size={11} />}
                    {issue.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.55, marginTop: 5 }}>
                    {issue.items.map((item, index) => (
                      <div key={`${issue.key}-${index}`} title={item} style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
            <button
              type="button"
              onClick={() => editable && setImportDialog('url')}
              disabled={!editable || busy}
              style={launchButtonStyle(editable && !busy)}
            >
              <Link size={13} />
              {i18n.t('source_library.import_url')}
            </button>
            <button
              type="button"
              onClick={() => editable && setImportDialog('text')}
              disabled={!editable || busy}
              style={launchButtonStyle(editable && !busy)}
            >
              <Upload size={13} />
              {i18n.t('source_library.import_text')}
            </button>
            <button
              type="button"
              onClick={() => editable && setImportDialog('file')}
              disabled={!editable || busy}
              style={launchButtonStyle(editable && !busy)}
            >
              <Upload size={13} />
              {i18n.t('source_library.local_reference')}
            </button>
            <button
              type="button"
              onClick={() => editable && setImportDialog('collect')}
              disabled={!editable || busy}
              style={launchButtonStyle(editable && !busy)}
            >
              <Search size={13} />
              {i18n.t('source_library.web_collect')}
            </button>
            {canImportMainSources ? (
              <button
                type="button"
                onClick={() => editable && setImportDialog('main')}
                disabled={!editable || busy}
                style={launchButtonStyle(editable && !busy)}
              >
                <BookOpen size={13} />
                {i18n.t('source_library.import_main')}
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          <div style={{ padding: '0 14px 8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Search size={13} style={{ color: 'var(--text3)', flexShrink: 0 }} />
              <input
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder={viewMode === 'exercises' ? i18n.t('source_library.search_exercises_ph') : i18n.t('source_library.search_library_ph')}
                style={inputStyle}
              />
              {viewMode === 'exercises' ? (
                <button
                  type="button"
                  onClick={() => {
                    setExerciseStatusFilter((current) => current === 'usable' ? 'all' : 'usable');
                  }}
                  style={textButtonStyle}
                  title={i18n.t('source_library.toggle_usable_title')}
                >
                  {exerciseStatusFilter === 'usable' ? i18n.t('source_library.only_usable') : i18n.t('source_library.show_all')}
                </button>
              ) : null}
            </div>
          </div>
          {viewMode === 'exercises' ? (
            sourceExercises.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.7 }}>
                {exerciseBusy ? i18n.t('source_library.loading_exercises') : i18n.t('source_library.exercises_empty')}
              </div>
            ) : sourceExercises.map((exercise) => (
              <div key={exercise.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={documentBadgeStyle(exercise.status === 'usable' ? 'ready' : 'warning')}>
                        {exercise.status === 'usable' ? i18n.t('source_library.ready') : exercise.status === 'blocked' ? i18n.t('source_library.disabled') : i18n.t('source_library.pending_review')}
                      </span>
                      <span style={badgeStyle}>{exercise.itemType}</span>
                      <span style={badgeStyle}>{exercise.difficulty}</span>
                      <span style={badgeStyle}>{i18n.t('source_library.quality')} {exercise.qualityScore.toFixed(2)}</span>
                      {exercise.answerMd ? <span style={badgeStyle}>{i18n.t('source_library.has_answer')}</span> : null}
                      {exercise.solutionMd ? <span style={badgeStyle}>{i18n.t('source_library.has_solution')}</span> : null}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {exercise.sourceTitle ?? exercise.sourceUrl ?? i18n.t('source_library.media_reference')}{exercise.sourceLocator ? ` · ${exercise.sourceLocator}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateExerciseStatus(exercise, exercise.status === 'blocked' ? 'usable' : 'blocked').catch(() => {})}
                    style={actionGridButtonStyle(true)}
                    title={exercise.status === 'blocked' ? i18n.t('source_library.enable_exercise') : i18n.t('source_library.disable_exercise')}
                  >
                    {exercise.status === 'blocked' ? <Check size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
                <div style={{
                  marginTop: 8,
                  fontSize: 12,
                  color: 'var(--text)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 130,
                  overflow: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--surface2)',
                  padding: 9,
                }}>
                  {exercise.stemMd}
                </div>
              </div>
            ))
          ) : visibleSources.length === 0 ? (
            <div style={{ padding: '18px 16px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.7 }}>
              {query.trim() ? i18n.t('source_library.no_matching_chunks') : i18n.t('source_library.no_sources_hint')}
            </div>
          ) : visibleSources.map((source) => {
            const isPending = hasPendingDocumentWork(source);
            const isProblem = hasProblemDocumentWork(source);
            const documentBadges = sourceDocumentBadges(source);
            const canRemove = canRemoveSource(agentType, source) && !busy;
            const canToggle = canToggleSource(agentType, source) && !busy;
            const canEditMetadata = canEditSourceMetadata(agentType, source) && !busy;
            const canOpenExternal = Boolean(source.url || source.originalPath || source.filePath);
            const semanticProfile = source.semanticProfile;
            const learningMetadata = source.learningMetadata ?? [];
            const semanticBusy = reanalyzingSourceIds.includes(source.id) || semanticProfile?.status === 'pending';
            return (
              <div
                key={source.id}
                style={{
                  padding: '8px 14px',
                  borderBottom: '1px solid var(--border)',
                  opacity: isPending ? 0.82 : 1,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12,
                      color: 'var(--text)',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {source.title}
                    </div>
                    <div style={{
                      marginTop: 3,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      minWidth: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                    }}>
                      {source.remark ? (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--text3)',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {source.remark}
                        </span>
                      ) : null}
                      <span style={badgeStyle}>{sourceMediaLabel(source)}</span>
                      <span style={sourceOriginBadgeStyle(source)}>{sourceOriginLabel(source)}</span>
                      {source.linkedToNode ? (
                        <span style={badgeStyle}>{i18n.t('source_library.from_main')}</span>
                      ) : null}
                      {documentBadges.map((badge) => (
                        <span key={badge.label} title={badge.title} style={documentBadgeStyle(badge.tone)}>
                          {badge.label}
                        </span>
                      ))}
                      <span style={readyBadgeStyle(source)}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {isPending ? (
                            <RotateCw size={10} style={{ animation: 'ulyzerSpin 1.3s linear infinite' }} />
                          ) : isProblem ? (
                            <AlertTriangle size={10} />
                          ) : (
                            <Check size={10} />
                          )}
                          <span style={{ animation: isPending ? 'ulyzerPulse 1.4s ease-in-out infinite' : undefined }}>
                            {sourceReadyLabel(source)}
                          </span>
                        </span>
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 28px)', gap: 5, flexShrink: 0, alignSelf: 'center' }}>
                    <button
                      onClick={() => removeSource(source).catch(() => {})}
                      title={source.linkedToNode ? i18n.t('source_library.remove_ref_from_node') : i18n.t('source_library.delete_source')}
                      disabled={!canRemove}
                      style={actionGridButtonStyle(canRemove)}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      onClick={() => toggleSource(source).catch(() => {})}
                      title={source.enabled ? i18n.t('source_library.disable_source') : i18n.t('source_library.enable_source')}
                      disabled={!canToggle}
                      style={{
                        ...actionGridButtonStyle(canToggle),
                        color: source.enabled ? 'var(--accent)' : 'var(--text3)',
                        borderColor: source.enabled ? 'var(--accent-b)' : 'var(--border)',
                        background: source.enabled ? 'var(--accent-s)' : 'transparent',
                      }}
                    >
                      <Check size={13} />
                    </button>
                    <button
                      onClick={() => openSourceExternally(source).catch(() => {})}
                      title={source.url ? i18n.t('source_library.visit_page') : (source.originalPath || source.filePath) ? i18n.t('source_library.open_file_location') : i18n.t('source_library.no_external')}
                      disabled={!canOpenExternal}
                      style={actionGridButtonStyle(canOpenExternal)}
                    >
                      <ExternalLink size={13} />
                    </button>
                    <button
                      onClick={() => beginEditSource(source)}
                      title={source.linkedToNode ? i18n.t('source_library.main_ref_edit_hint') : i18n.t('source_library.rename_remark')}
                      disabled={!canEditMetadata}
                      style={actionGridButtonStyle(canEditMetadata)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => reextractSourceExercises(source).catch(() => {})}
                      title={i18n.t('source_library.reextract_exercises')}
                      disabled={extractingSourceIds.includes(source.id)}
                      style={actionGridButtonStyle(!extractingSourceIds.includes(source.id))}
                    >
                      <RotateCw size={13} style={{ animation: extractingSourceIds.includes(source.id) ? 'ulyzerSpin 1.3s linear infinite' : undefined }} />
                    </button>
                  </div>
                </div>
                <div style={{
                  marginTop: 7,
                  borderTop: '1px dashed var(--border)',
                  paddingTop: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, flexShrink: 0 }}>{i18n.t('source_library.ai_overview')}</span>
                    <span style={semanticBadgeStyle(semanticProfile?.status)}>{semanticStatusLabel(source)}</span>
                    {semanticProfile?.model ? (
                      <span style={{ ...badgeStyle, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {semanticProfile.model}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => rebuildSemanticProfile(source).catch(() => {})}
                      disabled={semanticBusy || source.origin === 'chat_attachment' || source.origin === 'ai_generated'}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: semanticBusy ? 'var(--text3)' : 'var(--accent)',
                        cursor: semanticBusy ? 'not-allowed' : 'pointer',
                        fontSize: 11,
                        padding: '1px 3px',
                        marginLeft: 'auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      {semanticBusy ? <RotateCw size={11} style={{ animation: 'ulyzerSpin 1.3s linear infinite' }} /> : null}
                      {i18n.t('source_library.reanalyze')}
                    </button>
                  </div>
                  {semanticProfile?.summary ? (
                    <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.55 }}>
                      {semanticProfile.summary}
                    </div>
                  ) : semanticProfile?.error ? (
                    <div style={{ fontSize: 11, color: semanticProfile.status === 'failed' ? 'var(--warning, #b7791f)' : 'var(--text3)', lineHeight: 1.55 }}>
                      {semanticProfile.error}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.55 }}>
                      {i18n.t('source_library.no_semantic_profile')}
                    </div>
                  )}
                  {semanticProfile ? (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {semanticProfile.concepts.slice(0, 6).map((item) => (
                        <span key={`concept-${item}`} style={badgeStyle}>{item}</span>
                      ))}
                      {semanticProfile.suitableFor.slice(0, 4).map((item) => (
                        <span key={`use-${item}`} style={documentBadgeStyle('ready')}>{semanticUsageLabel(item)}</span>
                      ))}
                      {semanticProfile.contentTypes.slice(0, 4).map((item) => (
                        <span key={`type-${item}`} style={badgeStyle}>{semanticContentTypeLabel(item)}</span>
                      ))}
                      {semanticProfile.difficulty ? (
                        <span style={badgeStyle}>{i18n.t('source_library.difficulty')} {semanticProfile.difficulty}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {semanticProfile?.qualityNotes ? (
                    <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
                      {semanticProfile.qualityNotes}
                    </div>
                  ) : null}
                  {learningMetadata.length > 0 ? (
                    <div style={{
                      marginTop: 2,
                      borderTop: '1px dashed var(--border)',
                      paddingTop: 6,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700 }}>{i18n.t('source_library.search_metadata')}</span>
                        {learningMetadata.slice(0, 2).map((item) => (
                          <span key={`${item.slotId}-${item.sourceType}`} style={badgeStyle}>
                            {item.slotName || item.slotId} · {item.sourceType} · {item.qualityScore.toFixed(2)}
                            {item.mainEvidence ? i18n.t('source_library.primary_basis') : i18n.t('source_library.supplement_basis')}
                          </span>
                        ))}
                      </div>
                      {learningMetadata.slice(0, 2).map((item) => (
                        <div key={`meta-${item.slotId}`} style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
                          {item.whyUseful ? <div>{i18n.t('source_library.why_useful')}{item.whyUseful}</div> : null}
                          {item.limitations ? <div>{i18n.t('source_library.limitations')}{item.limitations}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {importDialog && (
          <div
            onClick={() => !busy && setImportDialog(null)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.22)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: importDialog === 'text' || importDialog === 'main' ? 520 : 440,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 16px 38px rgba(0,0,0,0.18)',
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  {importDialog === 'url'
                    ? i18n.t('source_library.import_url')
                    : importDialog === 'file'
                      ? i18n.t('source_library.import_local')
                      : importDialog === 'collect'
                        ? i18n.t('source_library.web_collect')
                        : importDialog === 'main'
                          ? i18n.t('source_library.import_main')
                          : i18n.t('source_library.import_text')}
                </div>
                <button
                  type="button"
                  onClick={() => setImportDialog(null)}
                  disabled={busy}
                  style={{ border: 'none', background: 'transparent', color: 'var(--text3)', cursor: 'pointer', display: 'flex', padding: 2 }}
                >
                  <X size={14} />
                </button>
              </div>

              {importDialog === 'url' && (
                <>
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://..."
                    disabled={busy}
                    style={inputStyle}
                  />
                  <input
                    value={urlRemark}
                    onChange={(e) => setUrlRemark(e.target.value)}
                    placeholder={i18n.t('source_library.remark_ph_route')}
                    disabled={busy}
                    style={inputStyle}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" onClick={() => importUrl().catch(() => {})} disabled={busy || !url.trim()} style={primaryButtonStyle(Boolean(url.trim()) && !busy)}>
                      {i18n.t('source_library.import_btn')}
                    </button>
                  </div>
                </>
              )}

              {importDialog === 'file' && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={fileRemark}
                      onChange={(e) => setFileRemark(e.target.value)}
                      placeholder={i18n.t('source_library.remark_ph_exercise')}
                      disabled={busy}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => chooseLocalFiles().catch(() => {})}
                      disabled={busy}
                      style={primaryButtonStyle(!busy)}
                    >
                      {i18n.t('source_library.choose_file')}
                    </button>
                  </div>
                  <div style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r)',
                    background: 'var(--surface2)',
                    minHeight: 180,
                    maxHeight: 340,
                    overflowY: 'auto',
                    padding: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                    {pendingFiles.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.7, padding: '6px 4px' }}>
                        {i18n.t('source_library.file_pick_hint')}
                      </div>
                    ) : pendingFiles.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--r)',
                          background: 'var(--surface)',
                          padding: '8px 9px',
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            color: 'var(--text)',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {item.name}
                        </div>
                        <button
                          type="button"
                          onClick={() => removePendingFile(item.id)}
                          title={i18n.t('source_library.remove')}
                          style={actionGridButtonStyle(true)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => importPendingFiles().catch(() => {})}
                      disabled={busy || pendingFiles.length === 0}
                      style={primaryButtonStyle(pendingFiles.length > 0 && !busy)}
                    >
                      {i18n.t('source_library.import_btn')}
                    </button>
                  </div>
                </>
              )}

              {importDialog === 'text' && (
                <>
                  <input
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                    placeholder={i18n.t('source_library.paste_title_ph')}
                    disabled={busy}
                    style={inputStyle}
                  />
                  <input
                    value={pasteRemark}
                    onChange={(e) => setPasteRemark(e.target.value)}
                    placeholder={i18n.t('source_library.remark_ph_theory')}
                    disabled={busy}
                    style={inputStyle}
                  />
                  <textarea
                    value={pasteContent}
                    onChange={(e) => setPasteContent(e.target.value)}
                    placeholder={i18n.t('source_library.paste_text_ph')}
                    disabled={busy}
                    style={{ ...textareaStyle, minHeight: 130 }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" onClick={() => importPastedText().catch(() => {})} disabled={busy || !pasteContent.trim()} style={primaryButtonStyle(Boolean(pasteContent.trim()) && !busy)}>
                      {i18n.t('source_library.import_btn')}
                    </button>
                  </div>
                </>
              )}

              {importDialog === 'collect' && (
                <>
                  <input
                    value={collectQuery}
                    onChange={(e) => setCollectQuery(e.target.value)}
                    placeholder={i18n.t('source_library.collect_query_ph')}
                    disabled={collectBusy}
                    style={inputStyle}
                  />
                  <input
                    value={collectTarget}
                    onChange={(e) => setCollectTarget(e.target.value)}
                    placeholder={i18n.t('source_library.collect_target_ph')}
                    disabled={collectBusy}
                    style={inputStyle}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={collectRemark}
                      onChange={(e) => setCollectRemark(e.target.value)}
                      placeholder={i18n.t('source_library.import_remark_ph')}
                      disabled={collectBusy}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => runCollectSearch().catch(() => {})}
                      disabled={collectBusy || !collectQuery.trim()}
                      style={primaryButtonStyle(Boolean(collectQuery.trim()) && !collectBusy)}
                    >
                      <Search size={13} />
                      {i18n.t('source_library.search_btn')}
                    </button>
                  </div>

                  <div style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r)',
                    background: 'var(--surface2)',
                    minHeight: 180,
                    maxHeight: 280,
                    overflowY: 'auto',
                    padding: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                    {collectedResults.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.7, padding: '6px 4px' }}>
                        {collectBusy ? i18n.t('source_library.searching') : i18n.t('source_library.collect_empty_hint')}
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, padding: '2px 4px 6px' }}>
                          {i18n.t('source_library.collect_filter_note')}
                        </div>
                        {collectedResults.map((result) => {
                          const snippet = collectSnippet(result.content);
                          const riskReasons = result.riskReasons ?? [];
                          return (
                            <div
                              key={result.url}
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--r)',
                                background: 'var(--surface)',
                                padding: '8px 9px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    title={result.title}
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--text)',
                                      fontWeight: 700,
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                    }}
                                  >
                                    {result.title || i18n.t('source_library.untitled_page')}
                                  </div>
                                  <div
                                    title={result.url}
                                    style={{
                                      marginTop: 2,
                                      fontSize: 10,
                                      color: 'var(--text3)',
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                    }}
                                  >
                                    {collectHost(result.url)}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => openCollectedResult(result).catch(() => {})}
                                  title={i18n.t('source_library.visit_page')}
                                  style={actionGridButtonStyle(true)}
                                >
                                  <ExternalLink size={13} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeCollectedResult(result.url)}
                                  title={i18n.t('source_library.remove')}
                                  style={actionGridButtonStyle(true)}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
                                <span style={collectRiskBadgeStyle(result.riskLevel)}>{collectRiskLabel(result.riskLevel)}</span>
                                <span style={badgeStyle}>{collectTierLabel(result.sourceTier)}</span>
                                <span style={badgeStyle}>{collectTrustLabel(result)}</span>
                                {result.provider && <span style={badgeStyle}>{result.provider}</span>}
                                {result.recommended && (
                                  <span style={{
                                    ...badgeStyle,
                                    color: 'rgb(22, 101, 52)',
                                    background: 'rgba(34, 197, 94, 0.08)',
                                    borderColor: 'rgba(34, 197, 94, 0.20)',
                                  }}>
                                    {i18n.t('source_library.recommended')}
                                  </span>
                                )}
                              </div>

                              {snippet && (
                                <div
                                  title={snippet}
                                  style={{
                                    fontSize: 11,
                                    color: 'var(--text2)',
                                    lineHeight: 1.55,
                                    display: '-webkit-box',
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                    overflow: 'hidden',
                                  }}
                                >
                                  {snippet}
                                </div>
                              )}

                              {riskReasons.length > 0 && result.riskLevel !== 'low' && (
                                <div style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--warning, #b7791f)', fontSize: 10 }}>
                                  <AlertTriangle size={11} />
                                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {riskReasons.slice(0, 2).join('；')}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => importCollectedResults().catch(() => {})}
                      disabled={collectBusy || collectedResults.length === 0}
                      style={primaryButtonStyle(collectedResults.length > 0 && !collectBusy)}
                    >
                      {i18n.t('source_library.import_btn')}
                    </button>
                  </div>
                </>
              )}

              {importDialog === 'main' && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={mainSourceQuery}
                      onChange={(e) => setMainSourceQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') loadMainSourceCandidates().catch(() => {});
                      }}
                      placeholder={i18n.t('source_library.search_main_ph')}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => loadMainSourceCandidates().catch(() => {})}
                      disabled={mainSourceBusy}
                      style={primaryButtonStyle(!mainSourceBusy)}
                    >
                      <Search size={13} />
                      {i18n.t('source_library.search_btn')}
                    </button>
                  </div>

                  <div style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r)',
                    background: 'var(--surface2)',
                    minHeight: 220,
                    maxHeight: 320,
                    overflowY: 'auto',
                    padding: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                    {mainSourceError ? (
                      <div style={{ fontSize: 12, color: 'var(--warning, #b7791f)', lineHeight: 1.7, padding: '6px 4px' }}>
                        {i18n.t('source_library.load_failed_prefix')}{mainSourceError}
                      </div>
                    ) : mainSourceCandidates.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.7, padding: '6px 4px' }}>
                        {mainSourceBusy ? i18n.t('source_library.loading_main') : i18n.t('source_library.main_empty')}
                      </div>
                    ) : mainSourceCandidates.map((source) => {
                      const checked = selectedMainSourceIds.includes(source.id);
                      return (
                        <label
                          key={source.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            border: '1px solid ' + (checked ? 'var(--accent-b)' : 'var(--border)'),
                            borderRadius: 'var(--r)',
                            background: checked ? 'var(--accent-s)' : 'var(--surface)',
                            padding: '8px 9px',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMainSourceSelection(source.id)}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12,
                              color: 'var(--text)',
                              fontWeight: 700,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}>
                              {source.title}
                            </div>
                            <div style={{
                              marginTop: 3,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              minWidth: 0,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                            }}>
                              {source.remark ? (
                                <span style={{
                                  fontSize: 11,
                                  color: 'var(--text3)',
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}>
                                  {source.remark}
                                </span>
                              ) : null}
                              <span style={badgeStyle}>{sourceMediaLabel(source)}</span>
                              <span style={readyBadgeStyle(source)}>{sourceReadyLabel(source)}</span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => importSelectedMainSources().catch(() => {})}
                      disabled={mainSourceBusy || selectedMainSourceIds.length === 0}
                      style={primaryButtonStyle(selectedMainSourceIds.length > 0 && !mainSourceBusy)}
                    >
                      {i18n.t('source_library.import_reference')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {editingSource && (
          <div
            onClick={() => !busy && setEditingSource(null)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.22)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 440,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 16px 38px rgba(0,0,0,0.18)',
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  {i18n.t('source_library.rename_remark')}
                </div>
                <button
                  type="button"
                  onClick={() => setEditingSource(null)}
                  disabled={busy}
                  style={{ border: 'none', background: 'transparent', color: 'var(--text3)', cursor: 'pointer', display: 'flex', padding: 2 }}
                >
                  <X size={14} />
                </button>
              </div>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveSourceMetadata().catch(() => {});
                }}
                placeholder={i18n.t('source_library.source_name')}
                disabled={busy}
                style={inputStyle}
              />
              <textarea
                value={editRemark}
                onChange={(e) => setEditRemark(e.target.value)}
                placeholder={i18n.t('source_library.remark_ph_general')}
                disabled={busy}
                style={{ ...textareaStyle, minHeight: 86 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => saveSourceMetadata().catch(() => {})}
                  disabled={busy || !editTitle.trim()}
                  style={primaryButtonStyle(Boolean(editTitle.trim()) && !busy)}
                >
                  {i18n.t('common.save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  background: 'var(--bg)',
  color: 'var(--text)',
  padding: '7px 8px',
  fontSize: 12,
  outline: 'none',
};

const textareaStyle: React.CSSProperties = {
  minHeight: 88,
  resize: 'vertical',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  background: 'var(--bg)',
  color: 'var(--text)',
  padding: '8px 9px',
  fontSize: 12,
  lineHeight: 1.6,
  outline: 'none',
  fontFamily: 'var(--sans)',
};

const textButtonStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  background: 'transparent',
  color: 'var(--text2)',
  padding: '7px 10px',
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  fontFamily: 'var(--sans)',
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text2)',
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '2px 6px',
};

function actionGridButtonStyle(active: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 24,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r)',
    background: 'transparent',
    color: 'var(--text3)',
    cursor: active ? 'pointer' : 'not-allowed',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: active ? 1 : 0.45,
  };
}

function launchButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...textButtonStyle,
    padding: '9px 10px',
    justifyContent: 'center',
    opacity: active ? 1 : 0.5,
    cursor: active ? 'pointer' : 'not-allowed',
  };
}

function primaryButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...textButtonStyle,
    borderColor: active ? 'var(--accent-b)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'var(--surface2)',
    color: active ? '#fff' : 'var(--text3)',
    cursor: active ? 'pointer' : 'not-allowed',
    opacity: active ? 1 : 0.6,
  };
}
