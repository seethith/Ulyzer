import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';
import { getApiKey, setApiKey, deleteApiKey } from '../utils/keychain';

export function registerLlmHandlers(): void {
  // ── API Key management (Keychain) ───────────────────────────────────────────

  ipcMain.handle(
    IPC.SETTINGS_GET_KEY,
    async (_event, provider: string): Promise<IpcResponse<string | null>> => {
      try {
        const key = await getApiKey(provider);
        return { success: true, data: key };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.SETTINGS_SAVE_KEY,
    async (_event, provider: string, key: string): Promise<IpcResponse<void>> => {
      try {
        if (key) {
          await setApiKey(provider, key);
        } else {
          await deleteApiKey(provider);
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.SETTINGS_DELETE_KEY,
    async (_event, provider: string): Promise<IpcResponse<void>> => {
      try {
        await deleteApiKey(provider);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
