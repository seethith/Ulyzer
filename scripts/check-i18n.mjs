#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const localeAliases = new Map([
  ['zh', 'zh'],
  ['zh-CN', 'zh'],
  ['en', 'en'],
  ['en-US', 'en'],
  ['ja', 'ja'],
  ['ja-JP', 'ja'],
  ['ko', 'ko'],
  ['ko-KR', 'ko'],
]);

const localeLabels = new Map([
  ['zh', 'zh-CN'],
  ['en', 'en-US'],
  ['ja', 'ja-JP'],
  ['ko', 'ko-KR'],
]);

const defaultLocaleKeys = ['zh', 'en'];
const args = process.argv.slice(2);
const strictLocale = parseStrictLocale(args);
const strictLocaleKey = strictLocale ? normalizeLocaleKey(strictLocale) : undefined;
const requiredLocaleKeys = [...defaultLocaleKeys];
if (strictLocaleKey && !requiredLocaleKeys.includes(strictLocaleKey)) {
  requiredLocaleKeys.push(strictLocaleKey);
}

const problems = [];
const checked = [];

function parseStrictLocale(argv) {
  const inline = argv.find((arg) => arg.startsWith('--strict='));
  if (inline) return inline.slice('--strict='.length);
  const index = argv.indexOf('--strict');
  if (index !== -1) return argv[index + 1] ?? '';
  return undefined;
}

function normalizeLocaleKey(locale) {
  const normalized = localeAliases.get(locale) ?? locale.split('-')[0];
  if (!normalized) {
    fail('cli', 'Missing locale after --strict.');
    return locale;
  }
  return normalized;
}

function labelForLocale(key) {
  return localeLabels.get(key) ?? key;
}

function rel(filePath) {
  return path.relative(repoRoot, filePath);
}

function fail(scope, message) {
  problems.push({ scope, message });
}

function mark(scope) {
  checked.push(scope);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function flattenJson(value, prefix = '') {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    return new Set(prefix ? [prefix] : []);
  }
  const keys = new Set();
  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    for (const nestedKey of flattenJson(child, nextPrefix)) {
      keys.add(nestedKey);
    }
  }
  return keys;
}

function compareKeySets(leftName, leftSet, rightName, rightSet, scopePrefix) {
  for (const key of [...leftSet].sort()) {
    if (!rightSet.has(key)) fail(scopePrefix, `${rightName} is missing key "${key}" from ${leftName}.`);
  }
}

function findMatching(source, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === openChar) depth++;
    if (char === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractConstObject(source, constName, filePath) {
  const marker = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b`);
  const match = marker.exec(source);
  if (!match) throw new Error(`Could not find const ${constName} in ${filePath}`);
  const equalIndex = source.indexOf('=', match.index);
  const start = source.indexOf('{', equalIndex);
  const end = findMatching(source, start, '{', '}');
  if (start === -1 || end === -1) throw new Error(`Could not parse object ${constName} in ${filePath}`);
  const expression = source.slice(start, end + 1);
  return Function(`"use strict"; return (${expression});`)();
}

function extractConstStringArray(source, constName, filePath) {
  const marker = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b`);
  const match = marker.exec(source);
  if (!match) throw new Error(`Could not find const ${constName} in ${filePath}`);
  const equalIndex = source.indexOf('=', match.index);
  const start = source.indexOf('[', equalIndex);
  const end = findMatching(source, start, '[', ']');
  if (start === -1 || end === -1) throw new Error(`Could not parse array ${constName} in ${filePath}`);
  const text = source.slice(start, end + 1);
  return [...text.matchAll(/['"]([^'"]+)['"]/g)].map((matchItem) => matchItem[1]);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function checkLocalizedValue(value, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(scope, 'Expected a localized object.');
    return;
  }

  for (const localeKey of requiredLocaleKeys) {
    if (!hasOwn(value, localeKey)) {
      fail(scope, `Missing ${labelForLocale(localeKey)} value.`);
    }
  }
}

function checkLocalizedMap(map, scope) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    fail(scope, 'Expected an object map.');
    return;
  }

  for (const [key, value] of Object.entries(map)) {
    checkLocalizedValue(value, `${scope}.${key}`);
  }
}

function checkFrontendLocales() {
  const localeDir = 'src/renderer/src/locales';
  const zh = readJson(`${localeDir}/zh.json`);
  const en = readJson(`${localeDir}/en.json`);
  const zhKeys = flattenJson(zh);
  const enKeys = flattenJson(en);
  compareKeySets('zh.json', zhKeys, 'en.json', enKeys, 'frontend');
  compareKeySets('en.json', enKeys, 'zh.json', zhKeys, 'frontend');

  if (strictLocaleKey && !defaultLocaleKeys.includes(strictLocaleKey)) {
    const candidates = [
      `${localeDir}/${strictLocaleKey}.json`,
      `${localeDir}/${strictLocale}.json`,
    ];
    const strictFile = candidates.find((candidate) => fs.existsSync(path.join(repoRoot, candidate)));
    const strictKeys = strictFile ? flattenJson(readJson(strictFile)) : new Set();
    for (const key of [...zhKeys].sort()) {
      if (!strictKeys.has(key)) {
        fail('frontend', `${strictFile ?? labelForLocale(strictLocaleKey)} is missing key "${key}".`);
      }
    }
  }

  mark('frontend locale JSON');
}

