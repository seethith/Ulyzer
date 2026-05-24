import type { IpcChannel } from '../../shared/ipc-channels';

export interface ElectronAPI {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown>;
  startFileDrag?(filePaths: string[]): void;
  on(channel: IpcChannel, callback: (...args: unknown[]) => void): void;
  off(channel: IpcChannel, callback: (...args: unknown[]) => void): void;
  getPathForFile?(file: File): string;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
