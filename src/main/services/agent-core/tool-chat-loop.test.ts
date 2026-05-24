import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import { createAgentToolRegistry } from '../agent-tools/registry';
import type { AgentTool } from '../agent-tools/types';
import { LLMAdapter } from '../llm/adapter';
import type { ToolCallBlock, ToolStreamRequest, ToolStreamResponse } from '../llm/adapter';
import { AgentRunContext } from './run-context';
import { runToolChatLoop } from './tool-chat-loop';

vi.mock('../llm/adapter', () => ({
  LLMAdapter: {
    streamWithTools: vi.fn(),
  },
}));

function createSender() {
  const events: Array<{ channel: string; data: unknown }> = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, data: unknown) => {
      events.push({ channel, data });
    },
  } as unknown as WebContents;
  return { sender, events };
}

function response(partial: Partial<ToolStreamResponse>): ToolStreamResponse {
  return {
    stopReason: 'end_turn',
    text: '',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 2, costCny: 0.01 },
    assistantTurn: { role: 'assistant', text: '', toolCalls: [] },
    ...partial,
  };
}

const echoTool: AgentTool<{ seen: string[] }, string> = {
  namespace: 'chat',
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  maxResultChars: 100,
  isReadOnly: false,
  permissions: {
    readOnly: false,
    canWriteFile: false,
    canMutateDag: false,
    canUseWeb: false,
    maxResultChars: 100,
  },
  execute: async (input, ctx) => {
    const text = String(input.text ?? '');
    ctx.seen.push(text);
    return text;
  },
  formatResult: (output) => output,
};

const missingTool: AgentTool<{ attempts: number }, { success: boolean; message: string }> = {
  namespace: 'chat',
  name: 'missing_file',
  description: 'Always reports a missing file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  maxResultChars: 200,
  isReadOnly: true,
  permissions: {
    readOnly: true,
    canWriteFile: false,
    canMutateDag: false,
    canUseWeb: false,
    maxResultChars: 200,
  },
  execute: async (_input, ctx) => {
    ctx.attempts += 1;
    return { success: false, message: 'not found' };
  },
  formatResult: (output) => output.message,
};

