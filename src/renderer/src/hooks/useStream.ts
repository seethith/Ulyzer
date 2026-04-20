import { useCallback, useRef, useState } from 'react';
import { IPC } from '@shared/ipc-channels';
import type { LLMStreamRequest, StreamChunkPayload, StreamEndPayload, StreamErrorPayload, TokenUsage } from '@shared/types';

interface UseStreamCallbacks {
  onChunk?: (chunk: string) => void;
  onComplete?: (usage: TokenUsage) => void;
  onError?: (error: string) => void;
}

export function useStream(callbacks?: UseStreamCallbacks) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [content, setContent] = useState('');
  const currentSessionRef = useRef<string | null>(null);

  // Hold stable callback refs so we can properly off() them
  const chunkListenerRef = useRef<((data: unknown) => void) | null>(null);
  const endListenerRef   = useRef<((data: unknown) => void) | null>(null);
  const errorListenerRef = useRef<((data: unknown) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (chunkListenerRef.current) {
      window.api.off(IPC.LLM_STREAM_CHUNK, chunkListenerRef.current);
      chunkListenerRef.current = null;
    }
    if (endListenerRef.current) {
      window.api.off(IPC.LLM_STREAM_END, endListenerRef.current);
      endListenerRef.current = null;
    }
    if (errorListenerRef.current) {
      window.api.off(IPC.LLM_STREAM_ERROR, errorListenerRef.current);
      errorListenerRef.current = null;
    }
  }, []);

  const startStream = useCallback(
    async (req: LLMStreamRequest): Promise<void> => {
      // Clean up any previous stream listeners
      cleanup();

      currentSessionRef.current = req.sessionId;
      setIsStreaming(true);
      setContent('');

      const onChunk = (data: unknown) => {
        const { sessionId, chunk } = data as StreamChunkPayload;
        if (sessionId !== currentSessionRef.current) return;
        setContent((prev) => prev + chunk);
        callbacks?.onChunk?.(chunk);
      };

      const onEnd = (data: unknown) => {
        const { sessionId, usage } = data as StreamEndPayload;
        if (sessionId !== currentSessionRef.current) return;
        setIsStreaming(false);
        callbacks?.onComplete?.(usage);
        cleanup();
      };

      const onError = (data: unknown) => {
        const { sessionId, error } = data as StreamErrorPayload;
        if (sessionId !== currentSessionRef.current) return;
        setIsStreaming(false);
        callbacks?.onError?.(error);
        cleanup();
      };

      chunkListenerRef.current  = onChunk;
      endListenerRef.current    = onEnd;
      errorListenerRef.current  = onError;

      window.api.on(IPC.LLM_STREAM_CHUNK, onChunk);
      window.api.on(IPC.LLM_STREAM_END,   onEnd);
      window.api.on(IPC.LLM_STREAM_ERROR, onError);

      await window.api.invoke(IPC.LLM_STREAM_START, req);
    },
    [callbacks, cleanup]
  );

  const abort = useCallback(() => {
    if (currentSessionRef.current) {
      window.api.invoke(IPC.LLM_ABORT, currentSessionRef.current).catch(() => {});
      setIsStreaming(false);
      cleanup();
    }
  }, [cleanup]);

  const reset = useCallback(() => {
    setContent('');
    setIsStreaming(false);
    currentSessionRef.current = null;
    cleanup();
  }, [cleanup]);

  return { startStream, abort, reset, isStreaming, content };
}
