import { z } from 'zod';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { FolderKey } from '@shared/types';
import type { TutorTool, ToolContext } from '../tutor-tools/index';
import { buildTool, truncateResult } from '../tutor-tools/index';
import { getNodeDir } from '../../fs/content.service';
import {
  getNodeSubfolderNames,
  resolveFolderKey,
} from '../../agent-i18n/folder-policy';
import { localMsg } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import {
  reindexNodeFile,
  reindexNodePath,
  removeNodePathIndexes,
} from '../node-file-index';

const MAX_LIST_ENTRIES = 240;
const MAX_SEARCH_FILES = 360;
const MAX_SEARCH_RESULTS = 50;
const MAX_READ_SECTION_CHARS = 20_000;
const MAX_UPDATE_FILE_CHARS = 1_000_000;
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

interface NodeFileResult {
  success: boolean;
  message: string;
}

interface NodeFileListResult extends NodeFileResult {
  entries?: Array<{
    path: string;
    type: 'file' | 'folder';
    size?: number;
    updatedAt?: string;
  }>;
  truncated?: boolean;
  language?: string;
}

interface NodeFileSearchResult extends NodeFileResult {
  matches?: Array<{
    path: string;
    type: 'filename' | 'heading' | 'content';
    line?: number;
    snippet?: string;
  }>;
  truncated?: boolean;
  language?: string;
}

interface MarkdownHeadingsResult extends NodeFileResult {
  headings?: Array<{
    line: number;
    level: number;
    title: string;
    path: string;
  }>;
  truncated?: boolean;
  language?: string;
}

interface MarkdownSectionResult extends NodeFileResult {
  path?: string;
  heading?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  truncated?: boolean;
  language?: string;
}

class NodeFileToolError extends Error {}

function normalizeRelPath(input: string | undefined, options: { allowEmpty?: boolean } = {}): string {
  const raw = (input ?? '').trim().replace(/\\/g, '/');
  if (!raw) {
    if (options.allowEmpty) return '';
    throw new NodeFileToolError('path is required');
  }
  if (nodePath.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new NodeFileToolError('absolute paths are not allowed');
  }
  const normalized = nodePath.posix.normalize(raw);
  if (normalized === '.') {
    if (options.allowEmpty) return '';
    throw new NodeFileToolError('path is required');
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new NodeFileToolError('.. path segments are not allowed');
  }
  return normalized.replace(/^\/+/, '');
}

function nodeRoot(ctx: ToolContext): string {
  return nodePath.resolve(getNodeDir(ctx.courseId, ctx.nodeId));
}

function resolveNodePath(ctx: ToolContext, relInput: string | undefined, options: { allowEmpty?: boolean } = {}): { root: string; rel: string; fullPath: string } {
  const root = nodeRoot(ctx);
  const rel = normalizeRelPath(relInput, options);
  const fullPath = nodePath.resolve(root, rel);
  if (fullPath !== root && !fullPath.startsWith(root + nodePath.sep)) {
    throw new NodeFileToolError('path escapes the current node workspace');
  }
  return { root, rel, fullPath };
}

function protectedRootNames(): Set<string> {
  return new Set([
    ...getNodeSubfolderNames('zh'),
    ...getNodeSubfolderNames('en'),
    'outline',
    'theory',
    'practice',
    'answer',
    'notes',
    'feynman',
  ]);
}

function assertNotProtectedRoot(rel: string, fullPath: string, root: string): void {
  if (!rel || fullPath === root) throw new NodeFileToolError('cannot operate on the node root directory');
  const normalized = rel.replace(/\/+$/, '');
  if (!normalized.includes('/') && (protectedRootNames().has(normalized) || resolveFolderKey(normalized))) {
    throw new NodeFileToolError('cannot delete, rename, or move a standard material root folder');
  }
}

function assertMutablePath(rel: string, fullPath: string, root: string): void {
  assertNotProtectedRoot(rel, fullPath, root);
  if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
  if (fs.lstatSync(fullPath).isSymbolicLink()) {
    throw new NodeFileToolError(`symbolic links are not supported: ${rel}`);
  }
}

