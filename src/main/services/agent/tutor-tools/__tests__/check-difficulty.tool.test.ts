import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../index';

// Mock LLMAdapter before importing the tool
vi.mock('../../../llm/adapter', () => ({
  LLMAdapter: {
    stream: vi.fn(),
  },
}));

import { checkDifficultyTool } from '../check-difficulty.tool';
import { LLMAdapter } from '../../../llm/adapter';

const mockStream = LLMAdapter.stream as ReturnType<typeof vi.fn>;

function makeCtx(): ToolContext {
  return {
    sessionId: 'sess-1',
    courseId:  'course-1',
    nodeId:    'node-1',
    provider:  'anthropic',
    model:     'claude-sonnet-4-6',
    onProgress:      vi.fn(),
    onFileGenerated: vi.fn(),
  } as unknown as ToolContext;
}

/** Wire mockStream to emit a JSON string via onChunk */
function mockLLMResponse(json: string): void {
  mockStream.mockImplementationOnce(async ({ onChunk, onComplete }: {
    onChunk: (c: string) => void;
    onComplete: () => void;
  }) => {
    onChunk(json);
    onComplete();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('check_difficulty tool', () => {
  it('parses a valid JSON response', async () => {
    mockLLMResponse('{"layersFound":["第一层","第三层"],"missingLayers":["第二层","第四层"],"applyIsDominant":false,"issues":["缺少第二层"],"suggestion":"补充分析层题目"}');

    const result = await checkDifficultyTool.execute(
      { content: '## Q1\nWhat is a variable?', nodeName: 'Variables' },
      makeCtx(),
    );

    expect(result.layersFound).toContain('第一层');
    expect(result.missingLayers).toContain('第二层');
    expect(result.passed).toBe(false);
  });

  it('returns default on malformed JSON', async () => {
    mockLLMResponse('not json at all');

    const result = await checkDifficultyTool.execute(
      { content: 'q', nodeName: 'X' },
      makeCtx(),
    );

    expect(result.passed).toBe(false);
    expect(result.issues).not.toEqual([]);
    expect(result.suggestion).toContain('解析');
  });

  it('returns default when LLM returns empty string', async () => {
    mockLLMResponse('');

    const result = await checkDifficultyTool.execute(
      { content: 'q', nodeName: 'Y' },
      makeCtx(),
    );

    expect(result.passed).toBe(false);
  });

  it('extracts JSON embedded in surrounding text', async () => {
    mockLLMResponse('Here is my evaluation: {"layersFound":["第一层","第二层","第三层","第四层"],"missingLayers":[],"applyIsDominant":true,"issues":[],"suggestion":""} done.');

    const result = await checkDifficultyTool.execute(
      { content: 'q', nodeName: 'Z' },
      makeCtx(),
    );

    expect(result.passed).toBe(true);
  });

  it('formatResult shows layers and suggestion', () => {
    const formatted = checkDifficultyTool.formatResult({
      layersFound:     ['第一层', '第三层'],
      missingLayers:   ['第二层', '第四层'],
      applyIsDominant: false,
      issues:          ['缺少第二层', '缺少第四层'],
      passed:          false,
      suggestion:      '补充分析层',
    });
    expect(formatted).toContain('第一层');
    expect(formatted).toContain('缺少第二层');
    expect(formatted).toContain('补充分析层');
  });

  it('formatResult shows ✓ when no issues', () => {
    const formatted = checkDifficultyTool.formatResult({
      layersFound:     ['第一层', '第二层', '第三层', '第四层'],
      missingLayers:   [],
      applyIsDominant: true,
      issues:          [],
      passed:          true,
      suggestion:      '',
    });
    expect(formatted).toContain('✓');
  });
});
