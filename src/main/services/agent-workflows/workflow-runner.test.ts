import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../agent-core/orchestrator';
import { AgentRunContext } from '../agent-core/run-context';
import { defaultWorkflows, WorkflowRunner } from './workflow-runner';
import type { WorkflowDefinition, WorkflowId } from './workflow-types';

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

function createRequest(sender: WebContents): AgentRequest {
  return {
    action: 'chat',
    sessionId: 's1',
    courseId: 'course1',
    userMessage: 'original topic',
    provider: 'openai',
    model: 'gpt-test',
    senderEvent: { sender },
  } as unknown as AgentRequest;
}

describe('WorkflowRunner', () => {
  it('registers the default workflow modules', () => {
    expect(defaultWorkflows.map((workflow) => workflow.id).sort()).toEqual([
      'material.generate',
      'outline.generateNext',
      'route.generate',
      'topic.generate',
    ]);
  });

  it('can run an injected workflow registry', async () => {
    const workflow: WorkflowDefinition<'route.generate'> = {
      id: 'route.generate',
      run: async (input) => ({
        nodeCount: input.topic === 'custom' ? 1 : 0,
        chapterNames: [],
        profileText: '',
        accUsage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
      }),
    };
    const runner = new WorkflowRunner([workflow]);
    const { sender } = createSender();

    const result = await runner.run('route.generate', {
      req: createRequest(sender),
      sender,
      topic: 'custom',
      generate: async () => {
        throw new Error('not used by injected workflow');
      },
    });

    expect(result.nodeCount).toBe(1);
  });

  it('passes route generation through the typed workflow boundary', async () => {
    const runner = new WorkflowRunner();
    const { sender } = createSender();
    const context = new AgentRunContext({ sessionId: 's1', sender });
    const req = createRequest(sender);

    const result = await runner.run('route.generate', {
      req,
      sender,
      topic: 'new topic',
      generate: async (runReq, runSender, topicOverride, runContext, lifecycle) => {
        expect(runReq.userMessage).toBe('new topic');
        expect(runSender).toBe(sender);
        expect(topicOverride).toBe('new topic');
        expect(runContext).toBe(context);
        expect(lifecycle?.workflowId).toBe('route.generate');
        return {
          nodeCount: 2,
          chapterNames: ['chapter'],
          profileText: '',
          accUsage: { inputTokens: 1, outputTokens: 2, costCny: 0.01 },
        };
      },
    }, { context });

    expect(result.nodeCount).toBe(2);
  });

  it('rejects unknown workflow ids', async () => {
    const runner = new WorkflowRunner();

    await expect(
      runner.run('unknown.workflow' as WorkflowId, {} as never),
    ).rejects.toThrow('Unknown workflow: unknown.workflow');
  });
});
