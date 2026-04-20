import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as nodePath from 'path';
import { buildTool } from './index';
import { getFolderPath, writeFileContent, getLatestOutlinePath } from '../../fs/content.service';
import { localMsg } from '../../prompt/prompt-builder';
import { indexFile } from '../../rag/indexer';
import { createLogger } from '../../../utils/logger';
import { NodeRepository } from '../../db/repositories/node.repo';
import { detectDomain } from '../../web/source-strategy';
import { buildExtendedReading } from '../extended-reading';

const nodeRepo = new NodeRepository();

const log = createLogger('save_file');

// ── Filename normalisation ────────────────────────────────────────────────────

const TYPE_PREFIX_ZH: Record<string, string> = {
  theory:   '原理',
  practice: '练习',
  answer:   '答案',
};
const TYPE_PREFIX_EN: Record<string, string> = {
  theory:   'theory',
  practice: 'practice',
  answer:   'answer',
};

/**
 * Build a normalised filename: {type}-{outlineVersion}-{MMDD}-{descriptor}.md
 * Only applied to theory / practice / answer folders; notes keep AI-supplied name.
 * Descriptor is taken from the AI-supplied filename (extension stripped, ≤6 chars).
 */
function buildNormalizedFilename(
  aiFilename: string,
  folderName: string,
  courseId: string,
  nodeId: string,
  language?: string,
): string {
  const prefixMap = language === 'en' ? TYPE_PREFIX_EN : TYPE_PREFIX_ZH;
  const typePrefix = prefixMap[folderName];
  if (!typePrefix) return aiFilename; // notes and unknown folders: pass through

  // Outline version (v1/v2/v3)
  const outlinePath = getLatestOutlinePath(courseId, nodeId);
  const vMatch = outlinePath ? nodePath.basename(outlinePath).match(/_outline_(v\d+)\.md/) : null;
  const version = vMatch ? vMatch[1] : 'v1';

  // MMDD
  const now = new Date();
  const mmdd =
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  // Descriptor: strip extension + sanitize + limit to 6 characters
  const raw = aiFilename.replace(/\.md$/i, '').replace(/[/\\?%*:|"<>]/g, '').trim();
  const descriptor = raw.slice(0, 6) || typePrefix;

  return `${typePrefix}-${version}-${mmdd}-${descriptor}.md`;
}

/**
 * Normalize inline multiple-choice options to separate list lines.
 * If a line contains 2+ "A) / B) / C)" option markers inline, split each onto its own line.
 * e.g. "Question? A) opt1 B) opt2 C) opt3 D) opt4"
 *   → "Question?\n- A. opt1\n- B. opt2\n- C. opt3\n- D. opt4"
 */
function normalizeInlineOptions(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      // Only process lines that have 2+ option markers (avoids false positives)
      const count = (line.match(/\b[A-D][)）]\s/g) ?? []).length;
      if (count < 2) return line;
      // Insert a newline before each inline option marker (including the first one)
      return line.replace(/\s+([A-D])[)）]\s+/g, '\n- $1. ');
    })
    .join('\n');
}

export const saveFileTool = buildTool<
  { content: string; filename: string; folderName: string },
  { filePath: string; folderName: string }
>({
  name: 'save_file',
  description:
    '将生成的学习资料保存为文件，并自动建立 RAG 索引。content 是完整的 Markdown 内容。' +
    'folderName 必须从以下四个值中选择（严格按对应关系，不得混淆）：' +
    '【theory = 原理资料】概念解析、原理讲解、思维导图；' +
    '【practice = 实践资料】练习题、实操任务；' +
    '【notes = 个人笔记】学习笔记、心得整理、关键点摘要；' +
    '【answer = 参考答案（独立文件夹，与实践资料配对）】参考答案文件；生成实践资料时必须同一响应中同时调用本工具两次，分别保存题目（practice）和参考答案（answer）。' +
    '内容生成完成后必须调用此工具，否则内容不会保留。\n' +
    '【filename 填写规则】theory/practice/answer 只需填写内容描述词（≤6个汉字，无需加类型前缀和日期），系统自动生成完整文件名。' +
    '例如：folderName=theory 时填 "基础概念"，folderName=practice 时填 "全纲要"，folderName=answer 时填 "全纲要"。' +
    'notes 文件夹填写完整文件名（含 .md 扩展名）。',
  inputSchema: z.object({
    content:    z.string().min(1).describe('要保存的完整内容（Markdown 格式）'),
    filename:   z.string().describe('theory/practice/answer：内容描述词（≤6个汉字），如"基础概念"；notes：完整文件名（含.md）'),
    folderName: z.enum(['theory', 'practice', 'notes', 'answer']).describe('目标文件夹 key：theory=原理资料 / practice=实践资料 / notes=个人笔记 / answer=实践资料(参考答案)'),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      content:    { type: 'string', description: '完整 Markdown 内容' },
      filename:   { type: 'string', description: 'theory/practice/answer：内容描述词（≤6个汉字），如"基础概念"、"全纲要"；notes：完整文件名（含.md）' },
      folderName: {
        type: 'string',
        enum: ['theory', 'practice', 'notes', 'answer'],
        description: 'theory=原理资料 | practice=实践资料 | notes=个人笔记 | answer=参考答案',
      },
    },
    required: ['content', 'filename', 'folderName'],
  },
  maxResultChars: 300,
  execute: async ({ content, filename, folderName }, { courseId, nodeId, sessionId, language, onProgress, onFileGenerated }) => {
    const normalizedFilename = buildNormalizedFilename(filename, folderName, courseId, nodeId, language);
    const dir = getFolderPath(courseId, nodeId, folderName);
    const filePath = nodePath.join(dir, normalizedFilename);

    // Append domain-aware "延伸阅读" section to theory and practice files
    const node = nodeRepo.findById(nodeId);
    const extendedReading = node
      ? buildExtendedReading(node.name, folderName, detectDomain(node.name, node.description))
      : '';
    const finalContent = normalizeInlineOptions(content) + extendedReading;

    writeFileContent(filePath, finalContent);
    onProgress(localMsg(language, `📁 已保存：${normalizedFilename}`, `📁 Saved: ${normalizedFilename}`));

    // Index for RAG — non-fatal if it fails, but log so we know RAG may be incomplete
    try {
      indexFile(randomUUID(), nodeId, courseId, finalContent, normalizedFilename);
    } catch (err) {
      log.warn('RAG 索引失败，文件已保存但不可检索', { filename, nodeId, error: String(err) });
    }

    // Notify caller so it can emit FILE_GENERATED IPC event
    onFileGenerated({
      sessionId,
      filePath,
      folderName,
      nodeId,
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0 }, // loop fills in real usage
    });

    return { filePath, folderName };
  },
  formatResult: ({ filePath }) => `文件已保存至：${filePath}`,
});