describe('runToolChatLoop', () => {
  beforeEach(() => {
    vi.mocked(LLMAdapter.streamWithTools).mockReset();
  });

  it('streams normal chat chunks and sends a terminal event', async () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools).mockImplementation(async (req: ToolStreamRequest) => {
      req.onChunk('hello');
      return response({
        text: 'hello',
        assistantTurn: { role: 'assistant', text: 'hello', toolCalls: [] },
      });
    });

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 2,
      maxTokens: 100,
    });

    expect(result.completed).toBe(true);
    expect(events).toEqual([
      { channel: IPC.LLM_STREAM_CHUNK, data: { sessionId: 's1', chunk: 'hello' } },
      {
        channel: IPC.LLM_STREAM_END,
        data: { sessionId: 's1', usage: { inputTokens: 1, outputTokens: 2, costCny: 0.01 } },
      },
    ]);
  });

  it('executes tool calls and feeds results into the next turn', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    const seen: string[] = [];

    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'from tool' } }],
        assistantTurn: {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'from tool' } }],
        },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'use tool' }],
      toolRegistry: createAgentToolRegistry([echoTool]),
      toolContext: { seen },
      runContext: context,
      maxTurns: 3,
      maxTokens: 100,
    });

    expect(seen).toEqual(['from tool']);
    expect(result.messages).toContainEqual({
      role: 'tool_results',
      results: [{ toolCallId: 'call1', content: 'from tool' }],
    });
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(2);
  });

  it('passes native attachments only to the first LLM turn', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });

    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'from tool' } }],
        assistantTurn: {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'from tool' } }],
        },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'inspect this image' }],
      toolRegistry: createAgentToolRegistry([echoTool]),
      toolContext: { seen: [] },
      runContext: context,
      maxTurns: 3,
      maxTokens: 100,
      imageAttachments: [{ name: 'chart.png', mediaType: 'image/png', base64: 'abc' }],
      pdfAttachments: [{ name: 'paper.pdf', base64: 'def' }],
    });

    const calls = vi.mocked(LLMAdapter.streamWithTools).mock.calls;
    expect(calls[0][0].imageAttachments).toEqual([{ name: 'chart.png', mediaType: 'image/png', base64: 'abc' }]);
    expect(calls[0][0].pdfAttachments).toEqual([{ name: 'paper.pdf', base64: 'def' }]);
    expect(calls[1][0].imageAttachments).toBeUndefined();
    expect(calls[1][0].pdfAttachments).toBeUndefined();
  });

  it('lets specialized workflows continue after max_tokens responses', async () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'max_tokens',
        assistantTurn: { role: 'assistant', text: 'partial', toolCalls: [] },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'write long file' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 3,
      maxTokens: 100,
      onMaxTokens: (_turn, _response, messages) => {
        messages.push({ role: 'user', content: 'continue' });
        return 'continue';
      },
    });

    expect(result.completed).toBe(true);
    expect(result.messages).toContainEqual({ role: 'user', content: 'continue' });
    expect(events.at(-1)).toEqual({
      channel: IPC.LLM_STREAM_END,
      data: { sessionId: 's1', usage: { inputTokens: 2, outputTokens: 4, costCny: 0.02 } },
    });
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(2);
  });

  it('auto-continues plain chat after max_tokens truncation', async () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'max_tokens',
        text: 'partial',
        assistantTurn: { role: 'assistant', text: 'partial', toolCalls: [] },
      }))
      .mockResolvedValueOnce(response({
        text: 'done',
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'write a long answer' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 1,
      maxTokens: 100,
      maxOutputContinuations: 2,
    });

    expect(result.completed).toBe(true);
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(2);
    const secondCallMessages = vi.mocked(LLMAdapter.streamWithTools).mock.calls[1][0].messages;
    expect(secondCallMessages).toContainEqual({ role: 'assistant', text: 'partial', toolCalls: [] });
    expect(secondCallMessages).toContainEqual({
      role: 'user',
      content: expect.stringContaining('继续'),
    });
    expect(events.some((event) =>
      event.channel === IPC.LLM_STREAM_CHUNK
      && typeof (event.data as { chunk?: unknown }).chunk === 'string'
      && ((event.data as { chunk: string }).chunk.includes('输出已截断')),
    )).toBe(true);
    expect(events.at(-1)).toEqual({
      channel: IPC.LLM_STREAM_END,
      data: { sessionId: 's1', usage: { inputTokens: 2, outputTokens: 4, costCny: 0.02 } },
    });
  });

  it('lets specialized workflows recover from LLM errors before failing the stream', async () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools)
      .mockRejectedValueOnce(new Error('context_length exceeded'))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'recovered', toolCalls: [] },
      }));

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 2,
      maxTokens: 100,
      onLlmError: (_err, _turn, messages) => {
        messages.push({ role: 'user', content: 'compressed retry' });
        return 'continue';
      },
    });

    expect(result.completed).toBe(true);
    expect(events.some((event) => event.channel === IPC.LLM_STREAM_ERROR)).toBe(false);
    expect(result.messages).toContainEqual({ role: 'user', content: 'compressed retry' });
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(2);
  });

  it('blocks repeated identical tool calls after two semantic failures', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    const toolCall = (id: string): ToolCallBlock => ({
      id,
      name: 'missing_file',
      input: { path: '纲要/_outline_v1.md' },
    });

    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [toolCall('call1')],
        assistantTurn: { role: 'assistant', text: '', toolCalls: [toolCall('call1')] },
      }))
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [toolCall('call2')],
        assistantTurn: { role: 'assistant', text: '', toolCalls: [toolCall('call2')] },
      }))
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [toolCall('call3')],
        assistantTurn: { role: 'assistant', text: '', toolCalls: [toolCall('call3')] },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    const toolContext = { attempts: 0 };
    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'read outline' }],
      toolRegistry: createAgentToolRegistry([missingTool]),
      toolContext,
      runContext: context,
      maxTurns: 4,
      maxTokens: 100,
    });

    expect(result.completed).toBe(true);
    expect(toolContext.attempts).toBe(2);
    expect(result.messages).toContainEqual({
      role: 'tool_results',
      results: [{
        toolCallId: 'call3',
        content: expect.stringContaining('重复失败'),
        isError: true,
      }],
    });
  });

  it('keeps working past end_turn while the completion gate reports open tasks', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'phase 1 done', toolCalls: [] },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'all done', toolCalls: [] },
      }));

    let gateCalls = 0;
    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'multi-step task' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 5,
      maxTokens: 100,
      shouldContinueAtEndTurn: () => {
        gateCalls += 1;
        return gateCalls === 1 ? { nudge: 'keep going' } : undefined;
      },
    });

    expect(result.completed).toBe(true);
    expect(gateCalls).toBe(2);
    expect(result.messages).toContainEqual({ role: 'user', content: 'keep going' });
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(2);
  });

  it('never exceeds hardMaxTurns even if the gate always wants to continue', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools).mockImplementation(async () =>
      response({ assistantTurn: { role: 'assistant', text: 'still working', toolCalls: [] } }),
    );

    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'endless task' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 2,
      hardMaxTurns: 3,
      maxTokens: 100,
      shouldContinueAtEndTurn: () => ({ nudge: 'go' }),
    });

    expect(result.completed).toBe(true);
    expect(vi.mocked(LLMAdapter.streamWithTools)).toHaveBeenCalledTimes(3);
  });

  it('fires onCheckpoint each turn so an interrupted run can be resumed', async () => {
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    vi.mocked(LLMAdapter.streamWithTools)
      .mockResolvedValueOnce(response({
        stopReason: 'tool_use',
        toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'x' } }],
        assistantTurn: { role: 'assistant', text: '', toolCalls: [{ id: 'call1', name: 'echo', input: { text: 'x' } }] },
      }))
      .mockResolvedValueOnce(response({
        assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
      }));

    const checkpoints: number[] = [];
    await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'do work' }],
      toolRegistry: createAgentToolRegistry([echoTool]),
      toolContext: { seen: [] },
      runContext: context,
      maxTurns: 3,
      maxTokens: 100,
      onCheckpoint: (turn) => { checkpoints.push(turn); },
    });

    // One checkpoint after the tool-use turn, one before the final end_turn finish.
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  });

  it('checkpoints partial assistant text when aborted mid-stream', async () => {
    const { sender } = createSender();
    const controller = new AbortController();
    const context = new AgentRunContext({ sessionId: 's1', sender, signal: controller.signal });
    vi.mocked(LLMAdapter.streamWithTools).mockImplementation(async (req: ToolStreamRequest) => {
      req.onChunk?.('partial ');
      req.onChunk?.('answer');
      controller.abort();
      throw new Error('aborted by user');
    });

    let checkpointCalls = 0;
    const result = await runToolChatLoop({
      provider: 'openai',
      model: 'test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'long task' }],
      toolRegistry: createAgentToolRegistry([]),
      toolContext: {},
      runContext: context,
      maxTurns: 3,
      maxTokens: 100,
      signal: controller.signal,
      onCheckpoint: () => { checkpointCalls += 1; },
    });

    expect(result.completed).toBe(false);
    expect(checkpointCalls).toBe(1);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', text: 'partial answer', toolCalls: [] });
  });
});
