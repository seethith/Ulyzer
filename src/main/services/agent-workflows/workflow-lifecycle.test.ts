import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import { AgentRunContext } from '../agent-core/run-context';
import { WorkflowLifecycle, WorkflowLifecycleError } from './workflow-lifecycle';

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

describe('WorkflowLifecycle', () => {
  it('uses standard phases and mirrors workflow events through the run context', () => {
    const { sender, events } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    const lifecycle = new WorkflowLifecycle({ workflowId: 'material.generate', context });

    lifecycle.start('prepare_context');
    lifecycle.complete('prepare_context');
    lifecycle.skip('retrieve_sources');
    lifecycle.addUsage({ inputTokens: 3, outputTokens: 4, costCny: 0.05 });
    lifecycle.progress('working');
    lifecycle.fileGenerated({
      filePath: '/tmp/material.md',
      folderName: 'theory',
      nodeId: 'node1',
    });

    expect(lifecycle.getPhaseStatus('prepare_context')).toBe('completed');
    expect(lifecycle.getPhaseStatus('retrieve_sources')).toBe('skipped');
    expect(context.usage).toEqual({ inputTokens: 3, outputTokens: 4, costCny: 0.05 });
    expect(events).toEqual([
      {
        channel: IPC.LLM_STREAM_CHUNK,
        data: { sessionId: 's1', chunk: 'working', isProgress: true },
      },
      {
        channel: IPC.FILE_GENERATED,
        data: {
          sessionId: 's1',
          filePath: '/tmp/material.md',
          folderName: 'theory',
          nodeId: 'node1',
          usage: { inputTokens: 3, outputTokens: 4, costCny: 0.05 },
        },
      },
    ]);
  });

  it('wraps failed phases in a standard workflow error', async () => {
    const lifecycle = new WorkflowLifecycle({ workflowId: 'topic.generate' });

    await expect(
      lifecycle.runPhase('generate_content', async () => {
        throw new Error('LLM failed');
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowLifecycleError',
      workflowId: 'topic.generate',
      phase: 'generate_content',
      message: 'LLM failed',
    } satisfies Partial<WorkflowLifecycleError>);

    expect(lifecycle.getPhaseStatus('generate_content')).toBe('failed');
  });
});
