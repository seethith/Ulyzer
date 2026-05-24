import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { FOLDER_KEYS, type FolderKey } from '@shared/types';
import { buildTool } from './index';
import { getFolderPath } from '../../fs/content.service';
import { resolveFolderKey } from '../../agent-i18n/folder-policy';

const folderNameSchema = z.preprocess(
  (value) => (typeof value === 'string' ? resolveFolderKey(value) ?? value : value),
  z.enum(FOLDER_KEYS).describe('Folder key: outline/theory/practice/answer/notes/feynman'),
);

/**
 * read_node_materials — directly reads all .md files in a node folder (full IO).
 *
 * Complements rag_retrieve (semantic search on fragments) with a full-text
 * listing, so the model can see the complete picture of what already exists
 * before deciding what to generate next.
 */
export const readNodeMaterialsTool = buildTool<
  { folderName: FolderKey },
  { found: boolean; content: string }
>({
  name: 'read_node_materials',
  description:
    '直接读取当前节点某文件夹内所有 .md 文件的完整内容，按文件名列出。' +
    '【与 rag_retrieve 的区别】rag_retrieve 按语义检索相关片段（精准、省 token）；本工具直接全文 IO，用于了解已有内容的完整覆盖情况，' +
    '例如：生成前判断是否重复、了解已出哪些题型。' +
    '【何时调用】需要了解已有资料完整内容时，或 _index.md 覆盖记录不够详细时。',
  inputSchema: z.object({
    folderName: folderNameSchema,
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['folderName'],
    properties: {
      folderName: {
        type: 'string',
        enum: [...FOLDER_KEYS],
        description: 'Folder key: outline/theory/practice/answer/notes/feynman',
      },
    },
  },
  maxResultChars: 4000,
  isReadOnly: true,
  execute: async ({ folderName }, ctx) => {
    if (folderName === 'outline') {
      return {
        found: false,
        content: '学习蓝图/知识纲要已在本轮资料生成上下文中提供，请直接使用上下文中的 [学习蓝图 / 知识纲要]，不要再次读取 outline 文件夹。',
      };
    }

    const dir = getFolderPath(ctx.courseId, ctx.nodeId, folderName);
    if (!fs.existsSync(dir)) {
      return { found: false, content: `文件夹「${folderName}」不存在或尚无内容。` };
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    } catch {
      return { found: false, content: '读取文件夹失败。' };
    }

    if (entries.length === 0) {
      return { found: false, content: `文件夹「${folderName}」中暂无资料文件。` };
    }

    const parts = entries.map((filename) => {
      try {
        const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
        return `### ${filename}\n\n${content}`;
      } catch {
        return `### ${filename}\n\n（读取失败）`;
      }
    });

    return { found: true, content: parts.join('\n\n---\n\n') };
  },
  formatResult: (r) => r.content,
});