function checkMessages() {
  const filePath = 'src/main/services/agent-i18n/messages.ts';
  const source = readText(filePath);
  const commonMessages = extractConstObject(source, 'COMMON_MESSAGES', filePath);
  checkLocalizedMap(commonMessages, 'backend.messages');
  mark('backend common messages');
}

function checkToolDescriptions() {
  const filePath = 'src/main/services/agent-i18n/tool-descriptions.ts';
  const source = readText(filePath);
  const toolDescriptions = extractConstObject(source, 'TOOL_DESCRIPTIONS', filePath);

  for (const [toolName, entry] of Object.entries(toolDescriptions)) {
    checkLocalizedValue(entry.description, `toolDescriptions.${toolName}.description`);
    for (const [propertyName, propertyValue] of Object.entries(entry.properties ?? {})) {
      checkLocalizedValue(propertyValue, `toolDescriptions.${toolName}.properties.${propertyName}`);
    }
  }

  mark('tool descriptions');
  return toolDescriptions;
}

function checkArtifactNames() {
  const filePath = 'src/main/services/agent-i18n/artifact-names.ts';
  const source = readText(filePath);
  for (const constName of ['ARTIFACT_DISPLAY_NAMES', 'FILENAME_PREFIXES', 'TIMESTAMPED_BASENAMES']) {
    const map = extractConstObject(source, constName, filePath);
    checkLocalizedMap(map, `artifactNames.${constName}`);
  }
  mark('artifact names');
}

function checkFolderPolicy() {
  const folderKeys = extractConstStringArray(readText('shared/types.ts'), 'FOLDER_KEYS', 'shared/types.ts');
  const filePath = 'src/main/services/agent-i18n/folder-policy.ts';
  const folderNameMap = extractConstObject(readText(filePath), 'FOLDER_NAME_MAP', filePath);

  for (const localeKey of requiredLocaleKeys) {
    const localeMap = folderNameMap[localeKey];
    for (const folderKey of folderKeys) {
      if (!localeMap || !hasOwn(localeMap, folderKey)) {
        fail('folderPolicy', `Missing ${labelForLocale(localeKey)} folder name for "${folderKey}".`);
      }
    }
  }

  mark('folder policy');
}

function findObjectBlockAfter(source, regex, filePath) {
  const match = regex.exec(source);
  if (!match) throw new Error(`Could not find object marker in ${filePath}`);
  const equalIndex = source.indexOf('=', match.index);
  const start = source.indexOf('{', equalIndex);
  const end = findMatching(source, start, '{', '}');
  if (start === -1 || end === -1) throw new Error(`Could not parse object in ${filePath}`);
  return source.slice(start, end + 1);
}

function extractPropertyBlock(objectText, propertyName) {
  const regex = new RegExp(`\\n\\s{2}${propertyName}:\\s*\\{`);
  const match = regex.exec(objectText);
  if (!match) return null;
  const start = objectText.indexOf('{', match.index);
  const end = findMatching(objectText, start, '{', '}');
  return start === -1 || end === -1 ? null : objectText.slice(start, end + 1);
}