function assertTextFile(fullPath: string, rel: string): void {
  const ext = nodePath.extname(fullPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new NodeFileToolError(`unsupported text file type for update_file: ${rel}`);
  }
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) throw new NodeFileToolError(`symbolic links are not supported: ${rel}`);
  if (!stat.isFile()) throw new NodeFileToolError(`update_file only supports files: ${rel}`);
  if (stat.size > MAX_UPDATE_FILE_CHARS * 4) {
    throw new NodeFileToolError(`file is too large to update safely: ${rel}`);
  }
}

function assertMarkdownFile(fullPath: string, rel: string): void {
  assertTextFile(fullPath, rel);
  const ext = nodePath.extname(fullPath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(ext)) {
    throw new NodeFileToolError(`edit_markdown_file only supports Markdown files: ${rel}`);
  }
}

function isTextSearchFile(fullPath: string): boolean {
  try {
    const ext = nodePath.extname(fullPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return false;
    const stat = fs.lstatSync(fullPath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_UPDATE_FILE_CHARS * 4;
  } catch {
    return false;
  }
}

function readUtf8File(fullPath: string): string {
  return fs.readFileSync(fullPath, 'utf-8').replace(/\r\n/g, '\n');
}

function snippetForLine(line: string, query: string): string {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  const idx = normalized.toLowerCase().indexOf(query.toLowerCase());
  const start = idx >= 0 ? Math.max(0, idx - 70) : 0;
  const end = Math.min(normalized.length, start + 180);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

function folderForPayload(rel: string): FolderKey {
  const first = rel.split('/')[0] ?? '';
  return resolveFolderKey(first) ?? 'notes';
}

function emitRefresh(ctx: ToolContext, filePath: string, rel: string): void {
  ctx.onFileGenerated({
    sessionId: ctx.sessionId,
    filePath,
    folderName: folderForPayload(rel),
    nodeId: ctx.nodeId,
    usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
  });
}

function simpleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new NodeFileToolError('new_name must be a simple file or folder name');
  }
  return trimmed;
}

function formatError(err: unknown, language?: string): NodeFileResult {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    message: localMsg(language, `操作失败：${detail}`, `Operation failed: ${detail}`),
  };
}

