import { IPC } from '@shared/ipc-channels';
import type {
  AgentToolCallPayload,
  AgentToolResultPayload,
  DagGraph,
  FileGeneratedPayload,
  TokenUsage,
} from '@shared/types';
import type { AgentErrorCode } from './agent-errors';
import { agentErrorPayload } from './agent-errors';

export interface DagGeneratedPayload extends DagGraph {
  summary: string;
  usage: TokenUsage;
  sessionId: string;
}

export function streamChunkPayload(
  sessionId: string,
  chunk: string,
  options: { isProgress?: boolean; isThinking?: boolean } = {},
) {
  return {
    channel: IPC.LLM_STREAM_CHUNK,
    data: {
      sessionId,
      chunk,
      ...options,
    },
  };
}

export function streamEndPayload(sessionId: string, usage: TokenUsage) {
  return {
    channel: IPC.LLM_STREAM_END,
    data: { sessionId, usage },
  };
}

export function streamErrorPayload(
  sessionId: string,
  error: unknown,
  fallbackCode: AgentErrorCode = 'LLM_FAILED',
  details?: Record<string, unknown>,
) {
  const payload = agentErrorPayload(error, fallbackCode, details);
  return {
    channel: IPC.LLM_STREAM_ERROR,
    data: {
      sessionId,
      error: payload.message,
      code: payload.code,
      retryable: payload.retryable,
      ...(payload.details ? { details: payload.details } : {}),
    },
  };
}

export function toolCallPayload(
  sessionId: string,
  payload: Omit<AgentToolCallPayload, 'sessionId'>,
) {
  return {
    channel: IPC.LLM_TOOL_CALL,
    data: { ...payload, sessionId },
  };
}

export function toolResultPayload(
  sessionId: string,
  payload: Omit<AgentToolResultPayload, 'sessionId'>,
) {
  return {
    channel: IPC.LLM_TOOL_RESULT,
    data: { ...payload, sessionId },
  };
}

export function fileGeneratedPayload(
  sessionId: string,
  payload: Omit<FileGeneratedPayload, 'sessionId' | 'usage'> & { usage: TokenUsage },
) {
  return {
    channel: IPC.FILE_GENERATED,
    data: { ...payload, sessionId },
  };
}

export function dagGeneratedPayload(
  sessionId: string,
  payload: Omit<DagGeneratedPayload, 'sessionId'>,
) {
  return {
    channel: IPC.DAG_GENERATED,
    data: { ...payload, sessionId },
  };
}
