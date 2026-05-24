import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Resource } from 'i18next';
import { UI_LANGUAGES, UI_LANGUAGE_CODES, type BaseLanguage } from '@shared/i18n';
import zh from './locales/zh.json';
import en from './locales/en.json';

// Translation bundles, keyed by language code. To add a language, import its JSON
// and add it here (and an entry in `UI_LANGUAGES`). See docs/ADDING-A-LANGUAGE.md.
const BUNDLES: Partial<Record<BaseLanguage, object>> = {
  zh,
  en,
};

const resources: Resource = {};
for (const { code } of UI_LANGUAGES) {
  const bundle = BUNDLES[code];
  if (bundle) resources[code] = { translation: bundle };
}

/** First run (no saved choice): follow the OS language; fall back to the first UI language. */
function initialLanguage(): string {
  const saved = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
    ? localStorage.getItem('ulyzer_lang')
    : null;
  if (saved && (UI_LANGUAGE_CODES as readonly string[]).includes(saved)) return saved;
  const osLang = (typeof navigator !== 'undefined' ? navigator.language : '')?.toLowerCase() ?? '';
  const match = UI_LANGUAGE_CODES.find((code) => osLang.startsWith(code));
  return match ?? UI_LANGUAGE_CODES[0];
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage(),
    fallbackLng: 'zh',
    interpolation: {
      escapeValue: false,
    },
  });

// Keep the document language in sync (a11y + correct CJK font/line-break heuristics).
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.lang = i18n.language;
  i18n.on('languageChanged', (lng) => { document.documentElement.lang = lng; });
}

export default i18n;
