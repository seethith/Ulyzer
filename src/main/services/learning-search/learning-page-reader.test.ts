import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningSearchCandidate, LearningSourceEvaluation, LearningSourcePlan, SourceRecord } from '@shared/types';
import { readLearningSearchCandidates } from './learning-page-reader';
import { findWebSourceByUrl, getSourceChunkCount, getSourceChunks, upsertWebSource } from '../source/source-library';
import { ingestUrlSource, shouldRefreshUrlSource } from '../source/url-ingestion';

vi.mock('../source/source-library', () => ({
  findWebSourceByUrl: vi.fn(() => null),
  getSourceChunkCount: vi.fn(() => 0),
  getSourceChunks: vi.fn(() => []),
  upsertWebSource: vi.fn(),
}));

vi.mock('../source/url-ingestion', () => ({
  ingestUrlSource: vi.fn(),
  shouldRefreshUrlSource: vi.fn(() => false),
}));

vi.mock('./learning-source-metadata', () => ({
  persistSourceLearningMetadata: vi.fn(),
}));

vi.mock('../source/source-semantic-profile', () => ({
  scheduleSourceSemanticProfile: vi.fn(),
}));

const plan: LearningSourcePlan = {
  id: 'plan-1',
  courseId: 'course-1',
  taskType: 'practice',
  userGoal: '线性代数',
  learningShape: 'exam_course',
  planningRationale: 'test',
  createdAt: new Date().toISOString(),
  slots: [{
    id: 'practice',
    name: '练习题',
    purpose: '找到练习题',
    mustHave: true,
    priority: 'high',
    queryIntents: ['linear algebra practice'],
    qualityCriteria: ['有题目'],
    acceptableSourceTypes: ['exercise_or_assignment'],
  }],
};

const source: SourceRecord = {
  id: 'source-1',
  courseId: 'course-1',
  nodeId: null,
  scope: 'main_private',
  usage: 'planning_only',
  kind: 'web',
  origin: 'web_collected',
  title: 'Linear Algebra Problem Set',
  url: 'https://example.edu/linear-algebra-problems',
  filePath: null,
  host: 'example.edu',
  trustScore: 0.86,
  enabled: true,
  createdAt: '',
};

function candidate(url = source.url!): LearningSearchCandidate {
  return {
    slotId: 'practice',
    query: 'linear algebra problem set',
    title: 'Linear Algebra Problem Set',
    url,
    excerpt: 'Practice problems and worked examples. '.repeat(20),
    provider: 'tavily',
    rawScore: 0.86,
  };
}

function evaluation(partial: Partial<LearningSourceEvaluation>): LearningSourceEvaluation {
  return {
    url: source.url!,
    slotId: 'practice',
    sourceType: 'exercise_or_assignment',
    trustLevel: 'academic',
    qualityScore: 0.82,
    whyUseful: 'practice slot',
    limitations: '',
    shouldIngest: true,
    enabledByDefault: true,
    mainEvidence: true,
    ...partial,
  };
}

describe('readLearningSearchCandidates ingestion policy', () => {
  beforeEach(() => {
    vi.mocked(findWebSourceByUrl).mockReset().mockReturnValue(null);
    vi.mocked(getSourceChunkCount).mockReset().mockReturnValue(0);
    vi.mocked(getSourceChunks).mockReset().mockReturnValue([]);
    vi.mocked(upsertWebSource).mockReset();
    vi.mocked(shouldRefreshUrlSource).mockReset().mockReturnValue(false);
    vi.mocked(ingestUrlSource).mockReset().mockResolvedValue({
      record: source,
      normalizedUrl: source.url!,
      storedUrl: source.url!,
      title: source.title,
      content: 'Full page text',
      kind: 'web',
      warnings: [],
    });
  });

  it('ingests high-quality candidates', async () => {
    await readLearningSearchCandidates({
      candidates: [candidate()],
      evaluations: [evaluation({})],
      plan,
      courseId: 'course-1',
      taskType: 'practice',
      maxPagesToFetch: 1,
      maxEvidenceChunks: 3,
    });
    expect(ingestUrlSource).toHaveBeenCalledOnce();
  });

  it('skips low-quality candidates', async () => {
    const result = await readLearningSearchCandidates({
      candidates: [candidate()],
      evaluations: [evaluation({ shouldIngest: false, qualityScore: 0.3, limitations: 'too weak' })],
      plan,
      courseId: 'course-1',
      taskType: 'practice',
      maxPagesToFetch: 1,
      maxEvidenceChunks: 3,
    });
    expect(ingestUrlSource).not.toHaveBeenCalled();
    expect(result.warnings.join('\n')).toContain('已跳过低质量搜索资料');
  });

  it('skips risky document-sharing candidates before fetching pages', async () => {
    const result = await readLearningSearchCandidates({
      candidates: [candidate('https://wenku.baidu.com/view/thesis-example')],
      evaluations: [evaluation({
        qualityScore: 0.9,
        mainEvidence: true,
        limitations: '',
      })],
      plan,
      courseId: 'course-1',
      taskType: 'theory',
      maxPagesToFetch: 1,
      maxEvidenceChunks: 3,
    });
    expect(ingestUrlSource).not.toHaveBeenCalled();
    expect(result.warnings.join('\n')).toContain('已跳过风险搜索资料');
  });

  it('does not save search-excerpt fallback for non-main unknown sources', async () => {
    vi.mocked(ingestUrlSource).mockRejectedValue(new Error('fetch failed'));
    const result = await readLearningSearchCandidates({
      candidates: [candidate('https://example.com/linear-algebra-overview')],
      evaluations: [evaluation({
        qualityScore: 0.7,
        mainEvidence: false,
        trustLevel: 'unknown',
      })],
      plan,
      courseId: 'course-1',
      taskType: 'theory',
      maxPagesToFetch: 1,
      maxEvidenceChunks: 3,
    });
    expect(upsertWebSource).not.toHaveBeenCalled();
    expect(result.warnings.join('\n')).toContain('已跳过搜索摘要 fallback');
  });

  it('reuses existing indexed URLs without duplicate ingestion', async () => {
    vi.mocked(findWebSourceByUrl).mockReturnValue(source);
    vi.mocked(getSourceChunkCount).mockReturnValue(1);
    vi.mocked(getSourceChunks).mockReturnValue([{
      chunkId: 'chunk-1',
      sourceId: source.id,
      text: 'Existing indexed chunk',
      locator: 'chunk 1',
      score: 0.8,
      sourceKind: 'web',
    }]);
    const result = await readLearningSearchCandidates({
      candidates: [candidate()],
      evaluations: [evaluation({})],
      plan,
      courseId: 'course-1',
      taskType: 'practice',
      maxPagesToFetch: 1,
      maxEvidenceChunks: 3,
    });
    expect(ingestUrlSource).not.toHaveBeenCalled();
    expect(result.chunks[0].text).toBe('Existing indexed chunk');
  });
});