export const listNodeFilesTool: TutorTool<{ path?: string }, NodeFileListResult> = buildTool({
  name: 'list_node_files',
  description: toolDescription('list_node_files'),
  inputSchema: z.object({
    path: z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: toolPropertyDescription('list_node_files', 'path') },
    },
  },
  maxResultChars: 6000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<NodeFileListResult> => {
    try {
      const { root, rel, fullPath } = resolveNodePath(ctx, input.path, { allowEmpty: true });
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel || '.'}`);
      const entries: NodeFileListResult['entries'] = [];
      const add = (pathToRead: string) => {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const names = fs.readdirSync(pathToRead, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith('.'))
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        for (const entry of names) {
          if (entries.length >= MAX_LIST_ENTRIES) break;
          const full = nodePath.join(pathToRead, entry.name);
          if (!entry.isDirectory() && !entry.isFile()) continue;
          const stat = fs.lstatSync(full);
          const itemRel = nodePath.relative(root, full).replace(/\\/g, '/');
          entries.push({
            path: itemRel,
            type: entry.isDirectory() ? 'folder' : 'file',
            ...(entry.isFile() ? { size: stat.size } : {}),
            updatedAt: stat.mtime.toISOString(),
          });
          if (entry.isDirectory()) add(full);
        }
      };
      add(fullPath);
      return {
        success: true,
        entries,
        truncated: entries.length >= MAX_LIST_ENTRIES,
        language: ctx.language,
        message: localMsg(ctx.language, `已列出 ${entries.length} 个条目。`, `Listed ${entries.length} item(s).`),
      };
    } catch (err) {
      return { ...formatError(err, ctx.language), language: ctx.language };
    }
  },
  formatResult: (r) => {
    if (!r.success) return r.message;
    const lines = [
      r.message,
      ...(r.entries ?? []).map((entry) => {
        const size = entry.size !== undefined ? `, ${entry.size} bytes` : '';
        const updated = entry.updatedAt ? `, updated ${entry.updatedAt}` : '';
        return `- ${entry.type}: ${entry.path}${size}${updated}`;
      }),
      r.truncated ? localMsg(r.language, `...已截断，仅返回前 ${MAX_LIST_ENTRIES} 个条目。`, `...truncated to the first ${MAX_LIST_ENTRIES} items.`) : '',
    ].filter(Boolean);
    return truncateResult(lines.join('\n'), 6000, r.language);
  },
});

export const searchNodeFilesTool: TutorTool<
  { query: string; path?: string; include_content?: boolean; max_results?: number; extensions?: string[] },
  NodeFileSearchResult
> = buildTool({
  name: 'search_node_files',
  description: toolDescription('search_node_files'),
  inputSchema: z.object({
    query: z.string().min(1),
    path: z.string().optional(),
    include_content: z.boolean().optional(),
    max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
    extensions: z.array(z.string()).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: toolPropertyDescription('search_node_files', 'query') },
      path: { type: 'string', description: toolPropertyDescription('search_node_files', 'path') },
      include_content: { type: 'boolean', description: toolPropertyDescription('search_node_files', 'include_content') },
      max_results: { type: 'number', description: toolPropertyDescription('search_node_files', 'max_results') },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: toolPropertyDescription('search_node_files', 'extensions'),
      },
    },
  },
  maxResultChars: 6000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<NodeFileSearchResult> => {
    try {
      const { root, rel, fullPath } = resolveNodePath(ctx, input.path, { allowEmpty: true });
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel || '.'}`);
      const query = input.query.trim();
      const queryLower = query.toLowerCase();
      const includeContent = input.include_content !== false;
      const maxResults = Math.min(input.max_results ?? 30, MAX_SEARCH_RESULTS);
      const extFilter = input.extensions?.length
        ? new Set(input.extensions.map((ext) => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`))
        : undefined;
      const matches: NodeFileSearchResult['matches'] = [];
      let visitedFiles = 0;
      let truncated = false;

      const pushMatch = (match: NonNullable<NodeFileSearchResult['matches']>[number]): void => {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        matches.push(match);
      };

      const shouldIncludeFile = (filePath: string): boolean => {
        if (!extFilter) return true;
        return extFilter.has(nodePath.extname(filePath).toLowerCase());
      };

      const visit = (pathToRead: string): void => {
        if (matches.length >= maxResults || visitedFiles >= MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }
        const stat = fs.lstatSync(pathToRead);
        if (stat.isSymbolicLink()) return;
        const itemRel = nodePath.relative(root, pathToRead).replace(/\\/g, '/');
        const base = nodePath.basename(pathToRead);
        if (base.toLowerCase().includes(queryLower)) {
          pushMatch({ path: itemRel, type: 'filename', snippet: base });
        }
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(pathToRead, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith('.'))
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            visit(nodePath.join(pathToRead, entry.name));
            if (matches.length >= maxResults || visitedFiles >= MAX_SEARCH_FILES) break;
          }
          return;
        }
        if (!stat.isFile() || !shouldIncludeFile(pathToRead)) return;
        visitedFiles += 1;
        if (!includeContent || !isTextSearchFile(pathToRead)) return;
        const lines = readUtf8File(pathToRead).split('\n');
        const headings = collectMarkdownHeadings(lines);
        for (const heading of headings) {
          if (heading.title.toLowerCase().includes(queryLower) || heading.normalized.includes(queryLower)) {
            pushMatch({ path: itemRel, type: 'heading', line: heading.lineIndex + 1, snippet: heading.title });
          }
          if (matches.length >= maxResults) return;
        }
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(queryLower)) continue;
          pushMatch({ path: itemRel, type: 'content', line: i + 1, snippet: snippetForLine(lines[i], query) });
          if (matches.length >= maxResults) return;
        }
      };

      visit(fullPath);
      return {
        success: true,
        matches,
        truncated,
        language: ctx.language,
        message: localMsg(ctx.language, `找到 ${matches.length} 个匹配。`, `Found ${matches.length} match(es).`),
      };
    } catch (err) {
      return { ...formatError(err, ctx.language), language: ctx.language };
    }
  },
  formatResult: (r) => {
    if (!r.success) return r.message;
    const lines = [
      r.message,
      ...(r.matches ?? []).map((match) => {
        const line = match.line ? `:${match.line}` : '';
        const snippet = match.snippet ? ` — ${match.snippet}` : '';
        return `- ${match.type}: ${match.path}${line}${snippet}`;
      }),
      r.truncated ? localMsg(r.language, '...结果已截断，请缩小 path/query 或提高精确度。', '...results truncated; narrow path/query for more precision.') : '',
    ].filter(Boolean);
    return truncateResult(lines.join('\n'), 6000, r.language);
  },
});

export const updateFileTool: TutorTool<
  { path: string; operation: 'replace_all' | 'append' | 'replace_text'; content?: string; search?: string; replacement?: string },
  NodeFileResult
> = buildTool({
  name: 'update_file',
  description: toolDescription('update_file'),
  inputSchema: z.object({
    path: z.string().min(1),
    operation: z.enum(['replace_all', 'append', 'replace_text']),
    content: z.string().optional(),
    search: z.string().optional(),
    replacement: z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'operation'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('update_file', 'path') },
      operation: { type: 'string', enum: ['replace_all', 'append', 'replace_text'], description: toolPropertyDescription('update_file', 'operation') },
      content: { type: 'string', description: toolPropertyDescription('update_file', 'content') },
      search: { type: 'string', description: toolPropertyDescription('update_file', 'search') },
      replacement: { type: 'string', description: toolPropertyDescription('update_file', 'replacement') },
    },
  },
  maxResultChars: 500,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const { rel, fullPath } = resolveNodePath(ctx, input.path);
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
      assertTextFile(fullPath, rel);
      const current = fs.readFileSync(fullPath, 'utf-8');
      let next = current;
      if (input.operation === 'replace_all') {
        if (input.content === undefined) throw new NodeFileToolError('content is required for replace_all');
        next = input.content;
      } else if (input.operation === 'append') {
        if (input.content === undefined) throw new NodeFileToolError('content is required for append');
        next = current + input.content;
      } else {
        if (!input.search) throw new NodeFileToolError('search is required for replace_text');
        const replacement = input.replacement ?? '';
        const matches = current.split(input.search).length - 1;
        if (matches === 0) throw new NodeFileToolError('search text was not found');
        if (matches > 1) throw new NodeFileToolError(`search text is ambiguous (${matches} matches)`);
        next = current.replace(input.search, replacement);
      }
      if (next.length > MAX_UPDATE_FILE_CHARS) throw new NodeFileToolError('updated file content is too large');
      fs.writeFileSync(fullPath, next, 'utf-8');
      reindexNodeFile(ctx, rel, fullPath);
      emitRefresh(ctx, fullPath, rel);
      return {
        success: true,
        message: localMsg(ctx.language, `文件已更新：${rel}`, `File updated: ${rel}`),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

type MarkdownEditOperation =
  | 'insert_after_heading'
  | 'append_to_section'
  | 'insert_before_heading'
  | 'replace_section';

interface MarkdownHeading {
  lineIndex: number;
  level: number;
  title: string;
  normalized: string;
}

function normalizeHeadingTitle(title: string): string {
  return title
    .replace(/[`*_~#[\]()>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collectMarkdownHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    const title = match[2].trim();
    headings.push({
      lineIndex,
      level: match[1].length,
      title,
      normalized: normalizeHeadingTitle(title),
    });
  });
  return headings;
}

