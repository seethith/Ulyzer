import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DagNode } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { buildOutlineSearchResults } from '../web/source-strategy';
import { generateTopicOutline } from './topic-generator';

const electronState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userData),
  },
}));

vi.mock('../web/source-strategy', () => ({
  buildOutlineSearchResults: vi.fn(async () => []),
}));

vi.mock('../llm/adapter', () => ({
  LLMAdapter: {
    stream: vi.fn(async (opts: {
      onChunk?: (chunk: string) => void;
      onComplete?: (usage: { inputTokens: number; outputTokens: number; costCny: number }) => void;
    }) => {
      opts.onChunk?.('# 专题纲要\n\n## 知识单元（KCs）\n\n### KC1: 机制\n- 类型：陈述性\n- 布鲁姆层级：[分析/评估]\n- 前置KC：无\n- 掌握指标：解释机制');
      opts.onComplete?.({ inputTokens: 1, outputTokens: 2, costCny: 0 });
    }),
  },
}));

function node(): DagNode {
  return {
    id: 'node-1',
    courseId: 'course-1',
    chapter: '基础',
    name: '闭包',
    description: '理解 lexical environment',
    difficulty: 'beginner',
    prerequisites: [],
    position: { x: 0, y: 0 },
  } as unknown as DagNode;
}

describe('generateTopicOutline', () => {
  let tempDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulyzer-topic-generator-'));
    electronState.userData = tempDir;
    fs.mkdirSync(path.join(tempDir, 'ulyzer-content', 'course-1', 'node-1', '纲要'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the provided search mode instead of forcing auto', async () => {
    const filePath = await generateTopicOutline({
      courseId: 'course-1',
      nodeId: 'node-1',
      kcId: 'KC1',
      kcName: '闭包机制',
      provider: 'openai',
      model: 'gpt-test',
      language: 'zh',
      searchMode: 'off',
      onProgressChunk: vi.fn(),
      onComplete: vi.fn(),
    }, node());

    expect(buildOutlineSearchResults).toHaveBeenCalledWith('闭包机制', null, expect.objectContaining({
      searchMode: 'off',
    }));
    expect(LLMAdapter.stream).toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
