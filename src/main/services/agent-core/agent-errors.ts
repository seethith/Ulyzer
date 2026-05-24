import { classifyError, errorDebugDetails } from '../llm/errors';

export type AgentErrorCode =
  | 'ABORTED'
  | 'LLM_FAILED'
  | 'NETWORK_ERROR'
  | 'TOOL_FAILED'
  | 'WORKFLOW_FAILED'
  | 'VALIDATION_FAILED'
  | 'CONTEXT_TOO_LONG'
  | 'RATE_LIMIT'
  | 'NODE_NOT_FOUND'
  | 'SAVE_FAILED';

export interface AgentErrorPayload {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentError';
  }

  toPayload(): AgentErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function abortError(message = '已取消'): AgentError {
  return new AgentError('ABORTED', message, false);
}

export function normalizeAgentError(
  error: unknown,
  fallbackCode: AgentErrorCode = 'WORKFLOW_FAILED',
  details?: Record<string, unknown>,
): AgentError {
  if (error instanceof AgentError) {
    if (!details) return error;
    return new AgentError(error.code, error.message, error.retryable, { ...error.details, ...details }, error.cause);
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const classified = classifyError(error);
  const inferred = inferErrorCode(rawMessage, classified.type, fallbackCode);
  const debugDetails = shouldIncludeDebugDetails(classified.type)
    ? compactDetails(errorDebugDetails(error))
    : {};
  const mergedDetails = compactDetails({ ...details, ...debugDetails });

  return new AgentError(
    inferred.code,
    inferred.message ?? classified.message,
    inferred.retryable ?? classified.retryable,
    Object.keys(mergedDetails).length > 0 ? mergedDetails : undefined,
    error,
  );
}

export function agentErrorPayload(
  error: unknown,
  fallbackCode: AgentErrorCode = 'WORKFLOW_FAILED',
  details?: Record<string, unknown>,
): AgentErrorPayload {
  return normalizeAgentError(error, fallbackCode, details).toPayload();
}

function inferErrorCode(
  rawMessage: string,
  llmType: ReturnType<typeof classifyError>['type'],
  fallbackCode: AgentErrorCode,
): { code: AgentErrorCode; message?: string; retryable?: boolean } {
  const msg = rawMessage.toLowerCase();
  if (llmType === 'abort' || msg.includes('aborted') || msg.includes('已取消')) {
    return { code: 'ABORTED', message: '已取消', retryable: false };
  }
  if (llmType === 'context_too_long') return { code: 'CONTEXT_TOO_LONG', retryable: true };
  if (llmType === 'rate_limit') return { code: 'RATE_LIMIT', retryable: true };
  if (llmType === 'network_error') return { code: 'NETWORK_ERROR', retryable: true };
  if (llmType === 'auth_error' || llmType === 'model_unavailable' || llmType === 'output_truncated') {
    return { code: 'LLM_FAILED', retryable: llmType === 'output_truncated' };
  }
  if (msg.includes('node not found') || msg.includes('节点不存在') || msg.includes('找不到节点')) {
    return { code: 'NODE_NOT_FOUND', message: rawMessage, retryable: false };
  }
  if (msg.includes('save') || msg.includes('保存') || msg.includes('写入')) {
    return { code: 'SAVE_FAILED', message: rawMessage, retryable: false };
  }
  if (msg.includes('validation') || msg.includes('invalid') || msg.includes('校验')) {
    return { code: 'VALIDATION_FAILED', message: rawMessage, retryable: false };
  }
  return { code: fallbackCode, message: rawMessage, retryable: false };
}

function shouldIncludeDebugDetails(llmType: ReturnType<typeof classifyError>['type']): boolean {
  return llmType === 'network_error';
}

function compactDetails(details: Record<string, unknown> | object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}
