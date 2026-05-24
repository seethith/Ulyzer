import { describe, expect, it, vi } from 'vitest';
import { compactByDecision, runGraduatedCompaction, truncateHeadTail } from './compaction-ladder';
import type { ToolTurnMessage } from '../llm/adapter';

function makeMessages(n: number): ToolTurnMessage[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { role: 'user' as const, content: `u${i}` }
      : { role: 'assistant' as const, text: `a${i}`, toolCalls: [] },
  );
}

const llmOpts = {
  provider: 'anthropic' as const,
  model: 'test',
  onProgress: vi.fn(),
};

describe('truncateHeadTail', () => {
  it('keeps head + tail and drops the middle', () => {
    const msgs = makeMessages(20);
    const out = truncateHeadTail(msgs, { head: 2, tail: 4 });
    expect(out).toHaveLength(6);
    expect(out.slice(0, 2)).toEqual(msgs.slice(0, 2));
    expect(out.slice(-4)).toEqual(msgs.slice(-4));
  });

  it('is a no-op when already within head + tail', () => {
    const msgs = makeMessages(5);
    expect(truncateHeadTail(msgs, { head: 2, tail: 4 })).toBe(msgs);
  });
});

describe('runGraduatedCompaction', () => {
  it('does nothing when below compressAt', async () => {
    const msgs = makeMessages(25);
    const result = await runGraduatedCompaction(msgs, {
      ...llmOpts,
      estimate: () => 100,
      compressAt: 500,
      collapseAt: 900,
    });
    expect(result.applied).toBe('none');
    expect(result.messages).toBe(msgs);
  });

  it('microcompacts (no LLM) when over compressAt but under collapseAt afterwards', async () => {
    const msgs = makeMessages(25); // > HISTORY_COMPRESS_THRESHOLD so microcompact actually folds
    let calls = 0;
    const result = await runGraduatedCompaction(msgs, {
      ...llmOpts,
      // first estimate triggers compress; post-compress estimate stays below collapseAt
      estimate: () => (calls++ === 0 ? 1000 : 100),
      compressAt: 500,
      collapseAt: 900,
    });
    expect(result.applied).toBe('compress');
    expect(result.messages.length).toBeLessThan(msgs.length);
  });
});

describe('compactByDecision', () => {
  it('returns none when neither tier is requested', async () => {
    const msgs = makeMessages(25);
    const result = await compactByDecision(msgs, { ...llmOpts, compress: false, collapse: false });
    expect(result.applied).toBe('none');
    expect(result.messages).toBe(msgs);
  });

  it('returns none when at/below minMessages even if requested', async () => {
    const msgs = makeMessages(3);
    const result = await compactByDecision(msgs, { ...llmOpts, compress: true, collapse: false });
    expect(result.applied).toBe('none');
  });

  it('applies microcompact when compress is requested', async () => {
    const msgs = makeMessages(25);
    const result = await compactByDecision(msgs, { ...llmOpts, compress: true, collapse: false });
    expect(result.applied).toBe('compress');
    expect(result.messages.length).toBeLessThan(msgs.length);
  });
});
