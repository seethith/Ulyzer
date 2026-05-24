import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  ChatAttachmentPrepareRequest,
  ChatAttachmentStatusRequest,
  FileAttachment,
  IpcResponse,
} from '@shared/types';
import {
  getPreparedChatAttachmentStatus,
  prepareChatAttachment,
  removePreparedChatAttachment,
} from '../services/attachments/chat-attachment-service';

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function fail<T = unknown>(err: unknown): IpcResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerChatAttachmentHandlers(): void {
  ipcMain.handle(
    IPC.CHAT_ATTACHMENT_PREPARE,
    async (_event, input: ChatAttachmentPrepareRequest): Promise<IpcResponse<FileAttachment>> => {
      try {
        return ok(await prepareChatAttachment(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.CHAT_ATTACHMENT_STATUS,
    (_event, input: ChatAttachmentStatusRequest): IpcResponse<FileAttachment> => {
      try {
        return ok(getPreparedChatAttachmentStatus(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.CHAT_ATTACHMENT_REMOVE,
    (_event, input: ChatAttachmentStatusRequest): IpcResponse<void> => {
      try {
        removePreparedChatAttachment(input);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
