import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type {
  MarkdownCodeBlockRange,
  MarkdownImageRange,
  MarkdownLinkRange,
  MarkdownMathRange,
  MarkdownRange,
  MarkdownTableRange,
  MarkdownTaskMarkerRange,
} from './types';

const DISPLAY_DOLLAR = '$$';
const INLINE_DOLLAR = '$';
const DISPLAY_BRACKET_OPEN = '\\[';
const DISPLAY_BRACKET_CLOSE = '\\]';
const INLINE_PAREN_OPEN = '\\(';
const INLINE_PAREN_CLOSE = '\\)';

export function docText(state: EditorState, from: number, to: number): string {
  return state.sliceDoc(from, to);
}

export function intersectsRange(from: number, to: number, ranges: readonly MarkdownRange[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

export function isRangeContainedInRanges(from: number, to: number, ranges: readonly MarkdownRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}

export function isPositionInRanges(position: number, ranges: readonly MarkdownRange[]): boolean {
  return ranges.some((range) => position >= range.from && position < range.to);
}

export function normalizeMarkdownPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function markdownDirname(filePath: string): string {
  const normalized = normalizeMarkdownPath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

export function resolveMarkdownAssetPath(src: string, markdownFilePath: string): string {
  const trimmed = src.trim();
  if (!trimmed) return '';
  if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return trimmed;

  let localPath = trimmed.startsWith('file://')
    ? decodeURIComponent(trimmed.replace(/^file:\/\//i, ''))
    : decodeURIComponent(trimmed);

  if (/^[A-Za-z]:\//.test(localPath) || localPath.startsWith('/')) {
    return normalizePathSegments(localPath);
  }

  const baseDir = markdownDirname(markdownFilePath);
  if (!baseDir) return normalizePathSegments(localPath);
  localPath = `${baseDir}/${localPath}`;
  return normalizePathSegments(localPath);
}

function normalizePathSegments(filePath: string): string {
  const normalized = normalizeMarkdownPath(filePath);
  const driveMatch = normalized.match(/^[A-Za-z]:/);
  const drive = driveMatch?.[0] ?? '';
  const absolute = normalized.startsWith('/') || Boolean(drive);
  const withoutDrive = drive ? normalized.slice(drive.length) : normalized;
  const parts = withoutDrive.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!absolute) {
        stack.push(part);
      }
      continue;
    }
    stack.push(part);
  }

  const prefix = drive || (absolute ? '/' : '');
  return `${prefix}${stack.join('/')}`;
}

export function isRangeActive(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((selection) => {
    if (selection.empty) return selection.from >= from && selection.from <= to;
    return selection.from <= to && selection.to >= from;
  });
}

export function isLineActive(state: EditorState, from: number, to: number): boolean {
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(Math.max(from, to - 1));
  return state.selection.ranges.some((selection) => {
    const cursor = selection.head;
    return cursor >= startLine.from && cursor <= endLine.to;
  });
}

export function collectExcludedRanges(state: EditorState): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'FencedCode' || node.name === 'InlineCode') {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return ranges;
}

export function collectCodeBlocks(state: EditorState): MarkdownCodeBlockRange[] {
  const blocks: MarkdownCodeBlockRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return undefined;
      const syntaxNode = node.node;
      const infoNode = syntaxNode.getChild('CodeInfo');
      const textNode = syntaxNode.getChild('CodeText');
      blocks.push({
        from: node.from,
        to: node.to,
        info: infoNode ? docText(state, infoNode.from, infoNode.to).trim() : '',
        code: textNode ? docText(state, textNode.from, textNode.to) : '',
        codeFrom: textNode ? textNode.from : node.to,
        codeTo: textNode ? textNode.to : node.to,
      });
      return false;
    },
  });
  return blocks;
}

