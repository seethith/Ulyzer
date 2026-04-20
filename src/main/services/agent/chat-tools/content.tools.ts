/**
 * Content management tools — read existing materials, record mistakes, append notes.
 * These give the AI visibility into what the user has already learned/saved,
 * enabling context-aware responses and incremental knowledge building.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool, truncateResult } from '../tutor-tools/index';
import { getFolderPath, writeFileContent } from '../../fs/content.service';
import { NodeRepository } from '../../db/repositories/node.repo';
import { retrieveChunks } from '../../rag/retriever';

const nodeRepo = new NodeRepository();

const NODE_FOLDERS = ['theory', 'practice', 'answer', 'notes', 'feynman'] as const;
const PREVIEW_CHARS = 400;

const FOLDER_DISPLAY: Record<string, string> = {
  theory: '原理资料 / Theory', practice: '实践资料 / Practice',
  answer: '参考答案 / Answer', notes: '个人笔记 / Notes', feynman: '费曼复盘 / Feynman Review',
};

// ── read_materials ────────────────────────────────────────────────────────────

interface ReadResult {
  folders: Array<{ name: string; files: Array<{ name: string; preview: string }> }>;
}

export const readMaterialsTool: TutorTool<{ folder?: string }, ReadResult> = buildTool({
  name: 'read_materials',
  description:
    '【做什么】读取当前节点已有的学习资料（theory/practice/notes/feynman），返回文件名和内容预览。' +
    '【何时调用】用户说"看看我之前的笔记"/"有什么资料"/"look at my notes"/"what materials do I have"，或 AI 要回答涉及已有资料的问题前应先调用以避免重复生成。' +
    '【限制】只能读取当前节点的文件，每个文件只显示前400字预览。' +
    '⚠️ 每个文件仅返回前400字预览，不包含完整题目内容——若用户要求解题、讲解练习题、分析题目内容，必须改用 read_file 工具读取完整文件后再作答，禁止基于预览内容作答。',
  inputSchema: z.object({
    folder: z.enum(['theory', 'practice', 'answer', 'notes', 'feynman']).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        enum: ['theory', 'practice', 'answer', 'notes', 'feynman'],
        description: 'Folder to read (theory/practice/answer/notes/feynman); omit to read all',
      },
    },
  },
  maxResultChars: 6000,
  isReadOnly: true,
  execute: (input, ctx): Promise<ReadResult> => {
    const folders = input.folder ? [input.folder] : [...NODE_FOLDERS];
    const result: ReadResult = { folders: [] };

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
      const displayName = FOLDER_DISPLAY[f.name] ?? f.name;
      if (f.files.length === 0) {
        lines.push(`[${displayName}] 暂无文件 / no files`);
      } else {
        lines.push(`[${displayName}]`);
        for (const file of f.files) {
          lines.push(`• ${file.name}\n${file.preview}${file.preview.length >= PREVIEW_CHARS ? '…' : ''}`);
        }
      }
    }
    return truncateResult(lines.join('\n\n'), 6000);
  },
});

// ── record_mistake ────────────────────────────────────────────────────────────

interface MistakeResult { success: boolean; message: string }

export const recordMistakeTool: TutorTool<
  { question: string; my_answer: string; correct_answer: string; analysis?: string },
  MistakeResult
> = buildTool({
  name: 'record_mistake',
  description:
    '【做什么】将一道做错的题（题目、错误答案、正确答案、错误分析）追加记录到「实践资料/mistakes.md」错题本。' +
    '【何时调用】用户答错了题目、用户说"我答错了"/"记下这道题"/"加入错题本"/"这题我不会"，或 AI 检测到用户对某知识点存在明显理解偏差时主动记录。' +
    '【限制】只记录题目类错误，不记录概念笔记；内容追加到固定文件，无法删除单条记录。',
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
      question:       { type: 'string', description: '题目内容' },
      my_answer:      { type: 'string', description: '用户的错误答案' },
      correct_answer: { type: 'string', description: '正确答案' },
      analysis:       { type: 'string', description: '错误原因分析（AI 可填写）' },
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
      ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'practice', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
      return Promise.resolve({ success: true, message: '错题已记录到「实践资料/mistakes.md」' });
    } catch (err) {
      return Promise.resolve({ success: false, message: String(err) });
    }
  },
  formatResult: (r) => r.message,
});

// ── append_to_notes ───────────────────────────────────────────────────────────

interface NotesResult { success: boolean; fileName?: string; message: string }

export const appendToNotesTool: TutorTool<{ content: string; title?: string }, NotesResult> = buildTool({
  name: 'append_to_notes',
  description:
    '【做什么】将对话中产生的内容（AI 的解释、总结、关键点）以独立 Markdown 文件保存到「个人笔记」文件夹。' +
    '【何时调用】用户说"帮我记下来"/"保存一下"/"存到笔记"/"记录这个"/"把这段话存起来"，或对话中出现了值得永久保留的知识片段（AI 判断有保留价值时也可主动保存）。' +
    '【限制】每次调用创建新文件（不追加到已有笔记）；适合保存单条知识片段，系统性整理请用户自行在「个人笔记」文件夹中编辑。',
  inputSchema: z.object({
    content: z.string().min(1),
    title:   z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['content'],
    properties: {
      content: { type: 'string', description: '要保存的笔记内容（Markdown 格式）' },
      title:   { type: 'string', description: '笔记标题，用于生成文件名（可不填）' },
    },
  },
  maxResultChars: 200,
  isReadOnly: false,
  execute: (input, ctx): Promise<NotesResult> => {
    const notesDir = getFolderPath(ctx.courseId, ctx.nodeId, 'notes');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const slug = (input.title ?? '笔记')
      .slice(0, 20)
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, '-')
      .trim() || '笔记';
    const fileName = `${ts}-${slug}.md`;
    const filePath = nodePath.join(notesDir, fileName);

    try {
      writeFileContent(filePath, input.content);
      ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'notes', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
      return Promise.resolve({ success: true, fileName, message: `笔记已保存：${fileName}` });
    } catch (err) {
      return Promise.resolve({ success: false, message: String(err) });
    }
  },
  formatResult: (r) => r.message,
});

// ── read_file ─────────────────────────────────────────────────────────────────

interface ReadFileResult { success: boolean; content?: string; message: string }

export const readFileTool: TutorTool<{ filename: string; folder?: string }, ReadFileResult> = buildTool({
  name: 'read_file',
  description:
    '【做什么】读取当前节点某个具体文件的完整内容（不限于预览，返回全文）。' +
    '【何时调用】用户要求解题、讲解练习题、分析题目内容时，必须先调用本工具读取完整文件后再作答；' +
    '用户说"看看那个文件"/"打开X文件"/"我之前的X笔记写了什么"/"读一下mistakes.md"，或 AI 需要获取某个文件的完整内容（而非仅预览）进行分析时，如读取错题本进行统计分析。' +
    '【限制】只能读取当前节点文件夹内的文件；内容超过8000字时会截断；不能读取其他节点或课程的文件。',
  inputSchema: z.object({
    filename: z.string().min(1),
    folder:   z.enum(['theory', 'practice', 'answer', 'notes', 'feynman']).optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['filename'],
    properties: {
      filename: { type: 'string', description: 'File name, e.g. mistakes.md or 原理-v1-0420-basics.md' },
      folder: {
        type: 'string',
        enum: ['theory', 'practice', 'answer', 'notes', 'feynman'],
        description: 'Folder to search in (theory/practice/answer/notes/feynman); omit to search all',
      },
    },
  },
  maxResultChars: 8000,
  isReadOnly: true,
  execute: (input, ctx): Promise<ReadFileResult> => {
    const foldersToSearch = input.folder ? [input.folder] : [...NODE_FOLDERS];

    for (const folderName of foldersToSearch) {
      const filePath = nodePath.join(getFolderPath(ctx.courseId, ctx.nodeId, folderName), input.filename);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return Promise.resolve({ success: true, content, message: `[${folderName}/${input.filename}]` });
        } catch (err) {
          return Promise.resolve({ success: false, message: `读取失败：${String(err)}` });
        }
      }
    }
    return Promise.resolve({ success: false, message: `文件不存在：${input.filename}` });
  },
  formatResult: (r) => {
    if (!r.success || !r.content) return r.message;
    const text = r.content.slice(0, 8000);
    return `${r.message}\n\n${text}${r.content.length > 8000 ? '\n…（内容已截断）' : ''}`;
  },
});

// ── search_knowledge ─────────────────────────────────────────────────────────

interface SearchKnowledgeResult { found: boolean; summary: string }

export const searchKnowledgeTool: TutorTool<{ query: string }, SearchKnowledgeResult> = buildTool({
  name: 'search_knowledge',
  description:
    '【做什么】语义检索当前节点已索引的所有资料，返回与查询最相关的内容片段（不返回全文）。' +
    '【何时调用】用户问某概念原理/不理解某内容/遇到报错时，先调用本工具查询已有资料，再决定是否生成新内容或直接回答；比 read_materials 更精准、消耗 token 更少。' +
    '【限制】只返回相关片段而非全文；依赖已生成并索引的资料，节点无资料时返回空；不能跨节点检索。',
  inputSchema: z.object({ query: z.string().min(1) }),
  inputJsonSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '检索关键词或问题描述' },
    },
  },
  maxResultChars: 3000,
  isReadOnly: true,
  execute: (input, ctx): Promise<SearchKnowledgeResult> => {
    if (!ctx.nodeId) return Promise.resolve({ found: false, summary: '未关联节点，无法检索' });
    const chunks = retrieveChunks(ctx.nodeId, input.query, 5);
    if (chunks.length === 0) return Promise.resolve({ found: false, summary: '当前节点暂无相关资料，可生成后再检索' });
    const summary = chunks
      .map((c, i) => `[片段 ${i + 1}${c.sourceName ? `·${c.sourceName}` : ''}]\n${c.content}`)
      .join('\n\n---\n\n');
    return Promise.resolve({ found: true, summary });
  },
  formatResult: (r) => truncateResult(r.summary, 3000),
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

interface ProgressResult { nodes: NodeProgressItem[] }

export const getNodeProgressTool: TutorTool<Record<string, never>, ProgressResult> = buildTool({
  name: 'get_node_progress',
  description:
    '【做什么】获取当前课程所有节点的学习进度（状态、已生成资料数量、是否有错题记录），用于分析薄弱环节。' +
    '【何时调用】用户说"我哪里还没掌握好"/"帮我找薄弱点"/"该复习什么"/"分析一下我的学习情况"/"我的进度怎么样"，或 AI 需要跨节点分析学习状态时。' +
    '【限制】只返回结构化进度数据，不包含文件内容；需要结合 read_file 才能查看具体错题；只统计当前课程。',
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
    return Promise.resolve({ nodes });
  },
  formatResult: (r) => {
    const lines: string[] = [];
    const chapters = [...new Set(r.nodes.map((n) => n.chapter))];
    for (const ch of chapters) {
      lines.push(`\n## ${ch}`);
      for (const n of r.nodes.filter((x) => x.chapter === ch)) {
        const status = { locked: '🔒 未解锁', available: '⬜ 未开始', active: '🟡 学习中', done: '✅ 已完成' }[n.status] ?? n.status;
        const mats = Object.entries(n.materialCounts).map(([f, c]) => `${f}×${c}`).join(', ');
        const mistakes = n.hasMistakes ? ' ⚠️错题' : '';
        lines.push(`- **${n.name}**（${n.difficulty}）${status}${mats ? ' | ' + mats : ''}${mistakes}`);
      }
    }
    return truncateResult(lines.join('\n'), 4000);
  },
});
