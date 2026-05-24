import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tutor-tools';
import { createFileTool } from '../tutor-tools/create-file.tool';
import {
  copyNodeItemTool,
  deleteNodeItemTool,
  editMarkdownFileTool,
  listMarkdownHeadingsTool,
  listNodeFilesTool,
  moveNodeItemTool,
  patchMarkdownFileTool,
  readMarkdownSectionTool,
  renameNodeItemTool,
  searchNodeFilesTool,
  updateFileTool,
} from './node-file.tools';
import { importTextSource, replaceSourceContent } from '../../source/source-library';

const mockState = vi.hoisted(() => ({ nodeDir: '' }));

vi.mock('../../fs/content.service', () => ({
  getNodeDir: () => mockState.nodeDir,
  writeFileContent: (filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  },
  createFolder: (folderPath: string) => fs.mkdirSync(folderPath, { recursive: true }),
}));

vi.mock('../../db/sqlite', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('SELECT id FROM source_records') ? undefined : null),
      run: vi.fn(),
      all: vi.fn(() => []),
    }),
  }),
}));

vi.mock('../../source/source-library', () => ({
  importTextSource: vi.fn(),
  replaceSourceContent: vi.fn(),
}));

function ctx(): ToolContext {
  return {
    sessionId: 'session-1',
    courseId: 'course-1',
    nodeId: 'node-1',
    provider: 'openai',
    model: 'test-model',
    onProgress: vi.fn(),
    onFileGenerated: vi.fn(),
  };
}

