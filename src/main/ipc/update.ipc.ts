import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse, UpdateCheckOptions, UpdateCheckResult } from '@shared/types';
import { checkForUpdate } from '../services/update/update-checker';

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function fail<T = never>(err: unknown): IpcResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(
    IPC.UPDATE_CHECK,
    async (_e, options?: UpdateCheckOptions): Promise<IpcResponse<UpdateCheckResult>> => {
      try {
        return ok(await checkForUpdate(options));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
