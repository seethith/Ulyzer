// ── LLM error classification and retry utilities ──────────────────────────────

export type LLMErrorType =
  | 'rate_limit'        // 触发指数退避重试
  | 'context_too_long'  // 触发上下文压缩
  | 'auth_error'        // API Key 无效，不可重试
  | 'tool_execution'    // 工具执行失败，返回给模型重试
  | 'model_unavailable' // 模型不可用
  | 'output_truncated'  // 输出被截断
  | 'abort'             // 用户主动取消
  | 'unknown';

export interface ClassifiedError {
  type: LLMErrorType;
  message: string;
  retryable: boolean;
  raw: unknown;
}

export function classifyError(err: unknown): ClassifiedError {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();

  if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('too many requests'))
    return { type: 'rate_limit', message: '请求过于频繁，正在重试…', retryable: true, raw: err };

  if (
    msg.includes('context_length') ||
    msg.includes('too long') ||
    msg.includes('prompt_too_long') ||
    msg.includes('context window')
  )
    return { type: 'context_too_long', message: '上下文过长，正在压缩…', retryable: true, raw: err };

  if (
    msg.includes('401') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication') ||
    msg.includes('api key')
  )
    return { type: 'auth_error', message: '请在设置中检查 API Key', retryable: false, raw: err };

  if (
    msg.includes('model') &&
    (msg.includes('unavailable') || msg.includes('not found') || msg.includes('overloaded'))
  )
    return { type: 'model_unavailable', message: '当前模型不可用，请稍后重试', retryable: false, raw: err };

  if (msg.includes('abort') || msg.includes('cancel'))
    return { type: 'abort', message: '已取消', retryable: false, raw: err };

  if (msg.includes('max_tokens') || msg.includes('output truncated'))
    return { type: 'output_truncated', message: '输出被截断', retryable: true, raw: err };

  return {
    type: 'unknown',
    message: String(err instanceof Error ? err.message : err),
    retryable: false,
    raw: err,
  };
}

/**
 * Exponential backoff with jitter — standard retry delay pattern.
 * @param attempt       0-indexed attempt number
 * @param retryAfterMs  use server-sent Retry-After value when available
 */
export async function exponentialBackoff(attempt: number, retryAfterMs?: number): Promise<void> {
  const delay =
    retryAfterMs != null
      ? retryAfterMs
      : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30_000);
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
