import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileTool } from './content.tools';
import type { ToolContext } from '../tutor-tools';

const electronState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userData),
  },
}));

function toolContext(): ToolContext {
  return {
    sessionId: 's1',
    courseId: 'course',
    nodeId: 'node',
    provider: 'openai',
    model: 'test-model',
    language: 'zh',
    onProgress: vi.fn(),
    onFileGenerated: vi.fn(),
  };
}

describe('readFileTool', () => {
  let tempDir = '';
  let nodeDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulyzer-read-file-'));
    electronState.userData = tempDir;
    nodeDir = path.join(tempDir, 'ulyzer-content', 'course', 'node');
    fs.mkdirSync(path.join(nodeDir, '纲要'), { recursive: true });
    fs.writeFileSync(path.join(nodeDir, '纲要', '_outline_v1.md'), '# 知识纲要\n\n### KC1: test', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads node-relative paths returned by list_node_files', async () => {
    const result = await readFileTool.execute({ filename: '纲要/_outline_v1.md' }, toolContext());

    expect(result.success).toBe(true);
    expect(result.message).toBe('[纲要/_outline_v1.md]');
    expect(result.content).toContain('KC1');
  });

  it('can search the outline folder by folder key', async () => {
    const result = await readFileTool.execute({ filename: '_outline_v1.md', folder: 'outline' }, toolContext());

    expect(result.success).toBe(true);
    expect(result.message).toBe('[纲要/_outline_v1.md]');
    expect(result.content).toContain('知识纲要');
  });
});
