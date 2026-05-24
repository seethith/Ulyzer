import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DagNode, SearchMode } from '@shared/types';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import { NodeRepository } from '../../db/repositories/node.repo';
import type { ToolContext } from '../tutor-tools';
import { generateOutlineTool } from './generate-outline.tool';
import { generateTopicTool } from './generate-topic.tool';

const electronState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userData),
  },
}));

function node(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'node-1',
    courseId: 'course-1',
    chapter: '基础',
    name: '闭包',
    description: '理解 lexical environment',
    difficulty: 'beginner',
    prerequisites: [],
    position: { x: 0, y: 0 },
    ...overrides,
  } as unknown as DagNode;
}

function createToolContext(searchMode: SearchMode): ToolContext {
  return {
    sessionId: 'session-1',
    courseId: 'course-1',
    nodeId: 'node-1',
    provider: 'openai',
    model: 'gpt-test',
    language: 'zh',
    searchMode,
    onProgress: vi.fn(),
    onFileGenerated: vi.fn(),
  };
}

describe('outline and topic generation tools', () => {
  let tempDir = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulyzer-outline-topic-tools-'));
    electronState.userData = tempDir;
    vi.spyOn(NodeRepository.prototype, 'findById').mockReturnValue(node());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes the active search mode into outline generation', async () => {
    const runSpy = vi.spyOn(workflowRunner, 'run').mockResolvedValue({ version: 1, skipped: false });

    await generateOutlineTool.execute({}, createToolContext('library'));

    expect(runSpy).toHaveBeenCalledWith('outline.generateNext', {
      options: expect.objectContaining({
        courseId: 'course-1',
        nodeId: 'node-1',
        searchMode: 'library',
      }),
      node: expect.objectContaining({ id: 'node-1' }),
    }, { context: undefined, plan: undefined });
  });

  it('treats an already-complete outline bundle as a successful no-op', async () => {
    vi.spyOn(workflowRunner, 'run').mockResolvedValue({ version: 3, skipped: true });

    const result = await generateOutlineTool.execute({}, createToolContext('auto'));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('三层基础蓝图已经齐全');
  });

  it('passes the active search mode into topic generation', async () => {
    const runSpy = vi.spyOn(workflowRunner, 'run').mockResolvedValue({ filePath: '/tmp/topic.md' });

    await generateTopicTool.execute({ kcId: 'KC1', kcName: '闭包' }, createToolContext('off'));

    expect(runSpy).toHaveBeenCalledWith('topic.generate', {
      options: expect.objectContaining({
        courseId: 'course-1',
        nodeId: 'node-1',
        kcId: 'KC1',
        kcName: '闭包',
        searchMode: 'off',
      }),
      node: expect.objectContaining({ id: 'node-1' }),
    }, { context: undefined, plan: undefined });
  });
});
