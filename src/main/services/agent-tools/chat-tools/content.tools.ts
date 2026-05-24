/**
 * Content management tools — read existing materials, record mistakes, append notes.
 * These give the AI visibility into what the user has already learned/saved,
 * enabling context-aware responses and incremental knowledge building.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as nodePath from 'path';
import { FOLDER_KEYS, type FolderKey } from '@shared/types';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool, truncateResult } from '../tutor-tools/index';
import { getFolderPath, getNodeDir, writeFileContent } from '../../fs/content.service';
import { NodeRepository } from '../../db/repositories/node.repo';
import { getFolderName, MATERIAL_READ_FOLDER_KEYS } from '../../agent-i18n/folder-policy';
import { getDefaultNoteTitle, getTimestampedArtifactFilename, sanitizeFilenamePart } from '../../agent-i18n/artifact-names';
import { message, normalizeLanguage } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { readSourceForAgent, searchLibraryForAgent } from '../library-tools.shared';
import { normalizeAgentError } from '../../agent-core/agent-errors';
import { blockLibraryMessage } from '../search-mode-guard';
import { reindexNodeFile } from '../node-file-index';

const nodeRepo = new NodeRepository();

const NODE_FOLDERS = MATERIAL_READ_FOLDER_KEYS;
const READ_FILE_FOLDERS = FOLDER_KEYS;
const PREVIEW_CHARS = 400;

// ── read_materials ────────────────────────────────────────────────────────────

interface ReadResult {
  language?: string;
  folders: Array<{ name: FolderKey; files: Array<{ name: string; preview: string }> }>;
}

export const readMaterialsTool: TutorTool<{ folder?: FolderKey }, ReadResult> = buildTool({
  name: 'read_materials',
  description: toolDescription('read_materials'),
  inputSchema: z.object({
    folder: z.enum(['theory', 'practice', 'answer', 'notes', 'feynman']).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        enum: ['theory', 'practice', 'answer', 'notes', 'feynman'],
        description: toolPropertyDescription('read_materials', 'folder'),
      },
    },
  },
  maxResultChars: 6000,
  isReadOnly: true,
  execute: (input, ctx): Promise<ReadResult> => {
    const folders = input.folder ? [input.folder] : [...NODE_FOLDERS];
    const result: ReadResult = { language: ctx.language, folders: [] };

    for (const folderName of folders) {
      const dirPath = getFolderPath(ctx.courseId, ctx.nodeId, folderName);
      const files: Array<{ name: string; preview: string }> = [];

      if (fs.existsSync(dirPath)) {
        try {
          for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.txt'))) {
              const content = fs.readFileSync(nodePath.join(dirPath, entry.name), 'utf-8');
              files.push({ name: entry.name, preview: content.slice(0, PREVIEW_CHARS) });
            }
          }
        } catch { /* ignore unreadable dirs */ }
      }

      result.folders.push({ name: folderName, files });
    }

    return Promise.resolve(result);
  },
  formatResult: (r) => {
    const lines: string[] = [];
    for (const f of r.folders) {
      const displayName = getFolderName(f.name, r.language);
      if (f.files.length === 0) {
        lines.push(message('readFolderEmpty', r.language, { folder: displayName }));
      } else {
        lines.push(`[${displayName}]`);
        for (const file of f.files) {
          lines.push(`• ${file.name}\n${file.preview}${file.preview.length >= PREVIEW_CHARS ? '…' : ''}`);
        }
      }
    }
    return truncateResult(lines.join('\n\n'), 6000, r.language);
  },
});

// ── record_mistake ────────────────────────────────────────────────────────────

interface MistakeResult { success: boolean; message: string }

export const recordMistakeTool: TutorTool<
  { question: string; my_answer: string; correct_answer: string; analysis?: string },
  MistakeResult
