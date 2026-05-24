import type { FileGeneratedPayload } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunContext } from '../../agent-core/run-context';
import { workflowRunner } from '../../agent-workflows/workflow-runner';
import type { MaterialGenerateWorkflowInput } from '../../agent-workflows/workflow-types';
import type { ToolContext } from '../tutor-tools/index';
import { generatePracticeTool, generateTheoryTool } from './generate.tools';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session-1',
    courseId: 'course-1',
    nodeId: 'node-1',
    provider: 'openai',
    model: 'gpt-test',
    language: 'zh',
    searchMode: 'auto',
    onProgress: vi.fn(),
    onFileGenerated: vi.fn(),
    ...overrides,
  };
}

describe('chat material generation tools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes custom theory requests into the material generation workflow', async () => {
    const runSpy = vi.spyOn(workflowRunner, 'run').mockImplementation(async (_id, input) => {
      const materialInput = input as MaterialGenerateWorkflowInput;
      const payload: FileGeneratedPayload = {
        sessionId: materialInput.request.sessionId,
        filePath: '/tmp/theory-v1.md',
        folderName: 'theory',
        nodeId: materialInput.request.nodeId,
        usage: { inputTokens: 1, outputTokens: 2, costCny: 0.01 },
      };
      materialInput.request.onFileGenerated(payload);
      return { fileSaved: true };
    });
    const ctx = createToolContext({ searchMode: 'library' });

    const result = await generateTheoryTool.execute({
      topic: '闭包',
      custom_instructions: '请用我熟悉的 JavaScript 项目来解释闭包',
      outline_version: 'v1',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.fileName).toBe('theory-v1.md');
    expect(ctx.onFileGenerated).toHaveBeenCalledWith(expect.objectContaining({
      folderName: 'theory',
      nodeId: 'node-1',
    }));
    expect(runSpy).toHaveBeenCalledWith('material.generate', {
      request: expect.objectContaining({
        courseId: 'course-1',
        nodeId: 'node-1',
        targetFolder: 'theory',
        userMessage: '请用我熟悉的 JavaScript 项目来解释闭包',
        searchMode: 'library',
        outlineVersion: 'v1',
      }),
    }, { context: undefined, plan: undefined });
  });

  it('routes personalized practice requests with the active run context', async () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebContents;
    const runContext = new AgentRunContext({ sessionId: 'session-1', sender });
    const runSpy = vi.spyOn(workflowRunner, 'run').mockResolvedValue({ fileSaved: true });
    const ctx = createToolContext({ runContext, searchMode: 'web' });

    await generatePracticeTool.execute({
      topic: '错误处理',
      custom_instructions: '按照我的薄弱点多出调试题',
      outline_version: 'v2',
    }, ctx);

    expect(runSpy).toHaveBeenCalledWith('material.generate', {
      request: expect.objectContaining({
        targetFolder: 'practice',
        userMessage: '按照我的薄弱点多出调试题',
        searchMode: 'web',
        outlineVersion: 'v2',
      }),
    }, { context: runContext, plan: undefined });
  });

  it('lets guard-level outline version override omitted tool input', async () => {
    const runSpy = vi.spyOn(workflowRunner, 'run').mockResolvedValue({ fileSaved: false });
    const ctx = createToolContext({ outlineVersion: 'v3' });

    await generateTheoryTool.execute({ topic: '矩阵' }, ctx);

    expect(runSpy).toHaveBeenCalledWith('material.generate', {
      request: expect.objectContaining({
        outlineVersion: 'v3',
      }),
    }, { context: undefined, plan: undefined });
  });

  it('fails safely when no node is selected', async () => {
    const runSpy = vi.spyOn(workflowRunner, 'run');
    const result = await generateTheoryTool.execute({ topic: '任意主题' }, createToolContext({ nodeId: '' }));

    expect(result.success).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
