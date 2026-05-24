import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DagNode } from '@shared/types';
import { LLMAdapter } from '../../llm/adapter';
import { writeFileContent } from '../../fs/content.service';
import { ChapterScopeGenerator } from './chapter-scope';

vi.mock('../../llm/adapter', () => ({
  LLMAdapter: {
    stream: vi.fn(),
  },
}));

vi.mock('../../fs/content.service', () => ({
  getCourseDir: vi.fn(() => '/tmp/course'),
  writeFileContent: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

const node = (chapter: string, name: string, node_type: 'main' | 'boss' = 'main'): DagNode => ({
  id: `${chapter}-${name}`,
  course_id: 'course-1',
  chapter,
  chapter_order: 0,
  name,
  description: '',
  node_type,
  status: 'locked',
  difficulty: 'beginner',
  prerequisites: [],
  required_tools: [],
  required_cost: {},
  position_x: 0,
  position_y: 0,
  bloom_target: null,
  learning_type: null,
  priority: null,
  source_ids: [],
  rationale: null,
  created_at: '',
  updated_at: '',
});

describe('ChapterScopeGenerator', () => {
  beforeEach(() => {
    vi.mocked(LLMAdapter.stream).mockReset();
    vi.mocked(writeFileContent).mockReset();
  });

  it('generates scopes chapter by chapter and reports progress', async () => {
    vi.mocked(LLMAdapter.stream).mockImplementation(async (options) => {
      const content = options.messages[0]?.content ?? '';
      const chapter = content.includes('章节：进阶') ? '进阶' : '基础';
      options.onChunk(JSON.stringify({
        [chapter]: {
          nodes: [`${chapter}节点`],
          scope_distribution: { [`${chapter}节点`]: ['理解核心概念'] },
          boundary_notes: 'Boss 覆盖综合应用',
        },
      }));
      options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
    });

    const events: string[] = [];
    await new ChapterScopeGenerator().generate(
      'course-1',
      [
        node('基础', '基础节点'),
        node('基础', '基础 Boss', 'boss'),
        node('进阶', '进阶节点'),
      ],
      'openai',
      'model',
      undefined,
      {
        onStart: (count) => events.push(`start:${count}`),
        onChapterStart: (chapter) => events.push(`chapter-start:${chapter}`),
        onChapterComplete: (chapter) => events.push(`chapter-complete:${chapter}`),
        onComplete: (completed, total) => events.push(`complete:${completed}/${total}`),
      },
    );

    expect(LLMAdapter.stream).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      'start:2',
      'chapter-start:基础',
      'chapter-complete:基础',
      'chapter-start:进阶',
      'chapter-complete:进阶',
      'complete:2/2',
    ]);
    expect(writeFileContent).toHaveBeenCalledTimes(2);

    const [, finalContent] = vi.mocked(writeFileContent).mock.calls.at(-1)!;
    expect(JSON.parse(finalContent)).toMatchObject({
      基础: { scope_distribution: { 基础节点: ['理解核心概念'] } },
      进阶: { scope_distribution: { 进阶节点: ['理解核心概念'] } },
    });
    expect(vi.mocked(LLMAdapter.stream).mock.calls[0]?.[0].maxTokens).toBeGreaterThan(1200);
  });

  it('repairs invalid scope JSON once before falling back', async () => {
    vi.mocked(LLMAdapter.stream)
      .mockImplementationOnce(async (options) => {
        options.onChunk('not json');
        options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
      })
      .mockImplementationOnce(async (options) => {
        options.onChunk(JSON.stringify({
          基础: {
            nodes: ['基础节点'],
            scope_distribution: { 基础节点: ['理解核心概念', '掌握基本方法', '完成基础练习'] },
            boundary_notes: '修复后范围',
          },
        }));
        options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
      });

    const events: string[] = [];
    await new ChapterScopeGenerator().generate(
      'course-1',
      [node('基础', '基础节点')],
      'openai',
      'model',
      undefined,
      {
        onChapterFailed: (chapter) => events.push(`failed:${chapter}`),
        onChapterComplete: (chapter) => events.push(`complete:${chapter}`),
        onComplete: (completed, total) => events.push(`done:${completed}/${total}`),
      },
    );

    expect(LLMAdapter.stream).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['complete:基础', 'done:1/1']);
    const [, content] = vi.mocked(writeFileContent).mock.calls.at(-1)!;
    expect(JSON.parse(content)).toMatchObject({
      基础: {
        scope_distribution: { 基础节点: ['理解核心概念', '掌握基本方法', '完成基础练习'] },
      },
    });
  });

  it('uses deterministic fallback when generation and repair both fail', async () => {
    vi.mocked(LLMAdapter.stream).mockImplementation(async (options) => {
      options.onChunk('not json');
      options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
    });

    const events: string[] = [];
    await new ChapterScopeGenerator().generate(
      'course-1',
      [node('基础', '基础节点')],
      'openai',
      'model',
      undefined,
      {
        onChapterFailed: (chapter) => events.push(`failed:${chapter}`),
        onChapterComplete: (chapter) => events.push(`complete:${chapter}`),
        onComplete: (completed, total) => events.push(`done:${completed}/${total}`),
      },
    );

    expect(LLMAdapter.stream).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['complete:基础', 'done:1/1']);
    const [, content] = vi.mocked(writeFileContent).mock.calls.at(-1)!;
    const parsed = JSON.parse(content);
    expect(parsed.基础.nodes).toEqual(['基础节点']);
    expect(parsed.基础.scope_distribution.基础节点).toContain('理解基础节点的核心概念');
  });
});