> = buildTool({
  name: 'record_mistake',
  description: toolDescription('record_mistake'),
  inputSchema: z.object({
    question:       z.string().min(1),
    my_answer:      z.string().min(1),
    correct_answer: z.string().min(1),
    analysis:       z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['question', 'my_answer', 'correct_answer'],
    properties: {
      question:       { type: 'string', description: toolPropertyDescription('record_mistake', 'question') },
      my_answer:      { type: 'string', description: toolPropertyDescription('record_mistake', 'my_answer') },
      correct_answer: { type: 'string', description: toolPropertyDescription('record_mistake', 'correct_answer') },
      analysis:       { type: 'string', description: toolPropertyDescription('record_mistake', 'analysis') },
    },
  },
  maxResultChars: 200,
  isReadOnly: false,
  execute: (input, ctx): Promise<MistakeResult> => {
    const dir = getFolderPath(ctx.courseId, ctx.nodeId, 'practice');
    const filePath = nodePath.join(dir, 'mistakes.md');
    const date = new Date().toISOString().slice(0, 10);

    const entry = [
      '\n---\n',
      `## ${date} 错题记录\n\n`,
      `**题目**：${input.question}\n\n`,
      `**我的答案**：${input.my_answer}\n\n`,
      `**正确答案**：${input.correct_answer}\n\n`,
      input.analysis ? `**分析**：${input.analysis}\n` : '',
    ].join('');

    try {
      if (!fs.existsSync(filePath)) {
        writeFileContent(filePath, `# 错题本\n${entry}`);
      } else {
        fs.appendFileSync(filePath, entry, 'utf-8');
      }
      const relPath = nodePath.relative(getNodeDir(ctx.courseId, ctx.nodeId), filePath).replace(/\\/g, '/');
      reindexNodeFile(ctx, relPath, filePath);
      ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'practice', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
      const folderName = getFolderName('practice', ctx.language);
      return Promise.resolve({ success: true, message: message('mistakeRecorded', ctx.language, { path: `${folderName}/mistakes.md` }) });
    } catch (err) {
      return Promise.resolve({ success: false, message: normalizeAgentError(err, 'SAVE_FAILED').message });
    }
  },
  formatResult: (r) => r.message,
});

// ── append_to_notes ───────────────────────────────────────────────────────────

interface NotesResult { success: boolean; fileName?: string; message: string }

export const appendToNotesTool: TutorTool<{ content: string; title?: string }, NotesResult> = buildTool({
  name: 'append_to_notes',
  description: toolDescription('append_to_notes'),
  inputSchema: z.object({
    content: z.string().min(1),
    title:   z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: { type: 'string', description: toolPropertyDescription('append_to_notes', 'content') },
      title:   { type: 'string', description: toolPropertyDescription('append_to_notes', 'title') },
    },
  },
  maxResultChars: 200,
  isReadOnly: false,
  execute: (input, ctx): Promise<NotesResult> => {
    const notesDir = getFolderPath(ctx.courseId, ctx.nodeId, 'notes');
    const fallback = getDefaultNoteTitle(ctx.language);
    const title = input.title ? sanitizeFilenamePart(input.title, fallback, 20) : undefined;
    const fileName = getTimestampedArtifactFilename('note', { title }, ctx.language);
    const filePath = nodePath.join(notesDir, fileName);

    try {
      writeFileContent(filePath, input.content);
      const relPath = nodePath.relative(getNodeDir(ctx.courseId, ctx.nodeId), filePath).replace(/\\/g, '/');
      reindexNodeFile(ctx, relPath, filePath);
      ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'notes', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
      return Promise.resolve({ success: true, fileName, message: message('noteSaved', ctx.language, { filename: fileName }) });
    } catch (err) {
      return Promise.resolve({ success: false, message: normalizeAgentError(err, 'SAVE_FAILED').message });
    }
  },
  formatResult: (r) => r.message,
});

// ── read_file ─────────────────────────────────────────────────────────────────

interface ReadFileResult { success: boolean; content?: string; message: string; language?: string }

function normalizeNodeRelativePath(input: string): string | null {
  const cleanedInput = input.trim().replace(/\\/g, '/');
  if (!cleanedInput || nodePath.isAbsolute(cleanedInput)) return null;
  const normalized = nodePath.normalize(cleanedInput);
  if (normalized === '.' || normalized.startsWith(`..${nodePath.sep}`) || normalized === '..') return null;
  return normalized.split(nodePath.sep).join('/');
}

function resolveInside(baseDir: string, relInput: string): { filePath: string; relPath: string } | null {
  const relPath = normalizeNodeRelativePath(relInput);
  if (!relPath) return null;
  const root = nodePath.resolve(baseDir);
  const filePath = nodePath.resolve(root, relPath);
  if (filePath !== root && !filePath.startsWith(root + nodePath.sep)) return null;
  return { filePath, relPath };
}

function addReadCandidate(
  candidates: Array<{ filePath: string; label: string }>,
  seen: Set<string>,
  filePath: string,
  label: string,
): void {
  const resolved = nodePath.resolve(filePath);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  candidates.push({ filePath: resolved, label });
}

export const readFileTool: TutorTool<{ filename: string; folder?: FolderKey }, ReadFileResult> = buildTool({
  name: 'read_file',
  description: toolDescription('read_file'),
  inputSchema: z.object({
    filename: z.string().min(1),
    folder:   z.enum(FOLDER_KEYS).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['filename'],
    properties: {
      filename: { type: 'string', description: toolPropertyDescription('read_file', 'filename') },
      folder: {
        type: 'string',
        enum: [...FOLDER_KEYS],
        description: toolPropertyDescription('read_file', 'folder'),
      },
    },
  },
  maxResultChars: 8000,
  isReadOnly: true,
  execute: (input, ctx): Promise<ReadFileResult> => {
    const candidates: Array<{ filePath: string; label: string }> = [];
    const seen = new Set<string>();
    const nodeDir = getNodeDir(ctx.courseId, ctx.nodeId);
    const nodeRelative = resolveInside(nodeDir, input.filename);
    if (nodeRelative) {
      addReadCandidate(candidates, seen, nodeRelative.filePath, `[${nodeRelative.relPath}]`);
    }

    const foldersToSearch = input.folder ? [input.folder] : [...READ_FILE_FOLDERS];
    for (const folderName of foldersToSearch) {
      const folderDir = getFolderPath(ctx.courseId, ctx.nodeId, folderName);
      const folderRelative = resolveInside(folderDir, input.filename);
      if (!folderRelative) continue;
      const folderLabel = `${getFolderName(folderName, ctx.language)}/${folderRelative.relPath}`;
      addReadCandidate(candidates, seen, folderRelative.filePath, `[${folderLabel}]`);
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate.filePath)) {
        try {
          const stat = fs.statSync(candidate.filePath);
          if (!stat.isFile()) continue;
          const content = fs.readFileSync(candidate.filePath, 'utf-8');
          return Promise.resolve({ success: true, content, message: candidate.label, language: ctx.language });
        } catch (err) {
          return Promise.resolve({ success: false, message: message('readFailed', ctx.language, { error: normalizeAgentError(err, 'TOOL_FAILED').message }), language: ctx.language });
        }
      }
    }
    return Promise.resolve({ success: false, message: message('fileMissing', ctx.language, { filename: input.filename }), language: ctx.language });
  },
  formatResult: (r) => {
    if (!r.success || !r.content) return r.message;
    const text = r.content.slice(0, 8000);
    return `${r.message}\n\n${text}${r.content.length > 8000 ? message('contentTruncated', r.language) : ''}`;
  },
});

