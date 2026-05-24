import type { WebContents } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { AgentType, ChatRunEvent } from '@shared/types';

export type InternalChatRunEvent =
  | {
      type: 'run.started';
      runId: string;
      sessionId: string;
      agentType: AgentType;
      courseId: string;
      nodeId?: string;
      threadId?: string;
    }
  | {
      type: 'run.completed' | 'run.interrupted' | 'run.failed' | 'run.aborted';
      runId: string;
      sessionId: string;
      error?: string;
    };

export function emitChatRunEvent(sender: WebContents, event: ChatRunEvent | InternalChatRunEvent): void {
  try {
    if (!sender.isDestroyed()) sender.send(IPC.CHAT_RUN_EVENT, event);
  } catch {
    // Window closed while a background run was unwinding.
  }
}