export function collectTables(state: EditorState): MarkdownTableRange[] {
  const tables: MarkdownTableRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined;
      tables.push({ from: node.from, to: node.to, source: docText(state, node.from, node.to) });
      return false;
    },
  });

  const excluded = collectExcludedRanges(state);
  const blocked = [...excluded, ...tables];
  for (const table of collectPipeTables(state, blocked)) {
    if (!intersectsRange(table.from, table.to, blocked)) {
      tables.push(table);
      blocked.push(table);
    }
  }

  return tables.sort((a, b) => a.from - b.from || a.to - b.to);
}

function collectPipeTables(state: EditorState, blocked: readonly MarkdownRange[]): MarkdownTableRange[] {
  const tables: MarkdownTableRange[] = [];
  let lineNumber = 2;

  while (lineNumber <= state.doc.lines) {
    const delimiterLine = state.doc.line(lineNumber);
    if (!isMarkdownTableDelimiterLine(delimiterLine.text)) {
      lineNumber += 1;
      continue;
    }

    const headerLine = state.doc.line(lineNumber - 1);
    if (!isMarkdownTableRow(headerLine.text)) {
      lineNumber += 1;
      continue;
    }

    let to = delimiterLine.to;
    let nextLineNumber = lineNumber + 1;
    while (nextLineNumber <= state.doc.lines) {
      const rowLine = state.doc.line(nextLineNumber);
      if (!isMarkdownTableRow(rowLine.text) || isMarkdownTableDelimiterLine(rowLine.text)) break;
      to = rowLine.to;
      nextLineNumber += 1;
    }

    const from = headerLine.from;
    if (!intersectsRange(from, to, blocked)) {
      tables.push({ from, to, source: docText(state, from, to) });
    }
    lineNumber = Math.max(nextLineNumber, lineNumber + 1);
  }

  return tables;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) return false;
  return countUnescapedPipes(trimmed) >= 2 || (trimmed.startsWith('|') && countUnescapedPipes(trimmed) >= 1);
}

function isMarkdownTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function countUnescapedPipes(line: string): number {
  let count = 0;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') count += 1;
  }
  return count;
}

export function collectImages(state: EditorState): MarkdownImageRange[] {
  const images: MarkdownImageRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Image') return undefined;
      const syntaxNode = node.node;
      const urlNode = syntaxNode.getChild('URL');
      const src = urlNode ? docText(state, urlNode.from, urlNode.to).trim() : '';
      const raw = docText(state, node.from, node.to);
      const alt = raw.match(/^!\[([^\]]*)\]/)?.[1] ?? '';
      images.push({ from: node.from, to: node.to, alt, src });
      return false;
    },
  });
  return images;
}

export function collectTaskMarkers(state: EditorState): MarkdownTaskMarkerRange[] {
  const tasks: MarkdownTaskMarkerRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'TaskMarker') return undefined;
      const marker = docText(state, node.from, node.to);
      tasks.push({ from: node.from, to: node.to, checked: /\[[xX]\]/.test(marker) });
      return false;
    },
  });
  return tasks;
}

export function collectLinkAtPosition(state: EditorState, position: number): MarkdownLinkRange | null {
  const line = state.doc.lineAt(position);
  let found: MarkdownLinkRange | null = null;

  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (found || position < node.from || position > node.to) return false;

      if (node.name === 'Link' || node.name === 'Autolink') {
        found = markdownLinkFromNode(state, node.node, position);
        return found ? false : undefined;
      }

      if (node.name === 'URL') {
        const url = docText(state, node.from, node.to).trim();
        if (/^https?:\/\//i.test(url) && position >= node.from && position <= node.to) {
          found = { from: node.from, to: node.to, textFrom: node.from, textTo: node.to, url };
          return false;
        }
      }

      return undefined;
    },
  });

  return found;
}

function markdownLinkFromNode(state: EditorState, node: SyntaxNode, position: number): MarkdownLinkRange | null {
  const urlNode = node.getChild('URL');
  if (!urlNode) return null;

  const children = directChildren(node);
  const firstMark = children.find((child) => child.name === 'LinkMark');
  const closingLabel = children.find((child) => child.name === 'LinkMark' && docText(state, child.from, child.to) === ']');
  const url = docText(state, urlNode.from, urlNode.to).trim();

  if (node.name === 'Autolink') {
    return position >= urlNode.from && position <= urlNode.to
      ? { from: node.from, to: node.to, textFrom: urlNode.from, textTo: urlNode.to, url }
      : null;
  }

  if (!firstMark || !closingLabel) return null;
  const textFrom = firstMark.to;
  const textTo = closingLabel.from;
  if (position < node.from || position > node.to) return null;
  return { from: node.from, to: node.to, textFrom, textTo, url };
}