// ── search_knowledge ─────────────────────────────────────────────────────────

interface SearchKnowledgeResult { found: boolean; summary: string; language?: string }

export const searchKnowledgeTool: TutorTool<{ query: string }, SearchKnowledgeResult> = buildTool({
  name: 'search_knowledge',
  description: toolDescription('search_knowledge'),
  inputSchema: z.object({ query: z.string().min(1) }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: toolPropertyDescription('search_knowledge', 'query') },
    },
  },
  maxResultChars: 3000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<SearchKnowledgeResult> => {
    const blocked = blockLibraryMessage(ctx.searchMode, ctx.language);
    if (blocked) return { found: false, summary: blocked, language: ctx.language };
    const summary = await searchLibraryForAgent({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      agentType: 'sub_tutor',
      query: input.query,
      limit: 5,
      provider: ctx.provider,
      model: ctx.model,
      signal: ctx.signal,
      llmRerank: true,
      onUsage: (usage) => ctx.runContext?.addUsage(usage),
    });
    const found = !summary.startsWith('未找到相关资料');
    return { found, summary, language: ctx.language };
  },
  formatResult: (r) => truncateResult(r.summary, 3000, r.language),
});

interface SearchLibraryResult { summary: string }

export const searchLibraryTool: TutorTool<{ query: string; limit?: number }, SearchLibraryResult> = buildTool({
  name: 'search_library',
  description:
    '检索当前可见参考库。返回资料来源、AI 概览（资料语义预处理）和相关片段；先依据 AI 概览判断资料是否相关，需要具体页/段落时再调用 read_source。主导师可见主导师参考库；次导师可见本节点资料和已导入到本节点的主导师资料。',
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '参考库检索关键词或问题' },
      limit: { type: 'number', description: '返回参考资料条数，1-8，默认 5' },
    },
  },
  maxResultChars: 4000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<SearchLibraryResult> => ({
    summary: blockLibraryMessage(ctx.searchMode, ctx.language) ?? await searchLibraryForAgent({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      agentType: 'sub_tutor',
      query: input.query,
      limit: input.limit,
      provider: ctx.provider,
      model: ctx.model,
      signal: ctx.signal,
      llmRerank: true,
      onUsage: (usage) => ctx.runContext?.addUsage(usage),
    }),
  }),
  formatResult: (r) => truncateResult(r.summary, 4000),
});

interface ReadSourceInput {
  source_id: string;
  max_chunks?: number;
  page?: number;
  page_start?: number;
  page_end?: number;
  unit_index?: number;
  max_blocks?: number;
}

interface ReadSourceResult { summary: string }

