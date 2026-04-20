import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { LLMStreamRequest, IpcResponse, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../services/llm/adapter';
import { getApiKey, setApiKey, deleteApiKey } from '../utils/keychain';
import { registerAbort, unregisterAbort } from '../services/abort-registry';

function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch {
    // window may have closed during streaming
  }
}

export function registerLlmHandlers(): void {
  // ── Start stream ────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.LLM_STREAM_START,
    async (event, req: LLMStreamRequest): Promise<IpcResponse<void>> => {
      const { sessionId } = req;

      // Cancel any existing stream for this session
      const controller = new AbortController();
      registerAbort(sessionId, controller);

      // Fire-and-forget — chunks arrive via sender.send
      LLMAdapter.stream({
        provider: req.provider,
        model: req.model,
        messages: req.messages,
        systemPrompt: req.systemPrompt,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        signal: controller.signal,

        onChunk: (chunk: string) => {
          safeSend(event.sender, IPC.LLM_STREAM_CHUNK, { sessionId, chunk });
        },

        onComplete: (usage: TokenUsage) => {
          unregisterAbort(sessionId);
          safeSend(event.sender, IPC.LLM_STREAM_END, { sessionId, usage });
        },

        onError: (err: Error) => {
          unregisterAbort(sessionId);
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, { sessionId, error: err.message });
        },
      }).catch((err: unknown) => {
        unregisterAbort(sessionId);
        safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return { success: true };
    }
  );

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
