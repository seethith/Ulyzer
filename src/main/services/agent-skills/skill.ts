import type { GenerateFolder } from '@shared/types';
import type { SupportedLocale } from '@shared/i18n';
import {
  localize,
  normalizeLanguage,
  type LocalizedList,
  type LocalizedText,
} from '../agent-i18n/messages';

export type SkillLanguage = SupportedLocale;
export type { LocalizedList, LocalizedText };

export type AgentSkillId =
  | 'generate_theory_material'
  | 'generate_practice_material'
  | 'feynman_review';

export interface AgentSkill {
  id: AgentSkillId;
  title: LocalizedText;
  description: LocalizedText;
  workflowPrompt: LocalizedText;
  materialFolders?: GenerateFolder[];
  materialWorkflowPrompts?: Partial<Record<GenerateFolder, LocalizedText>>;
  defaultRequestPrefixes?: LocalizedList;
}

export function pickLocalizedText(text: LocalizedText, language?: string): string {
  return localize(text, language);
}

export function pickLocalizedList(list: LocalizedList | undefined, language?: string): string[] {
  if (!list) return [];
  return list[normalizeLanguage(language)];
}