function findSingleHeading(lines: string[], headingText: string, headingLevel?: number): MarkdownHeading {
  const needle = normalizeHeadingTitle(headingText);
  if (!needle) throw new NodeFileToolError('heading is required');
  const matches = collectMarkdownHeadings(lines).filter((heading) => {
    if (headingLevel && heading.level !== headingLevel) return false;
    return heading.normalized === needle || heading.normalized.includes(needle);
  });
  if (matches.length === 0) throw new NodeFileToolError(`heading was not found: ${headingText}`);
  if (matches.length > 1) {
    throw new NodeFileToolError(`heading is ambiguous (${matches.length} matches): ${headingText}`);
  }
  return matches[0];
}

function findSectionEnd(lines: string[], heading: MarkdownHeading): number {
  for (let i = heading.lineIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match && match[1].length <= heading.level) return i;
  }
  return lines.length;
}

function headingPaths(headings: MarkdownHeading[]): Map<MarkdownHeading, string> {
  const stack: MarkdownHeading[] = [];
  const paths = new Map<MarkdownHeading, string>();
  for (const heading of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push(heading);
    paths.set(heading, stack.map((item) => item.title).join(' > '));
  }
  return paths;
}

function normalizeMarkdownContentLines(content: string | undefined): string[] {
  const trimmed = (content ?? '').replace(/\r\n/g, '\n').trim();
  if (!trimmed) throw new NodeFileToolError('content is required');
  return trimmed.split('\n');
}