export function collectMathRanges(state: EditorState, excluded: readonly MarkdownRange[]): MarkdownMathRange[] {
  const text = state.doc.toString();
  const ranges: MarkdownMathRange[] = [];
  const blocked = [...excluded];

  collectDelimitedMath(text, DISPLAY_DOLLAR, DISPLAY_DOLLAR, true, blocked, ranges);
  collectDelimitedMath(text, DISPLAY_BRACKET_OPEN, DISPLAY_BRACKET_CLOSE, true, blocked, ranges);
  collectDelimitedMath(text, INLINE_PAREN_OPEN, INLINE_PAREN_CLOSE, false, blocked, ranges);
  collectInlineDollarMath(text, blocked, ranges);

  return ranges.sort((a, b) => a.from - b.from || a.to - b.to);
}

function collectDelimitedMath(
  text: string,
  open: string,
  close: string,
  displayMode: boolean,
  blocked: MarkdownRange[],
  ranges: MarkdownMathRange[],
): void {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start < 0) return;
    if (isEscaped(text, start) || isPositionInRanges(start, blocked)) {
      cursor = start + open.length;
      continue;
    }

    const bodyFrom = start + open.length;
    const end = findDelimiter(text, close, bodyFrom, blocked);
    if (end < 0) return;
    const to = end + close.length;
    if (!intersectsRange(start, to, blocked)) {
      ranges.push({
        from: start,
        to,
        bodyFrom,
        bodyTo: end,
        formula: text.slice(bodyFrom, end),
        displayMode,
      });
      blocked.push({ from: start, to });
    }
    cursor = to;
  }
}

function collectInlineDollarMath(
  text: string,
  blocked: MarkdownRange[],
  ranges: MarkdownMathRange[],
): void {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(INLINE_DOLLAR, cursor);
    if (start < 0) return;
    const next = text[start + 1];
    if (next === INLINE_DOLLAR || isEscaped(text, start) || isPositionInRanges(start, blocked)) {
      cursor = start + 1;
      continue;
    }

    const bodyFrom = start + 1;
    const lineEnd = text.indexOf('\n', bodyFrom);
    const searchEnd = lineEnd >= 0 ? lineEnd : text.length;
    let end = -1;
    for (let index = bodyFrom; index < searchEnd; index += 1) {
      if (text[index] !== INLINE_DOLLAR) continue;
      if (text[index + 1] === INLINE_DOLLAR || isEscaped(text, index) || isPositionInRanges(index, blocked)) continue;
      end = index;
      break;
    }

    if (end < 0) {
      cursor = start + 1;
      continue;
    }

    const formula = text.slice(bodyFrom, end);
    if (formula.trim() && !intersectsRange(start, end + 1, blocked)) {
      ranges.push({
        from: start,
        to: end + 1,
        bodyFrom,
        bodyTo: end,
        formula,
        displayMode: false,
      });
      blocked.push({ from: start, to: end + 1 });
    }
    cursor = end + 1;
  }
}

function findDelimiter(text: string, delimiter: string, from: number, blocked: readonly MarkdownRange[]): number {
  let cursor = from;
  while (cursor < text.length) {
    const index = text.indexOf(delimiter, cursor);
    if (index < 0) return -1;
    if (!isEscaped(text, index) && !isPositionInRanges(index, blocked)) return index;
    cursor = index + delimiter.length;
  }
  return -1;
}

function isEscaped(text: string, position: number): boolean {
  let slashCount = 0;
  for (let index = position - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function directChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  let child = node.firstChild;
  while (child) {
    children.push(child);
    child = child.nextSibling;
  }
  return children;
}