export const readSourceTool: TutorTool<ReadSourceInput, ReadSourceResult> = buildTool({
  name: 'read_source',
  description:
    '读取某条资料的更完整内容片段。通常先用 search_library 查看 AI 概览并找到 source_id；确认需要正文细节后，再对 PDF/文档指定 page、page_start/page_end 或 unit_index 精读具体范围。',
  inputSchema: z.object({
    source_id: z.string().min(1),
    max_chunks: z.number().int().min(1).max(8).optional(),
    page: z.number().int().min(1).optional(),
    page_start: z.number().int().min(1).optional(),
    page_end: z.number().int().min(1).optional(),
    unit_index: z.number().int().min(0).optional(),
    max_blocks: z.number().int().min(1).max(120).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['source_id'],
    properties: {
      source_id: { type: 'string', description: 'search_library 返回的 source_id' },
      max_chunks: { type: 'number', description: '展开的片段数量，1-8，默认 5' },
      page: { type: 'number', description: '读取单页页码，适用于 PDF 等分页文档' },
      page_start: { type: 'number', description: '读取页码范围起点，适用于 PDF 等分页文档' },
      page_end: { type: 'number', description: '读取页码范围终点，适用于 PDF 等分页文档' },
      unit_index: { type: 'number', description: '读取结构化文档单元索引，0 开始；适用于非分页文档' },
      max_blocks: { type: 'number', description: '最多返回内容块数量，1-120，默认 36' },
    },
  },
  maxResultChars: 8000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<ReadSourceResult> => ({
    summary: blockLibraryMessage(ctx.searchMode, ctx.language) ?? await readSourceForAgent({
        courseId: ctx.courseId,
        nodeId: ctx.nodeId,
        agentType: 'sub_tutor',
        sourceId: input.source_id,
        maxChunks: input.max_chunks,
        page: input.page,
        pageStart: input.page_start,
        pageEnd: input.page_end,
        unitIndex: input.unit_index,
        maxBlocks: input.max_blocks,
      }),
  }),
  formatResult: (r) => truncateResult(r.summary, 8000),
});

// ── get_node_progress ─────────────────────────────────────────────────────────

interface NodeProgressItem {
  nodeId: string;
  name: string;
  chapter: string;
  difficulty: string;
  status: string;
  hasMistakes: boolean;
  materialCounts: Record<string, number>;
}

interface ProgressResult { nodes: NodeProgressItem[]; language?: string }

export const getNodeProgressTool: TutorTool<Record<string, never>, ProgressResult> = buildTool({
  name: 'get_node_progress',
  description: toolDescription('get_node_progress'),
  inputSchema: z.object({}),
  inputJsonSchema: { type: 'object', properties: {} },
  maxResultChars: 4000,
  isReadOnly: true,
  execute: (_, ctx): Promise<ProgressResult> => {
    const allNodes = nodeRepo.findByCourse(ctx.courseId);
    const nodes: NodeProgressItem[] = allNodes.map((n) => {
      const materialCounts: Record<string, number> = {};
      for (const folderName of NODE_FOLDERS) {
        const dir = getFolderPath(ctx.courseId, n.id, folderName);
        try {
          if (fs.existsSync(dir)) {
            const count = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.txt')).length;
            if (count > 0) materialCounts[folderName] = count;
          }
        } catch { /* skip */ }
      }
      const mistakesPath = nodePath.join(getFolderPath(ctx.courseId, n.id, 'practice'), 'mistakes.md');
      return {
        nodeId:         n.id,
        name:           n.name,
        chapter:        n.chapter,
        difficulty:     n.difficulty,
        status:         n.status,
        hasMistakes:    fs.existsSync(mistakesPath),
        materialCounts,
      };
    });
    return Promise.resolve({ nodes, language: ctx.language });
  },
  formatResult: (r) => {
    const lines: string[] = [];
    const isEn = normalizeLanguage(r.language) === 'en';
    const statusLabels = isEn
      ? { locked: '🔒 Locked', available: '⬜ Not started', active: '🟡 In progress', done: '✅ Done' }
      : { locked: '🔒 未解锁', available: '⬜ 未开始', active: '🟡 学习中', done: '✅ 已完成' };
    const chapters = [...new Set(r.nodes.map((n) => n.chapter))];
    for (const ch of chapters) {
      lines.push(`\n## ${ch}`);
      for (const n of r.nodes.filter((x) => x.chapter === ch)) {
        const status = statusLabels[n.status as keyof typeof statusLabels] ?? n.status;
        const mats = Object.entries(n.materialCounts).map(([f, c]) => `${f}×${c}`).join(', ');
        const mistakes = n.hasMistakes ? (isEn ? ' ⚠️ mistakes' : ' ⚠️错题') : '';
        const difficulty = isEn ? `(${n.difficulty})` : `（${n.difficulty}）`;
        lines.push(`- **${n.name}**${difficulty}${status}${mats ? ' | ' + mats : ''}${mistakes}`);
      }
    }
    return truncateResult(lines.join('\n'), 4000, r.language);
  },
});
