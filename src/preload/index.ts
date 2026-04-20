import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { IpcChannel } from '../../shared/ipc-channels';

const ALLOWED_CHANNELS = new Set<string>(Object.values(IPC));

function assertAllowed(channel: string): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

// ── Single-listener fan-out multiplexer ────────────────────────────────────────
// ipcRenderer has a default max of 10 listeners per event. To avoid the
// MaxListenersExceededWarning we register exactly ONE ipcRenderer listener per
// channel and fan out to all renderer-side subscribers from a plain Set.

type Listener = (...args: unknown[]) => void;

const channelSubscribers = new Map<string, Set<Listener>>();

function ensureChannelListener(channel: string): void {
  if (channelSubscribers.has(channel)) return;

  const subscribers = new Set<Listener>();
  channelSubscribers.set(channel, subscribers);

  ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => {
    for (const cb of subscribers) {
      cb(...args);
    }
  });
}

const api = {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown> {
    assertAllowed(channel);
    return ipcRenderer.invoke(channel, ...args);
  },

  on(channel: IpcChannel, callback: Listener): void {
    assertAllowed(channel);
    ensureChannelListener(channel);
    channelSubscribers.get(channel)!.add(callback);
  },

  off(channel: IpcChannel, callback: Listener): void {
    assertAllowed(channel);
    channelSubscribers.get(channel)?.delete(callback);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (non-isolated context, dev only)
  window.api = api;
}