describe('node file tools', () => {
  beforeEach(() => {
    mockState.nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulyzer-node-files-'));
    vi.mocked(importTextSource).mockClear();
    vi.mocked(replaceSourceContent).mockClear();
  });

  afterEach(() => {
    if (mockState.nodeDir) fs.rmSync(mockState.nodeDir, { recursive: true, force: true });
    mockState.nodeDir = '';
  });

  it('lists node files and updates markdown content', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '个人笔记'), { recursive: true });
    fs.writeFileSync(path.join(mockState.nodeDir, '个人笔记', 'note.md'), 'hello world', 'utf-8');

    const list = await listNodeFilesTool.execute({}, ctx());
    expect(list.success).toBe(true);
    expect(list.entries?.map((entry) => entry.path)).toContain('个人笔记/note.md');

    const update = await updateFileTool.execute({
      path: '个人笔记/note.md',
      operation: 'replace_text',
      search: 'hello',
      replacement: 'hi',
    }, ctx());
    expect(update.success).toBe(true);
    expect(fs.readFileSync(path.join(mockState.nodeDir, '个人笔记', 'note.md'), 'utf-8')).toBe('hi world');
    expect(importTextSource).toHaveBeenCalledWith(expect.objectContaining({
      id: 'node-file-source:course-1:node-1:个人笔记/note.md',
      courseId: 'course-1',
      nodeId: 'node-1',
      title: 'note.md',
      content: 'hi world',
      kind: 'generated',
      origin: 'ai_generated',
    }));
  });

  it('refuses to overwrite create_file targets unless overwrite is explicit', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '草稿'), { recursive: true });
    fs.writeFileSync(path.join(mockState.nodeDir, '草稿', 'a.md'), 'old', 'utf-8');

    const refused = await createFileTool.execute({ path: '草稿/a.md', content: 'new' }, ctx());
    expect(refused.success).toBe(false);
    expect(fs.readFileSync(path.join(mockState.nodeDir, '草稿', 'a.md'), 'utf-8')).toBe('old');

    const overwritten = await createFileTool.execute({ path: '草稿/a.md', content: 'new', overwrite: true }, ctx());
    expect(overwritten.success).toBe(true);
    expect(fs.readFileSync(path.join(mockState.nodeDir, '草稿', 'a.md'), 'utf-8')).toBe('new');
    expect(importTextSource).toHaveBeenCalledWith(expect.objectContaining({
      id: 'node-file-source:course-1:node-1:草稿/a.md',
      courseId: 'course-1',
      nodeId: 'node-1',
      title: 'a.md',
      content: 'new',
      kind: 'generated',
      origin: 'ai_generated',
    }));
  });

  it('searches node files by filename, heading, and content', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '原理资料'), { recursive: true });
    fs.writeFileSync(path.join(mockState.nodeDir, '原理资料', 'matrix-note.md'), [
      '# 矩阵基础',
      '',
      '## 维度规则',
      '',
      '矩阵乘法必须满足左矩阵列数等于右矩阵行数。',
    ].join('\n'), 'utf-8');

    const result = await searchNodeFilesTool.execute({ query: '维度', path: '原理资料' }, ctx());

    expect(result.success).toBe(true);
    expect(result.matches?.map((match) => match.type)).toEqual(expect.arrayContaining(['heading', 'content']));
    expect(result.matches?.some((match) => match.path === '原理资料/matrix-note.md')).toBe(true);
  });

  it('edits markdown by heading without relying on whole-file replacement', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '实践资料'), { recursive: true });
    const filePath = path.join(mockState.nodeDir, '实践资料', 'task.md');
    fs.writeFileSync(filePath, [
      '# 实操任务',
      '',
      '## 第二步：观察冗余',
      '',
      '已有任务。',
      '',
      '## 第三步：对比反思',
      '',
      '回答问题。',
      '',
    ].join('\n'), 'utf-8');

    const result = await editMarkdownFileTool.execute({
      path: '实践资料/task.md',
      operation: 'append_to_section',
      heading: '第二步',
      content: '新增小任务：创建几个 txt 文件，观察重复信息。',
    }, ctx());

    expect(result.success).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('已有任务。\n\n新增小任务：创建几个 txt 文件，观察重复信息。\n\n## 第三步');
  });

  it('lists headings and reads a precise markdown section', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '原理资料'), { recursive: true });
    const filePath = path.join(mockState.nodeDir, '原理资料', 'a.md');
    fs.writeFileSync(filePath, [
      '# A',
      '',
      '## 第一节',
      'one',
      '',
      '### 细节',
      'detail',
      '',
      '## 第二节',
      'two',
    ].join('\n'), 'utf-8');

    const headings = await listMarkdownHeadingsTool.execute({ path: '原理资料/a.md' }, ctx());
    expect(headings.success).toBe(true);
    expect(headings.headings?.map((heading) => heading.path)).toContain('A > 第一节 > 细节');

    const section = await readMarkdownSectionTool.execute({ path: '原理资料/a.md', heading: '第一节' }, ctx());
    expect(section.success).toBe(true);
    expect(section.content).toContain('## 第一节');
    expect(section.content).toContain('### 细节');
    expect(section.content).not.toContain('## 第二节');
  });

  it('applies markdown patch operations atomically', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '原理资料'), { recursive: true });
    const filePath = path.join(mockState.nodeDir, '原理资料', 'patch.md');
    fs.writeFileSync(filePath, [
      '# A',
      '',
      '## 例子',
      '旧例子',
      '',
      '## 练习',
      '旧练习',
    ].join('\n'), 'utf-8');

    const result = await patchMarkdownFileTool.execute({
      path: '原理资料/patch.md',
      operations: [
        { operation: 'append_to_section', heading: '例子', content: '新例子' },
        { operation: 'replace_text', search: '旧练习', replacement: '新练习' },
      ],
    }, ctx());

    expect(result.success).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('旧例子\n\n新例子\n\n## 练习');
    expect(content).toContain('新练习');

    const failed = await patchMarkdownFileTool.execute({
      path: '原理资料/patch.md',
      operations: [
        { operation: 'append_to_section', heading: '不存在', content: '不应写入' },
      ],
    }, ctx());
    expect(failed.success).toBe(false);
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('不应写入');
  });

  it('refuses ambiguous markdown heading edits', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '原理资料'), { recursive: true });
    fs.writeFileSync(path.join(mockState.nodeDir, '原理资料', 'a.md'), [
      '# A',
      '## 示例',
      'one',
      '## 示例',
      'two',
    ].join('\n'), 'utf-8');

    const result = await editMarkdownFileTool.execute({
      path: '原理资料/a.md',
      operation: 'append_to_section',
      heading: '示例',
      content: '补充',
    }, ctx());

    expect(result.success).toBe(false);
    expect(result.message).toContain('ambiguous');
  });

  it('deletes, renames, and moves only inside the node workspace', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '草稿'), { recursive: true });
    fs.writeFileSync(path.join(mockState.nodeDir, '草稿', 'a.md'), 'a', 'utf-8');
    fs.writeFileSync(path.join(mockState.nodeDir, '草稿', 'b.md'), 'b', 'utf-8');

    const rename = await renameNodeItemTool.execute({ path: '草稿/a.md', new_name: 'renamed.md' }, ctx());
    expect(rename.success).toBe(true);
    expect(fs.existsSync(path.join(mockState.nodeDir, '草稿', 'renamed.md'))).toBe(true);

    const move = await moveNodeItemTool.execute({ path: '草稿/renamed.md', destination_path: '归档/renamed.md' }, ctx());
    expect(move.success).toBe(true);
    expect(fs.existsSync(path.join(mockState.nodeDir, '归档', 'renamed.md'))).toBe(true);

    const copy = await copyNodeItemTool.execute({ path: '归档/renamed.md', destination_path: '归档/copied.md' }, ctx());
    expect(copy.success).toBe(true);
    expect(fs.readFileSync(path.join(mockState.nodeDir, '归档', 'copied.md'), 'utf-8')).toBe('a');

    const deleted = await deleteNodeItemTool.execute({ path: '草稿/b.md' }, ctx());
    expect(deleted.success).toBe(true);
    expect(fs.existsSync(path.join(mockState.nodeDir, '草稿', 'b.md'))).toBe(false);
  });

  it('rejects path escape and standard material root deletion', async () => {
    fs.mkdirSync(path.join(mockState.nodeDir, '原理资料'), { recursive: true });

    const escaped = await updateFileTool.execute({
      path: '../outside.md',
      operation: 'replace_all',
      content: 'x',
    }, ctx());
    expect(escaped.success).toBe(false);

    const protectedRoot = await deleteNodeItemTool.execute({ path: '原理资料' }, ctx());
    expect(protectedRoot.success).toBe(false);
    expect(fs.existsSync(path.join(mockState.nodeDir, '原理资料'))).toBe(true);
  });
});