function insertionBlock(lines: string[], insertAt: number, content: string | undefined): string[] {
  const block = normalizeMarkdownContentLines(content);
  const before = lines[insertAt - 1] ?? '';
  const after = lines[insertAt] ?? '';
  return [
    ...(before.trim() ? [''] : []),
    ...block,
    ...(after.trim() ? [''] : []),
  ];
}

function applyMarkdownHeadingEdit(
  lines: string[],
  input: { operation: MarkdownEditOperation; heading: string; content: string; heading_level?: number },
): MarkdownHeading {
  const heading = findSingleHeading(lines, input.heading, input.heading_level);
  const sectionEnd = findSectionEnd(lines, heading);

  if (input.operation === 'insert_after_heading') {
    const insertAt = heading.lineIndex + 1;
    lines.splice(insertAt, 0, ...insertionBlock(lines, insertAt, input.content));
  } else if (input.operation === 'append_to_section') {
    lines.splice(sectionEnd, 0, ...insertionBlock(lines, sectionEnd, input.content));
  } else if (input.operation === 'insert_before_heading') {
    lines.splice(heading.lineIndex, 0, ...insertionBlock(lines, heading.lineIndex, input.content));
  } else {
    const insertAt = heading.lineIndex + 1;
    lines.splice(insertAt, sectionEnd - heading.lineIndex - 1, ...insertionBlock(lines, insertAt, input.content));
  }
  return heading;
}

