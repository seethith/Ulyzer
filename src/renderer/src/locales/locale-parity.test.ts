import { describe, expect, it } from 'vitest';
import { UI_LANGUAGE_CODES } from '@shared/i18n';
import zh from './zh.json';
import en from './en.json';

type Json = Record<string, unknown>;

// Translation bundles by language code. When adding a language, add its import +
// entry here so it's automatically covered by the parity checks below.
const BUNDLES: Record<string, Json> = {
  zh: zh as Json,
  en: en as Json,
};

/** Flatten nested translation objects into dotted key paths. */
function flatten(obj: Json, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? flatten(value as Json, path)
      : [path];
  });
}

function emptyValues(obj: Json, lang: string, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = `${lang}.${prefix}${key}`;
    if (typeof value === 'string') return value.trim() === '' ? [path] : [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return emptyValues(value as Json, lang, `${prefix}${key}.`);
    }
    return [];
  });
}

describe('locale parity', () => {
  const codes = Object.keys(BUNDLES);
  const reference = codes[0];
  const referenceKeys = new Set(flatten(BUNDLES[reference]));

  it('every shipped UI language has a translation bundle', () => {
    const missing = UI_LANGUAGE_CODES.filter((code) => !BUNDLES[code]);
    expect(missing).toEqual([]);
  });

  it('all language bundles have identical key sets', () => {
    const drift: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const code of codes) {
      if (code === reference) continue;
      const keys = new Set(flatten(BUNDLES[code]));
      const missing = [...referenceKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !referenceKeys.has(k));
      if (missing.length || extra.length) drift[`${reference}↔${code}`] = { missing, extra };
    }
    expect(drift).toEqual({});
  });

  it('has no empty string values', () => {
    const empties = codes.flatMap((code) => emptyValues(BUNDLES[code], code));
    expect(empties).toEqual([]);
  });
});
