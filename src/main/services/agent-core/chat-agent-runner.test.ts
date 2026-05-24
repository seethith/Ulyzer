import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentToolRegistry } from '../agent-tools/registry';
import { LLMAdapter } from '../llm/adapter';
import type { ToolStreamRequest, ToolStreamResponse } from '../llm/adapter';
import type { AgentRequest } from './orchestrator';
import { AgentRunContext } from './run-context';
import { runChatAgent } from './chat-agent-runner';

vi.mock('../llm/adapter', () => ({
  LLMAdapter: {
    streamWithTools: vi.fn(),
  },
}));

function createSender() {
  const sender = {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
  return sender;
}

function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    type: 'sub_tutor',
    action: 'chat',
    courseId: 'course-1',
    nodeId: 'node-1',
    sessionId: 'session-1',
    provider: 'openai',
    model: 'gpt-test',
    userMessage: 'hello',
    messages: [],
    senderEvent: { sender: createSender() },
    ...overrides,
  } as AgentRequest;
}

function response(partial: Partial<ToolStreamResponse> = {}): ToolStreamResponse {
  return {
    stopReason: 'end_turn',
    text: 'done',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 2, costCny: 0.01 },
    assistantTurn: { role: 'assistant', text: 'done', toolCalls: [] },
    ...partial,
  };
}

describe('runChatAgent', () => {
  beforeEach(() => {
    vi.mocked(LLMAdapter.streamWithTools).mockReset();
  });

  it('builds a unified chat loop with initial context, history, and current user message', async () => {
    let capturedRequest: ToolStreamRequest | undefined;
    vi.mocked(LLMAdapter.streamWithTools).mockImplementation(async (req) => {
      capturedRequest = { ...req, messages: [...req.messages] };
      return response();
    });
    const sender = createSender();
    const req = createRequest({
      senderEvent: { sender } as unknown as AgentRequest['senderEvent'],
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ],
    });

    await runChatAgent({
      req,
      runContext: new AgentRunContext({ sessionId: req.sessionId, sender }),
      commandContext: { courseId: req.courseId, nodeId: req.nodeId },
      buildRunSpec: () => ({
        systemPrompt: 'system',
        initialMessages: [
          { role: 'user', content: 'context' },
          { role: 'assistant', text: 'ready', toolCalls: [] },
        ],
        toolRegistry: createAgentToolRegistry([]),
        toolContext: {},
        loopConfig: { maxTurns: 2, hardMaxTurns: 4, maxTokens: 100 },
      }),
    });

    expect(capturedRequest?.messages).toEqual([
      { role: 'user', content: 'context' },
      { role: 'assistant', text: 'ready', toolCalls: [] },
      { role: 'user', content: 'old question' },
      { role: 'assistant', text: 'old answer', toolCalls: [] },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('expands prompt slash commands before building the run spec', async () => {
    vi.mocked(LLMAdapter.streamWithTools).mockResolvedValue(response());
    const sender = createSender();
    const req = createRequest({
      senderEvent: { sender } as unknown as AgentRequest['senderEvent'],
      userMessage: '/summary closures',
    });
    let messageSeenByBuilder = '';

    await runChatAgent({
      req,
      runContext: new AgentRunContext({ sessionId: req.sessionId, sender }),
      commandContext: { courseId: req.courseId, nodeId: req.nodeId },
      buildRunSpec: (runReq) => {
        messageSeenByBuilder = runReq.userMessage;
        return {
          systemPrompt: 'system',
          initialMessages: [],
          toolRegistry: createAgentToolRegistry([]),
          toolContext: {},
          loopConfig: { maxTurns: 2, hardMaxTurns: 4, maxTokens: 100 },
        };
      },
    });

    expect(messageSeenByBuilder).toContain('请用 3-5 句话总结');
    expect(messageSeenByBuilder).toContain('closures');
  });

  it('passes the selected thinking mode as a provider thinking budget', async () => {
    let capturedRequest: ToolStreamRequest | undefined;
    vi.mocked(LLMAdapter.streamWithTools).mockImplementation(async (req) => {
      capturedRequest = req;
      return response();
    });
    const sender = createSender();
    const req = createRequest({
      senderEvent: { sender } as unknown as AgentRequest['senderEvent'],
      model: 'o1',
      thinkingMode: 'high',
    });

    await runChatAgent({
      req,
      runContext: new AgentRunContext({ sessionId: req.sessionId, sender }),
      commandContext: { courseId: req.courseId, nodeId: req.nodeId },
      buildRunSpec: () => ({
        systemPrompt: 'system',
        initialMessages: [],
        toolRegistry: createAgentToolRegistry([]),
        toolContext: {},
        loopConfig: { maxTurns: 2, hardMaxTurns: 4, maxTokens: 100 },
      }),
    });

    expect(capturedRequest?.thinkingBudget).toBe(8192);
  });
});
