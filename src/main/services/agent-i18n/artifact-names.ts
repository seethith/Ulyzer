import type { FolderKey } from '@shared/types';
import { localize, localMsg, normalizeLanguage, type LocalizedText } from './messages';

export type ArtifactFolderKey = FolderKey;
export type TimestampedArtifactKind = 'mindmap' | 'note';

export interface ArtifactIndexEntryVars {
  fileName: string;
  date?: string;
  outlineVersion?: string;
  coverage?: string;
  headings?: string;
}

export interface TimestampedArtifactFilenameVars {
  title?: string;
  timestamp?: string;
}

const ARTIFACT_DISPLAY_NAMES: Record<ArtifactFolderKey, LocalizedText> = {
  outline:  { zh: '纲要', en: 'Outline' },
  theory:   { zh: '原理资料', en: 'Theory' },
  practice: { zh: '实践资料', en: 'Practice' },
  answer:   { zh: '参考答案', en: 'Answer' },
  notes:    { zh: '个人笔记', en: 'Notes' },
  feynman:  { zh: '费曼复盘', en: 'Feynman Review' },
};

const FILENAME_PREFIXES: Partial<Record<ArtifactFolderKey, LocalizedText>> = {
  theory:   { zh: '原理', en: 'theory' },
  practice: { zh: '练习', en: 'practice' },
  answer:   { zh: '答案', en: 'answer' },
};

const TIMESTAMPED_BASENAMES: Record<TimestampedArtifactKind, LocalizedText> = {
  mindmap: { zh: '思维导图', en: 'mindmap' },
  note:    { zh: '笔记', en: 'note' },
};

export function getArtifactDisplayName(folderKey: string, language?: string): string {
  const name = ARTIFACT_DISPLAY_NAMES[folderKey as ArtifactFolderKey];
  return name ? localize(name, language) : folderKey;
}

export function getArtifactFilenamePrefix(folderKey: string, language?: string): string | undefined {
  const prefix = FILENAME_PREFIXES[folderKey as ArtifactFolderKey];
  return prefix ? localize(prefix, language) : undefined;
}

export function sanitizeFilenamePart(value: string, fallback: string, maxLength = 30): string {
  const sanitized = value
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, maxLength);
  return sanitized || fallback;
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
}

function appendBeforeExtension(fileName: string, suffix: string): string {
  const match = fileName.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] ?? fileName;
  const ext = match?.[2] ?? '';
  return `${stem}-${suffix}${ext}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isNormalizedArtifactFilename(folderKey: string, fileName: string, language?: string): boolean {
  const prefix = getArtifactFilenamePrefix(folderKey, language);
  if (!prefix) return false;
  return new RegExp(`^${escapeRegExp(prefix)}-v\\d+-\\d{4}-.+\\.md$`, 'i').test(fileName);
}

export function getPairedAnswerFilename(practiceFilename: string, language?: string): string {
  if (!practiceFilename) return '';
  const isEn = normalizeLanguage(language) === 'en';
  if ((isEn && /answer/i.test(practiceFilename)) || (!isEn && /答案/.test(practiceFilename))) {
    return practiceFilename;
  }

  const replacements: Array<[RegExp, string]> = isEn
    ? [
        [/practice/i, getArtifactFilenamePrefix('answer', language) ?? 'answer'],
        [/exercises?/i, 'answer-key'],
        [/quiz/i, 'answer-key'],
      ]
    : [
        [/练习题/g, '参考答案'],
        [/^练习(?=[-_.]|$)/, getArtifactFilenamePrefix('answer', language) ?? '答案'],
        [/实践资料/g, '参考答案'],
      ];

  for (const [pattern, replacement] of replacements) {
    const next = practiceFilename.replace(pattern, replacement);
    if (next !== practiceFilename) return next;
  }

  return appendBeforeExtension(practiceFilename, getArtifactFilenamePrefix('answer', language) ?? localMsg(language, '答案', 'answer'));
}

export function getArtifactIndexHeader(folderKey: FolderKey, language?: string): string {
  const folderLabel = getArtifactDisplayName(folderKey, language);
  return normalizeLanguage(language) === 'en'
    ? `# ${folderLabel} Index\n`
    : `# ${folderLabel}索引\n`;
}

export function getArtifactIndexEntry(
  folderKey: FolderKey,
  vars: ArtifactIndexEntryVars,
  language?: string,
): string {
  const date = vars.date ?? new Date().toISOString().slice(0, 10);

  if (folderKey === 'feynman' && vars.outlineVersion) {
    return localMsg(
      language,
      `\n## ${vars.fileName}（${date}）\n纲要版本：${vars.outlineVersion}\n`,
      `\n## ${vars.fileName} (${date})\nOutline version: ${vars.outlineVersion}\n`,
    );
  }

  if (vars.outlineVersion && vars.coverage !== undefined) {
    return localMsg(
      language,
      `\n## ${vars.fileName}（${date}）\n覆盖KC：${vars.coverage}\n深度版本：${vars.outlineVersion}\n`,
      `\n## ${vars.fileName} (${date})\nKCs covered: ${vars.coverage}\nOutline version: ${vars.outlineVersion}\n`,
    );
  }

  const headings = vars.headings || localMsg(language, '（无章节标题）', '(no section headings)');
  return localMsg(
    language,
    `\n## ${vars.fileName}\n覆盖：${headings}\n时间：${date}\n`,
    `\n## ${vars.fileName}\nCovers: ${headings}\nDate: ${date}\n`,
  );
}

export function getTimestampedArtifactFilename(
  kind: TimestampedArtifactKind,
  vars: TimestampedArtifactFilenameVars = {},
  language?: string,
): string {
  const ts = vars.timestamp ?? timestampForFilename();
  const baseName = localize(TIMESTAMPED_BASENAMES[kind], language);

  const title = vars.title
    ? `-${sanitizeFilenamePart(vars.title, baseName, 20)}`
    : '';
  return `${ts}-${baseName}${title}.md`;
}

export function getDefaultNoteTitle(language?: string): string {
  return localize(TIMESTAMPED_BASENAMES.note, language);
}

export function getReviewBaseName(outlineVersion: string, mmdd: string, language?: string): string {
  return localMsg(language, `复盘清单-${outlineVersion}-${mmdd}`, `review-${outlineVersion}-${mmdd}`);
}

export function getReviewIndexHeader(language?: string): string {
  return getArtifactIndexHeader('feynman', language);
}

export function getReviewIndexEntry(fileName: string, date: string, outlineVersion: string, language?: string): string {
  return getArtifactIndexEntry('feynman', { fileName, date, outlineVersion }, language);
}
