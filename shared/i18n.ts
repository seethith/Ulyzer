export type SupportedLocale = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR';
export type BaseLanguage = 'zh' | 'en' | 'ja' | 'ko';

export interface AgentLocaleContext {
  uiLocale: SupportedLocale;
  agentLocale: SupportedLocale;
  artifactLocale: SupportedLocale;
}

export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';

const LOCALE_ALIASES: Record<string, SupportedLocale> = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  cn: 'zh-CN',

  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-US',

  ja: 'ja-JP',
  'ja-jp': 'ja-JP',
  jp: 'ja-JP',

  ko: 'ko-KR',
  'ko-kr': 'ko-KR',
  kr: 'ko-KR',
};

export function normalizeLocale(
  input?: string | null,
  fallback: SupportedLocale = DEFAULT_LOCALE,
): SupportedLocale {
  const key = input?.trim().replace(/_/g, '-').toLowerCase();
  if (!key) return fallback;

  const alias = LOCALE_ALIASES[key];
  if (alias) return alias;

  const [base] = key.split('-');
  switch (base) {
    case 'zh':
      return 'zh-CN';
    case 'en':
      return 'en-US';
    case 'ja':
      return 'ja-JP';
    case 'ko':
      return 'ko-KR';
    default:
      return fallback;
  }
}

export function baseLanguage(locale: SupportedLocale): BaseLanguage {
  switch (locale) {
    case 'zh-CN':
      return 'zh';
    case 'en-US':
      return 'en';
    case 'ja-JP':
      return 'ja';
    case 'ko-KR':
      return 'ko';
  }
}

export function legacyAgentLanguage(input?: string | null): 'zh' | 'en' {
  return baseLanguage(normalizeLocale(input)) === 'en' ? 'en' : 'zh';
}

// ── UI languages (single source of truth) ───────────────────────────────────────

export interface UiLanguage {
  /** i18next resource key and `i18n.language` value, e.g. 'zh'. */
  code: BaseLanguage;
  /** Canonical locale used by the agent layer and date/number formatting. */
  locale: SupportedLocale;
  /** Endonym shown in the language switcher (no translation needed). */
  label: string;
}

/**
 * Languages that ship a full UI translation bundle (`renderer/src/locales/<code>.json`)
 * and appear in the in-app language switcher.
 *
 * To add a language (e.g. Japanese): create the JSON bundle, add an entry here, and
 * register the bundle in `renderer/src/i18n.ts`. See `docs/ADDING-A-LANGUAGE.md`.
 * Note: `SupportedLocale`/`normalizeLocale` already scaffold ja/ko at the locale layer,
 * so a new language only needs translations, not locale plumbing.
 */
export const UI_LANGUAGES: readonly UiLanguage[] = [
  { code: 'zh', locale: 'zh-CN', label: '中文' },
  { code: 'en', locale: 'en-US', label: 'English' },
];

/** Just the language codes, e.g. ['zh', 'en']. */
export const UI_LANGUAGE_CODES: readonly BaseLanguage[] = UI_LANGUAGES.map((l) => l.code);
