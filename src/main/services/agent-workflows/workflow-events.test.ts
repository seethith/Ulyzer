import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import { AgentRunContext } from '../agent-core/run-context';
import { wrapFileGenerated, wrapProgress, wrapUsage } from './workflow-events';

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

describe('workflow event wrappers', () => {
  it('mirrors progress, usage, and file events into the active run context', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 'session-1', sender });
    const originalProgress = vi.fn();
    const originalUsage = vi.fn();
    const originalFileGenerated = vi.fn();

    wrapProgress(originalProgress, { context })('正在生成资料');
    wrapUsage(originalUsage, { context })({ inputTokens: 3, outputTokens: 5, costCny: 0.2 });
    wrapFileGenerated(originalFileGenerated, { context })({
      sessionId: 'session-1',
      filePath: '/tmp/material.md',
      folderName: 'theory',
      nodeId: 'node-1',
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
    });

    expect(originalProgress).toHaveBeenCalledWith('正在生成资料');
    expect(originalUsage).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 5, costCny: 0.2 });
    expect(originalFileGenerated).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/material.md',
      folderName: 'theory',
    }));
    expect(events).toEqual([
      {
        channel: IPC.LLM_STREAM_CHUNK,
        data: { sessionId: 'session-1', chunk: '正在生成资料', isProgress: true },
      },
      {
        channel: IPC.FILE_GENERATED,
        data: {
          sessionId: 'session-1',
          filePath: '/tmp/material.md',
          folderName: 'theory',
          nodeId: 'node-1',
          usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
        },
      },
    ]);
    expect(context.usage).toEqual({ inputTokens: 3, outputTokens: 5, costCny: 0.2 });
  });
});
