import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import { AgentRunContext } from './run-context';

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

describe('AgentRunContext', () => {
  it('streams progress and accumulates usage', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });

    context.progress('working');
    context.addUsage({ inputTokens: 10, outputTokens: 5, costCny: 0.1 });
    context.complete({ outputTokens: 2 });

    expect(events).toEqual([
      {
        channel: IPC.LLM_STREAM_CHUNK,
        data: { sessionId: 's1', chunk: 'working', isProgress: true },
      },
      {
        channel: IPC.LLM_STREAM_END,
        data: { sessionId: 's1', usage: { inputTokens: 10, outputTokens: 7, costCny: 0.1 } },
      },
    ]);
  });

  it('emits file and dag events with session usage', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    context.addUsage({ inputTokens: 3, outputTokens: 4, costCny: 0.05 });

    context.fileGenerated({
      filePath: '/tmp/a.md',
      folderName: 'theory',
      nodeId: 'node1',
    });
    context.dagGenerated({
      nodes: [],
      edges: [],
      summary: '',
    });

    expect(events[0]).toMatchObject({
      channel: IPC.FILE_GENERATED,
      data: { sessionId: 's1', usage: { inputTokens: 3, outputTokens: 4, costCny: 0.05 } },
    });
    expect(events[1]).toMatchObject({
      channel: IPC.DAG_GENERATED,
      data: { sessionId: 's1', usage: { inputTokens: 3, outputTokens: 4, costCny: 0.05 } },
    });
  });

  it('sends only one terminal event', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });

    context.complete();
    context.fail(new Error('late failure'));

    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe(IPC.LLM_STREAM_END);
  });

  it('emits standardized error payloads', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });

    context.fail(new Error('context_length exceeded'));

    expect(events).toEqual([
      {
        channel: IPC.LLM_STREAM_ERROR,
        data: {
          sessionId: 's1',
          error: '上下文过长，正在压缩…',
          code: 'CONTEXT_TOO_LONG',
          retryable: true,
        },
      },
    ]);
  });
});