function extractPropertyArray(objectText, propertyName) {
  const regex = new RegExp(`\\n\\s{2}${propertyName}:\\s*\\[`);
  const match = regex.exec(objectText);
  if (!match) return [];
  const start = objectText.indexOf('[', match.index);
  const end = findMatching(objectText, start, '[', ']');
  if (start === -1 || end === -1) return [];
  return [...objectText.slice(start, end + 1).matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
}

function checkLocalizedBlockText(block, scope) {
  if (!block) {
    fail(scope, 'Missing localized block.');
    return;
  }
  for (const localeKey of requiredLocaleKeys) {
    const pattern = new RegExp(`\\b${localeKey}\\s*:`);
    if (!pattern.test(block)) {
      fail(scope, `Missing ${labelForLocale(localeKey)} value.`);
    }
  }
}

function collectNestedLocalizedBlocks(block, indentSpaces) {
  const blocks = [];
  const regex = new RegExp(`\\n\\s{${indentSpaces}}([A-Za-z0-9_]+):\\s*\\{`, 'g');
  let match;
  while ((match = regex.exec(block)) !== null) {
    const start = block.indexOf('{', match.index);
    const end = findMatching(block, start, '{', '}');
    if (start !== -1 && end !== -1) {
      blocks.push({ name: match[1], text: block.slice(start, end + 1) });
    }
  }
  return blocks;
}

function collectFiles(dirPath, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectRegisteredToolNames(toolDescriptions) {
  const names = new Set(Object.keys(toolDescriptions));
  const serviceRoots = [
    path.join(repoRoot, 'src/main/services/agent-tools'),
  ];
  for (const serviceRoot of serviceRoots) {
    if (!fs.existsSync(serviceRoot)) continue;
    for (const filePath of collectFiles(serviceRoot, (item) => item.endsWith('.ts'))) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(/\bname:\s*['"]([a-z][a-z0-9_]+)['"]/g)) {
        names.add(match[1]);
      }
    }
  }
  return names;
}

function checkSkills(registeredToolNames) {
  const skillDir = path.join(repoRoot, 'src/main/services/agent-skills');
  const skillFiles = fs.readdirSync(skillDir)
    .filter((name) => name.endsWith('.skill.ts'))
    .map((name) => path.join(skillDir, name));
  const skillIds = new Set();

  for (const filePath of skillFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const block = findObjectBlockAfter(source, /export\s+const\s+\w+Skill\b/, rel(filePath));
    const id = block.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1] ?? path.basename(filePath);
    skillIds.add(id);

    for (const propertyName of ['title', 'description', 'workflowPrompt']) {
      checkLocalizedBlockText(extractPropertyBlock(block, propertyName), `skills.${id}.${propertyName}`);
    }

    const prefixesBlock = extractPropertyBlock(block, 'defaultRequestPrefixes');
    if (prefixesBlock) checkLocalizedBlockText(prefixesBlock, `skills.${id}.defaultRequestPrefixes`);

    const materialPromptsBlock = extractPropertyBlock(block, 'materialWorkflowPrompts');
    if (materialPromptsBlock) {
      for (const nestedBlock of collectNestedLocalizedBlocks(materialPromptsBlock, 4)) {
        checkLocalizedBlockText(nestedBlock.text, `skills.${id}.materialWorkflowPrompts.${nestedBlock.name}`);
      }
    }

    for (const toolName of extractPropertyArray(block, 'allowedTools')) {
      if (!registeredToolNames.has(toolName)) {
        fail('skills.allowedTools', `${id} references unregistered tool "${toolName}".`);
      }
    }
  }

  const registrySource = readText('src/main/services/agent-skills/registry.ts');
  const legacyPrefixes = extractConstObject(registrySource, 'legacyGenerationDefaultPrefixes', 'src/main/services/agent-skills/registry.ts');
  checkLocalizedValue(legacyPrefixes, 'skills.legacyGenerationDefaultPrefixes');

  mark('agent skills');
  return skillIds;
}

function checkPromptToolReferences(registeredToolNames, skillIds) {
  const knownNonToolIds = new Set([
    ...skillIds,
    'generate_content',
    'save_artifacts',
    'prepare_context',
    'retrieve_sources',
    'summarize_result',
    'analyze_goal',
    'collect_references',
    'generate_route',
    'save_route',
    'inspect_route',
    'apply_route_changes',
    'refresh_route',
    'analyze_evaluate',
  ]);
  const prefixes = '(?:generate|read|search|save|create|update|add|remove|connect|record|append|web|rag|analyze)';
  const tokenPattern = new RegExp(`\\b${prefixes}_[a-z0-9_]+\\b`, 'g');
  const promptFiles = [
    'src/main/services/agent-i18n/prompt-catalog.ts',
    'src/main/services/prompt/prompt-builder.ts',
    'src/main/services/agent-context/context-builder.ts',
    ...fs.readdirSync(path.join(repoRoot, 'src/main/services/agent-skills'))
      .filter((name) => name.endsWith('.skill.ts'))
      .map((name) => `src/main/services/agent-skills/${name}`),
  ];

  for (const relativePath of promptFiles) {
    const source = readText(relativePath);
    for (const match of source.matchAll(tokenPattern)) {
      const token = match[0];
      if (!registeredToolNames.has(token) && !knownNonToolIds.has(token)) {
        fail('promptToolReferences', `${relativePath} references "${token}", but no registered tool with that name was found.`);
      }
    }
  }

  mark('prompt tool references');
}

try {
  checkFrontendLocales();
  checkMessages();
  const toolDescriptions = checkToolDescriptions();
  checkArtifactNames();
  checkFolderPolicy();
  const registeredToolNames = collectRegisteredToolNames(toolDescriptions);
  const skillIds = checkSkills(registeredToolNames);
  checkPromptToolReferences(registeredToolNames, skillIds);
} catch (error) {
  fail('script', error instanceof Error ? error.message : String(error));
}

if (problems.length > 0) {
  console.error(`i18n check failed with ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`- [${problem.scope}] ${problem.message}`);
  }
  process.exit(1);
}

const strictSuffix = strictLocale ? ` (strict ${strictLocale})` : '';
console.log(`i18n check passed${strictSuffix}: ${checked.join(', ')}.`);
