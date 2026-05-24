import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenMeter } from '../agent-context/token-meter';
import { usageLedger } from './usage-ledger';
import { LLMAdapter, type ILLMProvider, type LLMStreamOptions, type ToolStreamRequest } from './adapter';

vi.mock('../agent-context/token-meter', () => ({
  tokenMeter: {
    recordEstimate: vi.fn(),
  },
}));

vi.mock('./usage-ledger', () => ({
  usageLedger: {
    record: vi.fn(),
  },
}));

function fakeProvider(): ILLMProvider {
  return {
    countTokens: (text: string) => text.length,
    pricePer1kTokens: { input: 0, output: 0 },
    stream: async (options: LLMStreamOptions) => {
      options.onComplete({ inputTokens: 10, outputTokens: 2, costCny: 0.01 });
    },
    streamWithTools: async (_req: ToolStreamRequest) => ({
      stopReason: 'end_turn',
      text: '',
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 4, costCny: 0.02 },
      assistantTurn: { role: 'assistant', text: '', toolCalls: [] },
    }),
  };
}

function zeroUsageProvider(): ILLMProvider {
  return {
    countTokens: (text: string) => text.length,
    pricePer1kTokens: { input: 0, output: 0 },
    stream: async (options: LLMStreamOptions) => {
      options.onChunk('hello');
      options.onComplete({ inputTokens: 0, outputTokens: 0, costCny: 0 });
    },
    streamWithTools: async (req: ToolStreamRequest) => {
      req.onChunk('tool-result');
      return {
        stopReason: 'end_turn',
        text: 'tool-result',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
        assistantTurn: { role: 'assistant', text: 'tool-result', toolCalls: [] },
      };
    },
  };
}

describe('LLMAdapter usage metering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(tokenMeter.recordEstimate).mockClear();
    vi.mocked(usageLedger.record).mockClear();
  });

  it('records estimates and usage when usageContext is provided', async () => {
    vi.spyOn(LLMAdapter, 'getProvider').mockReturnValue(fakeProvider());
    const onComplete = vi.fn();

    await LLMAdapter.stream({
      provider: 'openai',
      model: 'test-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: () => {},
      onComplete,
      onError: () => {},
      usageContext: {
        sessionId: 'session-1',
        courseId: 'course-1',
        threadId: 'thread-1',
        source: 'intent_clarifier',
      },
    });

    expect(tokenMeter.recordEstimate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      courseId: 'course-1',
      threadId: 'thread-1',
      provider: 'openai',
      model: 'test-model',
      source: 'intent_clarifier',
    }));
    expect(usageLedger.record).toHaveBeenCalledWith({
      sessionId: 'session-1',
      courseId: 'course-1',
      provider: 'openai',
      model: 'test-model',
      usage: { inputTokens: 10, outputTokens: 2, costCny: 0.01 },
      source: 'intent_clarifier',
      estimateSource: 'intent_clarifier',
    });
    expect(onComplete).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 2, costCny: 0.01 });
  });

  it('does not auto-record unmetered calls', async () => {
    vi.spyOn(LLMAdapter, 'getProvider').mockReturnValue(fakeProvider());

    await LLMAdapter.stream({
      provider: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    expect(tokenMeter.recordEstimate).not.toHaveBeenCalled();
    expect(usageLedger.record).not.toHaveBeenCalled();
  });

  it('can meter tool streams without changing the response', async () => {
    vi.spyOn(LLMAdapter, 'getProvider').mockReturnValue(fakeProvider());

    const response = await LLMAdapter.streamWithTools({
      provider: 'openai',
      model: 'test-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: () => {},
      usageContext: { courseId: 'course-1', source: 'background_tool_loop' },
    });

    expect(response.usage).toEqual({ inputTokens: 20, outputTokens: 4, costCny: 0.02 });
    expect(tokenMeter.recordEstimate).toHaveBeenCalledWith(expect.objectContaining({
      courseId: 'course-1',
      source: 'background_tool_loop',
    }));
    expect(usageLedger.record).toHaveBeenCalledWith(expect.objectContaining({
      courseId: 'course-1',
      usage: { inputTokens: 20, outputTokens: 4, costCny: 0.02 },
      source: 'background_tool_loop',
    }));
  });

  it('falls back to local usage estimates when streaming usage is missing', async () => {
    vi.spyOn(LLMAdapter, 'getProvider').mockReturnValue(zeroUsageProvider());
    const onComplete = vi.fn();

    await LLMAdapter.stream({
      provider: 'ollama',
      model: 'local-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      onChunk: () => {},
      onComplete,
      onError: () => {},
      usageContext: {
        sessionId: 'session-1',
        courseId: 'course-1',
        threadId: 'thread-1',
        source: 'main_tutor_chat',
      },
    });

    const usage = onComplete.mock.calls[0]?.[0];
    expect(usage).toEqual(expect.objectContaining({
      estimated: true,
      costCny: 0,
    }));
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.inputCacheMissTokens).toBe(usage.inputTokens);
    expect(usageLedger.record).toHaveBeenCalledWith(expect.objectContaining({
      usage,
      source: 'main_tutor_chat',
    }));
  });
});
