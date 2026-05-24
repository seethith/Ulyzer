# Adding a UI language

Ulyzer ships Chinese (`zh`) and English (`en`). The locale plumbing already
scaffolds Japanese (`ja`) and Korean (`ko`) at the normalization layer, so a
new language is mostly **translation work, not architecture work**.

## Conventions (keep the door open)

- **New UI strings → `t()` + JSON only.** Add the key to `renderer/src/locales/zh.json`
  and `en.json` and read it with `useTranslation()`/`t()`. This path scales to any
  number of languages for free.
- **Do not add new inline `{ zh, en }` maps or `isEn ? … : …` ternaries** in the
  renderer. (A few legacy ones remain in `ChatInputBox`, `DiagnosticsView`, `NodeBubble`;
  don't grow them.)
- **New main-process / agent strings → `localMsg(language, zh, en)`** (in
  `src/main/services/agent-i18n/messages.ts`). It is fallback-safe: any locale other
  than `en` currently returns the `zh` string, so passing an unsupported language never
  crashes.
- The single source of truth for shipped UI languages is **`UI_LANGUAGES` in
  `shared/i18n.ts`**. The language switcher, i18n init, and the parity test all read it.

## Steps to add a language (example: Japanese)

1. **Create the bundle** `renderer/src/locales/ja.json` — copy `en.json` and translate
   every value. (The parity test will fail until the key set matches exactly.)
2. **Register it as a shipped language** — add an entry to `UI_LANGUAGES` in
   `shared/i18n.ts`:
   ```ts
   { code: 'ja', locale: 'ja-JP', label: '日本語' },
   ```
3. **Wire the bundle into i18n** — in `renderer/src/i18n.ts`, import the JSON and add it
   to `BUNDLES`:
   ```ts
   import ja from './locales/ja.json';
   const BUNDLES = { zh, en, ja };
   ```
4. **Cover it in the parity test** — in `renderer/src/locales/locale-parity.test.ts`,
   import the JSON and add it to that file's `BUNDLES`.

That's all the UI needs. `SupportedLocale` / `normalizeLocale` already handle `ja`/`ko`;
for a Latin-script language (e.g. French) add `fr`/`fr-FR` to `BaseLanguage`,
`SupportedLocale`, `LOCALE_ALIASES`, `normalizeLocale`, and `baseLanguage` in
`shared/i18n.ts` first.

## Optional: localize the AI itself (bigger lift)

The agent layer (`src/main/services/agent-i18n/*`) is intentionally binary today:
`LocalizedText` is `{ zh, en }` and unsupported locales fall back to `zh`. To make the
AI's **tool descriptions, prompts, and generated material** use the new language:

- Generalize `LocalizedText`/`localMsg` from `{ zh, en }` to a keyed map, then translate
  the catalogs in `messages.ts`, `tool-descriptions.ts`, `prompt-catalog.ts`, the
  `agent-policy/*` docs, `folder-policy.ts` (folder names), and `artifact-names.ts`.
- Add a "respond in <language>" line to `COMMON_MESSAGES.languageInstruction`
  (`messages.ts`) — this is what tells the model which language to write in. The model
  (Claude/GPT) handles ja/fr/ko well, so once the instruction is set, generated study
  material comes out in that language.

Defer this until you actually commit to a third language — doing it earlier just adds
boilerplate to every new feature string with no way to validate the translations.

## Fonts

- French / other Latin scripts: no change needed.
- Japanese / Korean: rely on the OS CJK/Hangul fallback in the `--sans` stack; verify
  rendering on each target platform.
