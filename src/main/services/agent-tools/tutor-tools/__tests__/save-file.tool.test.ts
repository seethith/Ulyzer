import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../index';

// Mock heavy Electron/DB/fs dependencies before importing the tool
vi.mock('../../../fs/content.service', () => ({
  getFolderPath: vi.fn((_courseId: string, _nodeId: string, folder: string) => `/fake/${folder}`),
  writeFileContent: vi.fn(),
  getLatestOutlinePath: vi.fn(() => null),
}));
vi.mock('../../../source/source-library', () => ({
  importTextSource: vi.fn(),
}));
vi.mock('../../../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../db/repositories/node.repo', () => ({
  NodeRepository: class { findById() { return null; } },
}));
vi.mock('../../web/source-strategy', () => ({
  detectDomain: vi.fn(() => 'general'),
}));
vi.mock('../../../agent-workflows/extended-reading', () => ({
  buildExtendedReading: vi.fn(() => ''),
}));

import { saveFileTool } from '../save-file.tool';
import { getFolderPath, writeFileContent } from '../../../fs/content.service';
import { importTextSource } from '../../../source/source-library';

const mockGetFolderPath    = getFolderPath    as ReturnType<typeof vi.fn>;
const mockWriteFileContent = writeFileContent as ReturnType<typeof vi.fn>;
const mockImportTextSource = importTextSource as ReturnType<typeof vi.fn>;

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'sess-1',
    courseId:  'course-1',
    nodeId:    'node-1',
    provider:  'anthropic',
    model:     'claude-sonnet-4-6',
    onProgress:      vi.fn(),
    onFileGenerated: vi.fn(),
    ...overrides,
  } as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('save_file tool', () => {
  const validPracticeContent = [
    '# Practice',
    '## 第一层：记忆/理解',
    'Q1. Define A. [AI原创]',
    '## 第二层：分析/评估',
    'Q2. Compare A and B. [AI原创]',
    '## 第三层：应用',
    'Q3. Apply A in a scenario. [AI原创]',
    '## 第四层：创造',
    'Q4. Design something with A. [AI原创]',
  ].join('\n\n');

  it('writes content to the expected path', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      { content: '# Hello', filename: 'hello.md', folderName: 'theory' },
      ctx,
    );

    expect(mockGetFolderPath).toHaveBeenCalledWith('course-1', 'node-1', 'theory');
    // filename is normalized (prefix + version + date + original); check folder and content
    const [writtenPath, writtenContent] = mockWriteFileContent.mock.calls[0] as [string, string];
    expect(writtenPath).toContain('/fake/theory/');
    expect(writtenPath).toContain('hello');
    expect(writtenContent).toBe('# Hello');
  });

  it('sanitizes Mermaid blocks before saving theory material', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      {
        content: [
          '```mermaid',
          'graph LR',
          '  subgraph 二元线性方程组',
          '    A[方程1: a₁x + b₁y = c₁] --> S((解 (x,y)))',
          '  end',
          '```',
        ].join('\n'),
        filename: 'diagram.md',
        folderName: 'theory',
      },
      ctx,
    );

    const [, writtenContent] = mockWriteFileContent.mock.calls[0] as [string, string];
    expect(writtenContent).toContain('subgraph sg_1["二元线性方程组"]');
    expect(writtenContent).toContain('A["方程1: a₁x + b₁y = c₁"]');
    expect(writtenContent).toContain('S["解 (x,y)"]');
  });

  it('sanitizes LaTeX display delimiters and matrix row breaks before saving', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      {
        content: String.raw`
\[
\begin{bmatrix} 1 & 2 \ 3 & 4 \end{bmatrix}
\]
`,
        filename: 'matrix.md',
        folderName: 'theory',
      },
      ctx,
    );

    const [, writtenContent] = mockWriteFileContent.mock.calls[0] as [string, string];
    expect(writtenContent).toContain('$$');
    expect(writtenContent).not.toContain('\\[');
    expect(writtenContent).toContain(String.raw`1 & 2 \\ 3 & 4`);
  });

  it('rejects invalid LaTeX before saving generated materials', async () => {
    await expect(
      saveFileTool.execute({
        content: String.raw`$$\notacommand{1}$$`,
        filename: 'bad-math.md',
        folderName: 'theory',
      }, makeCtx()),
    ).rejects.toThrow(/LaTeX|公式/);
    expect(mockWriteFileContent).not.toHaveBeenCalled();
  });

  it('rejects theory Mermaid blocks that cannot be repaired into the safe subset', async () => {
    await expect(
      saveFileTool.execute({
        content: [
          '```mermaid',
          'mindmap',
          '  root((概念))',
          '```',
        ].join('\n'),
        filename: 'bad-diagram.md',
        folderName: 'theory',
      }, makeCtx()),
    ).rejects.toThrow(/Mermaid 校验未通过/);
    expect(mockWriteFileContent).not.toHaveBeenCalled();
  });

  it('calls onProgress with the filename', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      { content: validPracticeContent, filename: 'hi.md', folderName: 'practice' },
      ctx,
    );
    const onProgress = ctx.onProgress as ReturnType<typeof vi.fn>;
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0][0]).toContain('hi.md');
  });

  it('fires onFileGenerated with correct folderName and nodeId', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      { content: 'body', filename: 'notes.md', folderName: 'answer' },
      ctx,
    );
    const onFileGenerated = ctx.onFileGenerated as ReturnType<typeof vi.fn>;
    expect(onFileGenerated).toHaveBeenCalledOnce();
    const payload = onFileGenerated.mock.calls[0][0];
    expect(payload.folderName).toBe('answer');
    expect(payload.nodeId).toBe('node-1');
    expect(payload.filePath).toContain('notes.md');
  });

  it('attempts source-library indexing (non-fatal)', async () => {
    mockImportTextSource.mockImplementationOnce(() => { throw new Error('index fail'); });
    const ctx = makeCtx();
    // Should not throw even if source-library indexing fails.
    await expect(
      saveFileTool.execute({ content: 'x', filename: 'x.md', folderName: 'theory' }, ctx),
    ).resolves.toBeDefined();
  });

  it('formatResult includes the file path', async () => {
    const result = await saveFileTool.execute(
      { content: '# Test', filename: 'test.md', folderName: 'theory' },
      makeCtx(),
    );
    const formatted = saveFileTool.formatResult(result);
    expect(formatted).toContain('test.md');
  });

  it('rejects empty content via Zod', async () => {
    await expect(
      saveFileTool.execute({ content: '', filename: 'empty.md', folderName: 'theory' }, makeCtx()),
    ).rejects.toThrow();
  });

  it('rejects practice files that fail deterministic verifiers before writing', async () => {
    await expect(
      saveFileTool.execute({ content: '# Too thin\n\nNo numbered exercises here.', filename: 'bad.md', folderName: 'practice' }, makeCtx()),
    ).rejects.toThrow(/校验未通过/);
    expect(mockWriteFileContent).not.toHaveBeenCalled();
  });

  it('adds a transparent source fallback for practice files missing citation markers', async () => {
    await saveFileTool.execute(
      { content: '# Practice\n\nQ1. Missing citation but still a valid question.\n\n- KC：KC1', filename: 'practice.md', folderName: 'practice' },
      makeCtx(),
    );
    expect(mockWriteFileContent.mock.calls[0]?.[1]).toContain('[AI原创]');
  });
});
