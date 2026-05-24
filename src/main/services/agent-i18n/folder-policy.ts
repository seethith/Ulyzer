import { FOLDER_KEYS } from '@shared/types';
import type { FolderKey } from '@shared/types';
import { normalizeLanguage, type LegacyAgentLanguage } from './messages';

export type NodeFolderKey = FolderKey;

export const NODE_FOLDER_KEYS = FOLDER_KEYS;

export const MATERIAL_READ_FOLDER_KEYS = [
  'theory',
  'practice',
  'answer',
  'notes',
  'feynman',
] as const satisfies readonly NodeFolderKey[];

const FOLDER_NAME_MAP: Record<LegacyAgentLanguage, Record<NodeFolderKey, string>> = {
  zh: {
    outline:  '纲要',
    theory:   '原理资料',
    practice: '实践资料',
    answer:   '参考答案',
    notes:    '个人笔记',
    feynman:  '费曼复盘',
  },
  en: {
    outline:  'Outline',
    theory:   'Theory',
    practice: 'Practice',
    answer:   'Answer',
    notes:    'Notes',
    feynman:  'Feynman Review',
  },
};

const LOCALIZED_NAME_TO_KEY = new Map<string, NodeFolderKey>(
  Object.values(FOLDER_NAME_MAP).flatMap((map) =>
    Object.entries(map).map(([key, name]) => [name, key as NodeFolderKey] as const),
  ),
);

export function getFolderNameMap(language?: string): Record<NodeFolderKey, string> {
  return { ...FOLDER_NAME_MAP[normalizeLanguage(language)] };
}

export function getNodeSubfolderNames(language?: string): string[] {
  const map = FOLDER_NAME_MAP[normalizeLanguage(language)];
  return NODE_FOLDER_KEYS.map((key) => map[key]);
}

export function getFolderName(folderKey: NodeFolderKey, language?: string): string {
  return FOLDER_NAME_MAP[normalizeLanguage(language)][folderKey];
}

export function getOutlineFolderName(language?: string): string {
  return getFolderName('outline', language);
}

export function resolveFolderKey(folderNameOrKey: string): NodeFolderKey | undefined {
  if ((NODE_FOLDER_KEYS as readonly string[]).includes(folderNameOrKey)) {
    return folderNameOrKey as NodeFolderKey;
  }
  return LOCALIZED_NAME_TO_KEY.get(folderNameOrKey);
}

export function resolveFolderNameForLanguage(folderNameOrKey: string, language?: string): string {
  const key = resolveFolderKey(folderNameOrKey);
  return key ? getFolderName(key, language) : folderNameOrKey;
}

export function getFolderDisplayName(folderNameOrKey: string): string {
  const key = resolveFolderKey(folderNameOrKey);
  if (!key) return folderNameOrKey;
  return `${FOLDER_NAME_MAP.zh[key]} / ${FOLDER_NAME_MAP.en[key]}`;
}

export function detectFolderLanguageFromNames(folderNames: Iterable<string>): LegacyAgentLanguage {
  const names = new Set(folderNames);
  if (names.has(FOLDER_NAME_MAP.en.outline)) return 'en';
  if (names.has(FOLDER_NAME_MAP.zh.outline)) return 'zh';
  for (const name of Object.values(FOLDER_NAME_MAP.en)) {
    if (names.has(name)) return 'en';
  }
  return 'zh';
}

export function getFolderSortLocale(language?: string): string {
  return normalizeLanguage(language) === 'en' ? 'en' : 'zh';
}
