import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMAdapter, type LLMStreamOptions } from './adapter';
import { streamStructuredCompletion } from './structured-stream';

vi.mock('./adapter', () => ({
  LLMAdapter: {
    stream: vi.fn(),
  },
}));

describe('streamStructuredCompletion', () => {
  beforeEach(() => {
    vi.mocked(LLMAdapter.stream).mockReset();
  });

  it('continues and merges truncated JSON suffixes', async () => {
    vi.mocked(LLMAdapter.stream)
      .mockImplementationOnce(async (options: LLMStreamOptions) => {
        options.onChunk('{"nodes":[{"id":"a"');
        options.onStop?.('max_tokens');
        options.onComplete({ inputTokens: 10, outputTokens: 5, costCny: 0.01 });
      })
      .mockImplementationOnce(async (options: LLMStreamOptions) => {
        options.onChunk(',"name":"A"}],"edges":[]}');
        options.onStop?.('end_turn');
        options.onComplete({ inputTokens: 8, outputTokens: 5, costCny: 0.01 });
      });

    const usage: number[] = [];
    const progress: string[] = [];
    const result = await streamStructuredCompletion({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'json only',
      messages: [{ role: 'user', content: 'make json' }],
      jsonMode: true,
      kind: 'json',
      maxContinuations: 2,
      onUsage: (u) => usage.push(u.inputTokens + u.outputTokens),
      onProgress: (msg) => progress.push(msg),
    });

    expect(JSON.parse(result.text)).toEqual({
      nodes: [{ id: 'a', name: 'A' }],
      edges: [],
    });
    expect(result.continuationCount).toBe(1);
    expect(result.hitContinuationLimit).toBe(false);
    expect(usage).toEqual([15, 13]);
    expect(progress.join('\n')).toContain('输出已截断');
    expect(vi.mocked(LLMAdapter.stream)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(LLMAdapter.stream).mock.calls[1][0].jsonMode).toBe(false);
    expect(vi.mocked(LLMAdapter.stream).mock.calls[1][0].messages.at(-1)?.content).toContain('缺失 JSON 后缀');
  });

  it('deduplicates repeated continuation overlap', async () => {
    vi.mocked(LLMAdapter.stream)
      .mockImplementationOnce(async (options: LLMStreamOptions) => {
        options.onChunk('hello wor');
        options.onStop?.('max_tokens');
        options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
      })
      .mockImplementationOnce(async (options: LLMStreamOptions) => {
        options.onChunk('world');
        options.onStop?.('end_turn');
        options.onComplete({ inputTokens: 1, outputTokens: 1, costCny: 0 });
      });

    const result = await streamStructuredCompletion({
      provider: 'openai',
      model: 'test',
      messages: [{ role: 'user', content: 'say hello' }],
      kind: 'text',
    });

    expect(result.text).toBe('hello world');
  });
});
