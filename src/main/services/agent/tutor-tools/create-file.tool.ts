/**
 * create_file — gives the AI free-form write access within the node folder.
 * Unlike save_file (which targets the 4 fixed subfolders), this tool lets the AI
 * create files or subfolders anywhere inside the current node directory.
 * Paths are sandbox-checked to prevent escaping the node root.
 */
import { z } from 'zod';
import * as nodePath from 'path';
import { buildTool } from './index';
import { getNodeDir, writeFileContent, createFolder } from '../../fs/content.service';
import { createLogger } from '../../../utils/logger';

const log = createLogger('create_file');

export const createFileTool = buildTool<
  { path: string; content?: string; isFolder?: boolean },
  { success: boolean; fullPath: string; message: string }
>({
  name: 'create_file',
  description:
    '在当前节点文件夹内自由创建文件或子文件夹。' +
    '【做什么】在节点目录下的任意子路径创建 Markdown 文件或文件夹，支持多级路径（如「自定义/子目录/文件名.md」）。' +
    '【何时调用】用户说"帮我在X文件夹创建Y文件"/"新建一个叫Z的文件夹"/"把这个内容存到自定义路径"/"创建一个新文件"，或需要保存到四个标准文件夹之外的位置时。' +
    '【安全限制】path 只能是节点文件夹内的相对路径，不能包含 .. 或绝对路径，不能访问节点目录之外的文件。',
  inputSchema: z.object({
    path:     z.string().min(1).describe('相对于节点文件夹的路径，如 "自定义笔记/第一章.md" 或 "草稿"'),
    content:  z.string().optional().describe('文件内容（Markdown）；创建文件夹时不填'),
    isFolder: z.boolean().optional().describe('true = 创建文件夹；false 或不填 = 创建文件'),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path:     { type: 'string', description: '相对于节点文件夹的路径，例如 "草稿/笔记.md" 或 "草稿"（不能含 .. ）' },
      content:  { type: 'string', description: '文件内容（Markdown 格式）；创建文件夹时留空' },
      isFolder: { type: 'boolean', description: 'true = 创建文件夹，false / 不填 = 创建文件' },
    },
  },
  maxResultChars: 200,
  isReadOnly: false,
  execute: async ({ path: relPath, content, isFolder }, ctx) => {
    // Security: reject any path trying to escape the node directory
    const normalized = nodePath.normalize(relPath).replace(/\\/g, '/');
    if (normalized.startsWith('..') || nodePath.isAbsolute(normalized)) {
      return { success: false, fullPath: '', message: '路径不合法：不能使用 .. 或绝对路径' };
    }

    const nodeDir = getNodeDir(ctx.courseId, ctx.nodeId);
    const fullPath = nodePath.join(nodeDir, normalized);

    // Double-check the resolved path is still inside the node directory
    if (!fullPath.startsWith(nodeDir + nodePath.sep) && fullPath !== nodeDir) {
      return { success: false, fullPath: '', message: '路径不合法：超出节点文件夹范围' };
    }

    try {
      if (isFolder) {
        createFolder(fullPath);
        return { success: true, fullPath, message: `文件夹已创建：${normalized}` };
      } else {
        writeFileContent(fullPath, content ?? '');
        ctx.onFileGenerated({
          sessionId: ctx.sessionId,
          filePath:  fullPath,
          folderName: nodePath.dirname(normalized),
          nodeId: ctx.nodeId,
          usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
        });
        return { success: true, fullPath, message: `文件已创建：${normalized}` };
      }
    } catch (err) {
      log.warn('create_file 失败', { relPath, error: String(err) });
      return { success: false, fullPath: '', message: `创建失败：${String(err)}` };
    }
  },
  formatResult: (r) => r.message,
});
