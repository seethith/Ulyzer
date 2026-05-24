import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  IpcResponse,
  StorageCleanupResult,
  StorageStats,
} from '@shared/types';
import {
  cleanupStorageOrphans,
  clearOcrCache,
  clearRuntimeCache,
  getStorageStats,
} from '../services/storage/storage-cleanup';

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function fail<T = never>(err: unknown): IpcResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerStorageHandlers(): void {
  ipcMain.handle(IPC.STORAGE_STATS, (): IpcResponse<StorageStats> => {
    try {
      return ok(getStorageStats());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.STORAGE_CLEANUP_ORPHANS, (): IpcResponse<StorageCleanupResult> => {
    try {
      return ok(cleanupStorageOrphans());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.STORAGE_CLEAR_OCR_CACHE, (): IpcResponse<StorageCleanupResult> => {
    try {
      return ok(clearOcrCache());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.STORAGE_CLEAR_RUNTIME_CACHE, (): IpcResponse<StorageCleanupResult> => {
    try {
      return ok(clearRuntimeCache());
    } catch (err) {
      return fail(err);
    }
  });
}