export const listMarkdownHeadingsTool: TutorTool<{ path: string; max_headings?: number }, MarkdownHeadingsResult> = buildTool({
  name: 'list_markdown_headings',
  description: toolDescription('list_markdown_headings'),
  inputSchema: z.object({
    path: z.string().min(1),
    max_headings: z.number().int().min(1).max(200).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('list_markdown_headings', 'path') },
      max_headings: { type: 'number', description: toolPropertyDescription('list_markdown_headings', 'max_headings') },
    },
  },
  maxResultChars: 5000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<MarkdownHeadingsResult> => {
    try {
      const { rel, fullPath } = resolveNodePath(ctx, input.path);
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
      assertMarkdownFile(fullPath, rel);
      const lines = readUtf8File(fullPath).split('\n');
      const headings = collectMarkdownHeadings(lines);
      const paths = headingPaths(headings);
      const limit = input.max_headings ?? 120;
      return {
        success: true,
        headings: headings.slice(0, limit).map((heading) => ({
          line: heading.lineIndex + 1,
          level: heading.level,
          title: heading.title,
          path: paths.get(heading) ?? heading.title,
        })),
        truncated: headings.length > limit,
        language: ctx.language,
        message: localMsg(ctx.language, `已读取 ${Math.min(headings.length, limit)} 个标题。`, `Read ${Math.min(headings.length, limit)} heading(s).`),
      };
    } catch (err) {
      return { ...formatError(err, ctx.language), language: ctx.language };
    }
  },
  formatResult: (r) => {
    if (!r.success) return r.message;
    const lines = [
      r.message,
      ...(r.headings ?? []).map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}- L${heading.level} line ${heading.line}: ${heading.path}`),
      r.truncated ? localMsg(r.language, '...标题列表已截断。', '...heading list truncated.') : '',
    ].filter(Boolean);
    return truncateResult(lines.join('\n'), 5000, r.language);
  },
});

export const readMarkdownSectionTool: TutorTool<
  { path: string; heading: string; heading_level?: number; include_heading?: boolean; max_chars?: number },
  MarkdownSectionResult
> = buildTool({
  name: 'read_markdown_section',
  description: toolDescription('read_markdown_section'),
  inputSchema: z.object({
    path: z.string().min(1),
    heading: z.string().min(1),
    heading_level: z.number().int().min(1).max(6).optional(),
    include_heading: z.boolean().optional(),
    max_chars: z.number().int().min(500).max(MAX_READ_SECTION_CHARS).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'heading'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('read_markdown_section', 'path') },
      heading: { type: 'string', description: toolPropertyDescription('read_markdown_section', 'heading') },
      heading_level: { type: 'number', description: toolPropertyDescription('read_markdown_section', 'heading_level') },
      include_heading: { type: 'boolean', description: toolPropertyDescription('read_markdown_section', 'include_heading') },
      max_chars: { type: 'number', description: toolPropertyDescription('read_markdown_section', 'max_chars') },
    },
  },
  maxResultChars: MAX_READ_SECTION_CHARS + 500,
  isReadOnly: true,
  execute: async (input, ctx): Promise<MarkdownSectionResult> => {
    try {
      const { rel, fullPath } = resolveNodePath(ctx, input.path);
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
      assertMarkdownFile(fullPath, rel);
      const lines = readUtf8File(fullPath).split('\n');
      const heading = findSingleHeading(lines, input.heading, input.heading_level);
      const sectionEnd = findSectionEnd(lines, heading);
      const start = input.include_heading === false ? heading.lineIndex + 1 : heading.lineIndex;
      const content = lines.slice(start, sectionEnd).join('\n').trim();
      const maxChars = input.max_chars ?? 12_000;
      return {
        success: true,
        path: rel,
        heading: heading.title,
        startLine: start + 1,
        endLine: sectionEnd,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
        language: ctx.language,
        message: localMsg(ctx.language, `已读取小节：${heading.title}`, `Read section: ${heading.title}`),
      };
    } catch (err) {
      return { ...formatError(err, ctx.language), language: ctx.language };
    }
  },
  formatResult: (r) => {
    if (!r.success) return r.message;
    const header = `${r.message} (${r.path}:${r.startLine}-${r.endLine})`;
    return `${header}\n\n${r.content ?? ''}${r.truncated ? localMsg(r.language, '\n\n...小节内容已截断。', '\n\n...section truncated.') : ''}`;
  },
});

export const editMarkdownFileTool: TutorTool<
  { path: string; operation: MarkdownEditOperation; heading: string; content: string; heading_level?: number },
  NodeFileResult
> = buildTool({
  name: 'edit_markdown_file',
  description: toolDescription('edit_markdown_file'),
  inputSchema: z.object({
    path: z.string().min(1),
    operation: z.enum(['insert_after_heading', 'append_to_section', 'insert_before_heading', 'replace_section']),
    heading: z.string().min(1),
    content: z.string().min(1),
    heading_level: z.number().int().min(1).max(6).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'operation', 'heading', 'content'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('edit_markdown_file', 'path') },
      operation: {
        type: 'string',
        enum: ['insert_after_heading', 'append_to_section', 'insert_before_heading', 'replace_section'],
        description: toolPropertyDescription('edit_markdown_file', 'operation'),
      },
      heading: { type: 'string', description: toolPropertyDescription('edit_markdown_file', 'heading') },
      heading_level: { type: 'number', description: toolPropertyDescription('edit_markdown_file', 'heading_level') },
      content: { type: 'string', description: toolPropertyDescription('edit_markdown_file', 'content') },
    },
  },
  maxResultChars: 700,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const { rel, fullPath } = resolveNodePath(ctx, input.path);
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
      assertMarkdownFile(fullPath, rel);
      const current = readUtf8File(fullPath);
      const lines = current.split('\n');
      const heading = applyMarkdownHeadingEdit(lines, input);

      const next = lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
      if (next.length > MAX_UPDATE_FILE_CHARS) throw new NodeFileToolError('updated file content is too large');
      fs.writeFileSync(fullPath, next, 'utf-8');
      reindexNodeFile(ctx, rel, fullPath);
      emitRefresh(ctx, fullPath, rel);
      return {
        success: true,
        message: localMsg(
          ctx.language,
          `Markdown 已更新：${rel}（${input.operation} @ ${heading.title}）`,
          `Markdown updated: ${rel} (${input.operation} @ ${heading.title})`,
        ),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

type MarkdownPatchOperation =
  | { operation: MarkdownEditOperation; heading: string; content: string; heading_level?: number }
  | { operation: 'replace_text'; search: string; replacement?: string };

export const patchMarkdownFileTool: TutorTool<{ path: string; operations: MarkdownPatchOperation[] }, NodeFileResult> = buildTool({
  name: 'patch_markdown_file',
  description: toolDescription('patch_markdown_file'),
  inputSchema: z.object({
    path: z.string().min(1),
    operations: z.array(z.union([
      z.object({
        operation: z.enum(['insert_after_heading', 'append_to_section', 'insert_before_heading', 'replace_section']),
        heading: z.string().min(1),
        content: z.string().min(1),
        heading_level: z.number().int().min(1).max(6).optional(),
      }),
      z.object({
        operation: z.literal('replace_text'),
        search: z.string().min(1),
        replacement: z.string().optional(),
      }),
    ])).min(1).max(20),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'operations'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('patch_markdown_file', 'path') },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: toolPropertyDescription('patch_markdown_file', 'operations'),
        items: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['insert_after_heading', 'append_to_section', 'insert_before_heading', 'replace_section', 'replace_text'],
              description: toolPropertyDescription('patch_markdown_file', 'operation'),
            },
            heading: { type: 'string', description: toolPropertyDescription('patch_markdown_file', 'heading') },
            heading_level: { type: 'number', description: toolPropertyDescription('patch_markdown_file', 'heading_level') },
            content: { type: 'string', description: toolPropertyDescription('patch_markdown_file', 'content') },
            search: { type: 'string', description: toolPropertyDescription('patch_markdown_file', 'search') },
            replacement: { type: 'string', description: toolPropertyDescription('patch_markdown_file', 'replacement') },
          },
        },
      },
    },
  },
  maxResultChars: 1000,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const { rel, fullPath } = resolveNodePath(ctx, input.path);
      if (!fs.existsSync(fullPath)) throw new NodeFileToolError(`path does not exist: ${rel}`);
      assertMarkdownFile(fullPath, rel);
      const current = readUtf8File(fullPath);
      const lines = current.split('\n');
      const summaries: string[] = [];

      for (const [index, op] of input.operations.entries()) {
        if (op.operation === 'replace_text') {
          const currentText = lines.join('\n');
          const matches = currentText.split(op.search).length - 1;
          if (matches === 0) throw new NodeFileToolError(`operation ${index + 1}: search text was not found`);
          if (matches > 1) throw new NodeFileToolError(`operation ${index + 1}: search text is ambiguous (${matches} matches)`);
          lines.splice(0, lines.length, ...currentText.replace(op.search, op.replacement ?? '').split('\n'));
          summaries.push(`replace_text #${index + 1}`);
        } else {
          const heading = applyMarkdownHeadingEdit(lines, op);
          summaries.push(`${op.operation} @ ${heading.title}`);
        }
      }

      const next = lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
      if (next.length > MAX_UPDATE_FILE_CHARS) throw new NodeFileToolError('updated file content is too large');
      fs.writeFileSync(fullPath, next, 'utf-8');
      reindexNodeFile(ctx, rel, fullPath);
      emitRefresh(ctx, fullPath, rel);
      return {
        success: true,
        message: localMsg(
          ctx.language,
          `Markdown 批量补丁已完成：${rel}（${summaries.join('；')}）`,
          `Markdown patch completed: ${rel} (${summaries.join('; ')})`,
        ),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

export const deleteNodeItemTool: TutorTool<{ path: string }, NodeFileResult> = buildTool({
  name: 'delete_node_item',
  description: toolDescription('delete_node_item'),
  inputSchema: z.object({ path: z.string().min(1) }),
  inputJsonSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('delete_node_item', 'path') },
    },
  },
  maxResultChars: 400,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const { root, rel, fullPath } = resolveNodePath(ctx, input.path);
      assertMutablePath(rel, fullPath, root);
      const stat = fs.lstatSync(fullPath);
      removeNodePathIndexes(ctx, root, fullPath);
      if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
      else fs.unlinkSync(fullPath);
      emitRefresh(ctx, fullPath, rel);
      return {
        success: true,
        message: localMsg(ctx.language, `已删除：${rel}`, `Deleted: ${rel}`),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

export const renameNodeItemTool: TutorTool<{ path: string; new_name: string }, NodeFileResult> = buildTool({
  name: 'rename_node_item',
  description: toolDescription('rename_node_item'),
  inputSchema: z.object({ path: z.string().min(1), new_name: z.string().min(1) }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'new_name'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('rename_node_item', 'path') },
      new_name: { type: 'string', description: toolPropertyDescription('rename_node_item', 'new_name') },
    },
  },
  maxResultChars: 400,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const { root, rel, fullPath } = resolveNodePath(ctx, input.path);
      assertMutablePath(rel, fullPath, root);
      const targetName = simpleName(input.new_name);
      const targetPath = nodePath.join(nodePath.dirname(fullPath), targetName);
      const targetRel = nodePath.relative(root, targetPath).replace(/\\/g, '/');
      assertNotProtectedRoot(targetRel, targetPath, root);
      if (fs.existsSync(targetPath)) throw new NodeFileToolError(`target already exists: ${targetRel}`);
      removeNodePathIndexes(ctx, root, fullPath);
      fs.renameSync(fullPath, targetPath);
      reindexNodePath(ctx, root, targetPath);
      emitRefresh(ctx, targetPath, targetRel);
      return {
        success: true,
        message: localMsg(ctx.language, `已重命名：${rel} → ${targetRel}`, `Renamed: ${rel} -> ${targetRel}`),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

export const moveNodeItemTool: TutorTool<{ path: string; destination_path: string }, NodeFileResult> = buildTool({
  name: 'move_node_item',
  description: toolDescription('move_node_item'),
  inputSchema: z.object({ path: z.string().min(1), destination_path: z.string().min(1) }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'destination_path'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('move_node_item', 'path') },
      destination_path: { type: 'string', description: toolPropertyDescription('move_node_item', 'destination_path') },
    },
  },
  maxResultChars: 400,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const source = resolveNodePath(ctx, input.path);
      assertMutablePath(source.rel, source.fullPath, source.root);
      const dest = resolveNodePath(ctx, input.destination_path);
      assertNotProtectedRoot(dest.rel, dest.fullPath, source.root);
      if (fs.existsSync(dest.fullPath)) throw new NodeFileToolError(`target already exists: ${dest.rel}`);
      if (dest.fullPath.startsWith(source.fullPath + nodePath.sep)) {
        throw new NodeFileToolError('cannot move a folder into itself');
      }
      removeNodePathIndexes(ctx, source.root, source.fullPath);
      fs.mkdirSync(nodePath.dirname(dest.fullPath), { recursive: true });
      fs.renameSync(source.fullPath, dest.fullPath);
      reindexNodePath(ctx, source.root, dest.fullPath);
      emitRefresh(ctx, dest.fullPath, dest.rel);
      return {
        success: true,
        message: localMsg(ctx.language, `已移动：${source.rel} → ${dest.rel}`, `Moved: ${source.rel} -> ${dest.rel}`),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});

export const copyNodeItemTool: TutorTool<{ path: string; destination_path: string; overwrite?: boolean }, NodeFileResult> = buildTool({
  name: 'copy_node_item',
  description: toolDescription('copy_node_item'),
  inputSchema: z.object({
    path: z.string().min(1),
    destination_path: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path', 'destination_path'],
    properties: {
      path: { type: 'string', description: toolPropertyDescription('copy_node_item', 'path') },
      destination_path: { type: 'string', description: toolPropertyDescription('copy_node_item', 'destination_path') },
      overwrite: { type: 'boolean', description: toolPropertyDescription('copy_node_item', 'overwrite') },
    },
  },
  maxResultChars: 500,
  isReadOnly: false,
  execute: async (input, ctx): Promise<NodeFileResult> => {
    try {
      const source = resolveNodePath(ctx, input.path);
      assertMutablePath(source.rel, source.fullPath, source.root);
      assertNotProtectedRoot(source.rel, source.fullPath, source.root);
      const dest = resolveNodePath(ctx, input.destination_path);
      assertNotProtectedRoot(dest.rel, dest.fullPath, source.root);
      if (dest.fullPath.startsWith(source.fullPath + nodePath.sep)) {
        throw new NodeFileToolError('cannot copy a folder into itself');
      }
      if (fs.existsSync(dest.fullPath)) {
        if (!input.overwrite) throw new NodeFileToolError(`target already exists: ${dest.rel}`);
        removeNodePathIndexes(ctx, source.root, dest.fullPath);
        fs.rmSync(dest.fullPath, { recursive: true, force: true });
      }
      fs.mkdirSync(nodePath.dirname(dest.fullPath), { recursive: true });
      fs.cpSync(source.fullPath, dest.fullPath, { recursive: true, force: false });
      reindexNodePath(ctx, source.root, dest.fullPath);
      emitRefresh(ctx, dest.fullPath, dest.rel);
      return {
        success: true,
        message: localMsg(ctx.language, `已复制：${source.rel} → ${dest.rel}`, `Copied: ${source.rel} -> ${dest.rel}`),
      };
    } catch (err) {
      return formatError(err, ctx.language);
    }
  },
  formatResult: (r) => r.message,
});
