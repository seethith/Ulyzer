import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../index';

// Mock heavy Electron/DB/fs dependencies before importing the tool
vi.mock('../../../fs/content.service', () => ({
  getFolderPath: vi.fn((_courseId: string, _nodeId: string, folder: string) => `/fake/${folder}`),
  writeFileContent: vi.fn(),
  getLatestOutlinePath: vi.fn(() => null),
}));
vi.mock('../../../rag/indexer', () => ({
  indexFile: vi.fn(),
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
vi.mock('../../extended-reading', () => ({
  buildExtendedReading: vi.fn(() => ''),
}));

import { saveFileTool } from '../save-file.tool';
import { getFolderPath, writeFileContent } from '../../../fs/content.service';
import { indexFile } from '../../../rag/indexer';

const mockGetFolderPath    = getFolderPath    as ReturnType<typeof vi.fn>;
const mockWriteFileContent = writeFileContent as ReturnType<typeof vi.fn>;
const mockIndexFile        = indexFile        as ReturnType<typeof vi.fn>;

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

  it('calls onProgress with the filename', async () => {
    const ctx = makeCtx();
    await saveFileTool.execute(
      { content: '# Hi', filename: 'hi.md', folderName: 'practice' },
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

  it('attempts RAG indexing (non-fatal)', async () => {
    mockIndexFile.mockImplementationOnce(() => { throw new Error('rag fail'); });
    const ctx = makeCtx();
    // Should not throw even if indexFile fails
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
});
