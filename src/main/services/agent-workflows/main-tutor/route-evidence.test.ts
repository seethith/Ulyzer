import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePack, SourceRecord } from '@shared/types';
import { LLMAdapter } from '../../llm/adapter';
import { collectEvidencePack } from '../../web/research-pipeline';
import { collectLibraryRoadmapEvidence } from './library-roadmap-evidence';
import { collectRouteEvidence } from './route-evidence';

vi.mock('../../llm/adapter', () => ({
  LLMAdapter: {
    stream: vi.fn(),
  },
}));

vi.mock('../../web/research-pipeline', () => ({
  collectEvidencePack: vi.fn(),
  summarizeEvidencePack: vi.fn(() => '检索参考库 1 条 · 官方来源 0 条 · 网页补充 0 条\n'),
}));

vi.mock('./library-roadmap-evidence', () => ({
  collectLibraryRoadmapEvidence: vi.fn(),
}));

const source: SourceRecord = {
  id: 'source-1',
  courseId: 'course-1',
  nodeId: null,
  scope: 'main_private',
  usage: 'planning_only',
  kind: 'upload',
  origin: 'user_import',
  title: '课程大纲',
  url: null,
  filePath: 'outline.md',
  host: null,
  trustScore: 0.9,
  enabled: true,
  createdAt: '',
};

const pack: EvidencePack = {
  query: '瑜伽课程大纲',
  taskType: 'roadmap',
  sources: [source],
  chunks: [{
    chunkId: 'chunk-1',
    sourceId: 'source-1',
    text: '课程目标包含体式、调息、冥想和综合练习。',
    locator: 'chunk 1',
    score: 0.9,
    sourceKind: 'upload',
    slot: 'curriculum',
  }],
  coverage: {
    required: ['curriculum', 'prerequisites'],
    covered: ['curriculum'],
    missing: ['prerequisites'],
  },
  budgetUsed: {
    queries: 1,
    pagesFetched: 0,
    reflectionSearches: 0,
    llmReranks: 0,
  },
  warnings: [],
};

describe('collectRouteEvidence', () => {
  beforeEach(() => {
    vi.mocked(LLMAdapter.stream).mockReset();
    vi.mocked(collectEvidencePack).mockReset();
    vi.mocked(collectLibraryRoadmapEvidence).mockReset();
  });

  it('uses model-planned queries and keeps source ids in the digest', async () => {
    vi.mocked(LLMAdapter.stream).mockImplementation(async (options) => {
      options.onChunk(JSON.stringify({
        needs_external_evidence: true,
        library_query: '瑜伽 课程大纲',
        web_queries: [{ query: 'yoga syllabus curriculum', purpose: 'curriculum' }],
        evidence_goals: ['curriculum'],
        rationale: '需要课程结构依据',
      }));
      options.onComplete({ inputTokens: 2, outputTokens: 3, costCny: 0 });
    });
    vi.mocked(collectEvidencePack).mockResolvedValue(pack);

    const usage: number[] = [];
    const result = await collectRouteEvidence({
      topic: '瑜伽',
      profileText: '',
      courseId: 'course-1',
      provider: 'openai',
      model: 'model',
      searchMode: 'auto',
      onUsage: (u) => usage.push(u.inputTokens + u.outputTokens),
    });

    expect(usage).toEqual([5]);
    expect(collectEvidencePack).toHaveBeenCalledWith(expect.objectContaining({
      query: '瑜伽 课程大纲',
      plannedQueries: [{ query: 'yoga syllabus curriculum', purpose: 'curriculum' }],
      taskType: 'roadmap',
    }));
    expect(result.digest).toContain('source_id: source-1');
    expect(result.digest).toContain('课程目标包含体式');
  });

  it('skips retrieval when search mode is off', async () => {
    const result = await collectRouteEvidence({
      topic: '瑜伽',
      profileText: '',
      courseId: 'course-1',
      provider: 'openai',
      model: 'model',
      searchMode: 'off',
    });

    expect(LLMAdapter.stream).not.toHaveBeenCalled();
    expect(collectEvidencePack).not.toHaveBeenCalled();
    expect(result.pack).toBeNull();
    expect(result.digest).toContain('搜索已关闭');
  });

  it('uses deep library evidence instead of generic web pipeline in library mode', async () => {
    vi.mocked(LLMAdapter.stream).mockImplementation(async (options) => {
      options.onChunk(JSON.stringify({
        needs_external_evidence: true,
        library_query: '操作系统 目录 章节',
        web_queries: [{ query: 'operating systems syllabus', purpose: 'curriculum' }],
        evidence_goals: ['curriculum'],
      }));
      options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
    });
    vi.mocked(collectLibraryRoadmapEvidence).mockResolvedValue({
      ...pack,
      budgetUsed: { ...pack.budgetUsed, queries: 0, pagesFetched: 12 },
    });

    const result = await collectRouteEvidence({
      topic: '操作系统',
      profileText: '',
      courseId: 'course-1',
      provider: 'openai',
      model: 'model',
      searchMode: 'library',
    });

    expect(collectLibraryRoadmapEvidence).toHaveBeenCalledWith(expect.objectContaining({
      courseId: 'course-1',
      query: '操作系统 目录 章节',
      language: undefined,
      provider: 'openai',
      model: 'model',
    }));
    expect(collectEvidencePack).not.toHaveBeenCalled();
    expect(result.digest).toContain('source_id: source-1');
    expect(result.digest).toContain('严格参考库模式');
    expect(result.digest).not.toContain('专业知识补齐');
  });
});
