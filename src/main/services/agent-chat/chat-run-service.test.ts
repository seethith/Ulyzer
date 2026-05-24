import { describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import type { AgentChatRequest } from '@shared/types';
import { ChatRunService } from './chat-run-service';

function fakeEvent() {
  const sent: Array<{ channel: string; data: unknown }> = [];
  return {
    sent,
    event: {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => {
          sent.push({ channel, data });
        },
      },
    } as Electron.IpcMainInvokeEvent,
  };
}

function baseReq(overrides: Partial<AgentChatRequest> = {}): AgentChatRequest {
  return {
    agentType: 'main_tutor',
    courseId: 'course-1',
    sessionId: 'session-1',
    provider: 'test-provider',
    model: 'test-model',
    userMessage: '帮我生成一条学习路线',
    searchMode: 'auto',
    ...overrides,
  };
}

describe('ChatRunService', () => {
  it('dispatches the chat turn with action "chat" — no intent classifier, full tool set', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { event, sent } = fakeEvent();
    const service = new ChatRunService({
      orchestrator: { dispatch },
      selectedModelAvailable: async () => true,
      registerAbort: vi.fn(),
      unregisterAbort: vi.fn(),
      routeChatAttachments: async ({ baseMessage }) => ({
        userMessage: `${baseMessage}\n\nrouted`,
        imageAttachments: [],
        pdfAttachments: [],
      }),
    });

    const res = await service.handleAgentChat(event, baseReq({
      attachments: [{ id: 'a1', name: 'note.txt', mimeType: 'text/plain', size: 12, content: 'x' }],
    }));

    expect(res.success).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      type: 'main_tutor',
      action: 'chat',
      searchMode: 'auto',
      userMessage: '帮我生成一条学习路线\n\nrouted',
    });
    expect(sent.some((item) => item.channel === IPC.CHAT_RUN_EVENT && (item.data as { type?: string }).type === 'run.started')).toBe(true);
  });

  it('fails fast (run.failed) when the model is unavailable', async () => {
    const dispatch = vi.fn();
    const { event, sent } = fakeEvent();
    const service = new ChatRunService({
      orchestrator: { dispatch },
      selectedModelAvailable: async () => false,
      registerAbort: vi.fn(),
      unregisterAbort: vi.fn(),
    });

    await service.handleAgentChat(event, baseReq());

    expect(dispatch).not.toHaveBeenCalled();
    expect(sent.some((item) => item.channel === IPC.CHAT_RUN_EVENT && (item.data as { type?: string }).type === 'run.failed')).toBe(true);
  });
});
