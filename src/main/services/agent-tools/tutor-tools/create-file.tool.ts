/**
 * create_file — gives the AI free-form write access within the node folder.
 * Unlike save_file (which targets the 4 fixed subfolders), this tool lets the AI
 * create files or subfolders anywhere inside the current node directory.
 * Paths are sandbox-checked to prevent escaping the node root.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as nodePath from 'path';
import { buildTool } from './index';
import { getNodeDir, writeFileContent, createFolder } from '../../fs/content.service';
import { resolveFolderKey } from '../../agent-i18n/folder-policy';
import { normalizeAgentError } from '../../agent-core/agent-errors';
import { createLogger } from '../../../utils/logger';
import { reindexNodeFile } from '../node-file-index';

const log = createLogger('create_file');

export const createFileTool = buildTool<
  { path: string; content?: string; isFolder?: boolean; overwrite?: boolean },
  { success: boolean; fullPath: string; message: string }
>({
  name: 'create_file',
  description:
    '在当前节点文件夹内自由创建文件或子文件夹。' +
    '【做什么】在节点目录下的任意子路径创建文本类文件或文件夹，支持多级路径（如「原理资料/案例分析.md」「实践资料/题库.md」「原理资料/数据表.csv」「原理资料/交互演示.html」「原理资料/关系图.svg」）。' +
    '【资料形态路由】案例分析、反例集、概念卡、证明骨架、公式推导、检查清单、题库、结构化案例库优先用 .md；二维表/变量表/评分表优先用 .csv；交互演示/本地可视化优先用 .html；独立矢量图优先用 .svg；代码实验按语言使用 .py/.js/.ts 等。只有用户明确要求 JSON 或程序可读数据时才使用 .json。' +
    '【何时调用】用户说"帮我在X文件夹创建Y文件"/"新建一个叫Z的文件夹"/"把这个内容存到自定义路径"/"创建一个新文件"，或需要生成标准 generate_theory/generate_practice 之外的自定义资料形态时。' +
    '【安全限制】path 只能是节点文件夹内的相对路径，不能包含 .. 或绝对路径，不能访问节点目录之外的文件。默认不覆盖已有文件；只有用户明确要求覆盖/替换时才传 overwrite=true。',
  inputSchema: z.object({
    path:     z.string().min(1).describe('相对于节点文件夹的路径，如 "原理资料/案例分析.md"、"实践资料/题库.md"、"原理资料/变量表.csv"、"原理资料/交互演示.html" 或 "草稿"'),
    content:  z.string().optional().describe('文件内容，支持 Markdown/CSV/HTML/SVG/代码等 UTF-8 文本；用户明确要求时也可写 JSON；创建文件夹时不填'),
    isFolder: z.boolean().optional().describe('true = 创建文件夹；false 或不填 = 创建文件'),
    overwrite: z.boolean().optional().describe('目标文件已存在时是否覆盖；默认 false，只有用户明确要求覆盖时才设为 true'),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path:     { type: 'string', description: '相对于节点文件夹的路径，例如 "原理资料/案例分析.md"、"实践资料/题库.md"、"原理资料/变量表.csv"、"原理资料/交互演示.html" 或 "草稿"（不能含 .. ）' },
      content:  { type: 'string', description: '文件内容，支持 Markdown/CSV/HTML/SVG/代码等 UTF-8 文本；用户明确要求时也可写 JSON；创建文件夹时留空' },
      isFolder: { type: 'boolean', description: 'true = 创建文件夹，false / 不填 = 创建文件' },
      overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖；默认 false，只有用户明确要求覆盖/替换时才使用 true' },
    },
  },
  maxResultChars: 200,
  isReadOnly: false,
  execute: async ({ path: relPath, content, isFolder, overwrite }, ctx) => {
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
        if (fs.existsSync(fullPath) && !overwrite) {
          return { success: false, fullPath: '', message: `创建失败：目标已存在：${normalized}` };
        }
        createFolder(fullPath);
        return { success: true, fullPath, message: `文件夹已创建：${normalized}` };
      } else {
        if (fs.existsSync(fullPath) && !overwrite) {
          return { success: false, fullPath: '', message: `创建失败：文件已存在：${normalized}。请使用 update_file/edit_markdown_file 修改，或在明确需要覆盖时设置 overwrite=true。` };
        }
        writeFileContent(fullPath, content ?? '');
        reindexNodeFile(ctx, normalized, fullPath);
        ctx.onFileGenerated({
          sessionId: ctx.sessionId,
          filePath:  fullPath,
          folderName: resolveFolderKey(normalized.split('/')[0] ?? '') ?? 'notes',
          nodeId: ctx.nodeId,
          usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
        });
        return { success: true, fullPath, message: `文件已创建：${normalized}` };
      }
    } catch (err) {
      const normalized = normalizeAgentError(err, 'SAVE_FAILED');
      log.warn('create_file 失败', { relPath, error: normalized.message, code: normalized.code });
      return { success: false, fullPath: '', message: `创建失败：${normalized.message}` };
    }
  },
  formatResult: (r) => r.message,
});
