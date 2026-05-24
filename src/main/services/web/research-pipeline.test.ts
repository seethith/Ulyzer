import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceRecord } from '@shared/types';
import { hybridRetrieve } from '../retrieval/hybrid-retriever';
import { tavilySearch } from './tavily';
import { exaSearch } from './exa';
import { collectEvidencePack } from './research-pipeline';

vi.mock('../retrieval/hybrid-retriever', () => ({
  hybridRetrieve: vi.fn(),
}));

vi.mock('./tavily', () => ({
  tavilySearch: vi.fn(),
}));

vi.mock('./exa', () => ({
  exaSearch: vi.fn(),
}));

vi.mock('./page-extractor', () => ({
  extractPage: vi.fn(),
}));

vi.mock('../source/url-ingestion', () => ({
  ingestUrlSource: vi.fn(),
  shouldRefreshUrlSource: vi.fn(() => false),
}));

vi.mock('../source/source-library', () => ({
  findWebSourceByUrl: vi.fn(() => null),
  getSourceChunkCount: vi.fn(() => 0),
  getSourceChunks: vi.fn(() => []),
  upsertWebSource: vi.fn(),
}));

const source: SourceRecord = {
  id: 'source-1',
  courseId: 'course-1',
  nodeId: null,
  scope: 'main_private',
  usage: 'planning_only',
  kind: 'upload',
  origin: 'user_import',
  title: '参考资料',
  url: null,
  filePath: 'book.pdf',
  host: null,
  trustScore: 0.9,
  enabled: true,
  createdAt: '',
};

describe('collectEvidencePack search modes', () => {
  beforeEach(() => {
    vi.mocked(hybridRetrieve).mockReset();
    vi.mocked(tavilySearch).mockReset();
    vi.mocked(exaSearch).mockReset();
    vi.mocked(hybridRetrieve).mockResolvedValue({
      sources: [source],
      candidates: [{
        chunkId: 'chunk-1',
        sourceId: source.id,
        text: '课程大纲和学习目标',
        locator: 'page 1',
        score: 0.9,
        finalScore: 0.9,
        sourceKind: 'upload',
        retrievalMethod: 'lexical',
      }],
      method: 'lexical',
    });
    vi.mocked(tavilySearch).mockResolvedValue({ results: [] });
    vi.mocked(exaSearch).mockResolvedValue({ results: [] });
  });

  it('does not read the source library in web-only mode', async () => {
    await collectEvidencePack({
      query: '操作系统课程大纲',
      courseId: 'course-1',
      mode: 'web',
      taskType: 'roadmap',
    });

    expect(hybridRetrieve).not.toHaveBeenCalled();
    expect(tavilySearch).toHaveBeenCalled();
  });

  it('does not use web search in library mode', async () => {
    const pack = await collectEvidencePack({
      query: '操作系统课程大纲',
      courseId: 'course-1',
      mode: 'library',
      taskType: 'roadmap',
    });

    expect(hybridRetrieve).toHaveBeenCalled();
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(exaSearch).not.toHaveBeenCalled();
    expect(pack.sources).toEqual([source]);
  });

  it('does not read library or web sources in off mode', async () => {
    await collectEvidencePack({
      query: '操作系统课程大纲',
      courseId: 'course-1',
      mode: 'off',
      taskType: 'roadmap',
    });

    expect(hybridRetrieve).not.toHaveBeenCalled();
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(exaSearch).not.toHaveBeenCalled();
  });
});
