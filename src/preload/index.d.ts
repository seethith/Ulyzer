import type { IpcChannel } from '../../shared/ipc-channels';

export interface ElectronAPI {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown>;
  on(channel: IpcChannel, callback: (...args: unknown[]) => void): void;
  off(channel: IpcChannel, callback: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    api: ElectronAPI;
    // Legacy field used by default template component (Versions.tsx)
    electron: {
      process: {
        versions: {
          electron: string;
          chrome: string;
          node: string;
        };
      };
    };
  }
}
