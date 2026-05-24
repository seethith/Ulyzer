import { describe, expect, it } from 'vitest';
import { abortError, agentErrorPayload, normalizeAgentError } from './agent-errors';

describe('agent error normalization', () => {
  it('classifies aborts without turning them into generic failures', () => {
    const error = normalizeAgentError(abortError());

    expect(error.code).toBe('ABORTED');
    expect(error.message).toBe('已取消');
    expect(error.retryable).toBe(false);
  });

  it('maps common LLM errors to stable codes', () => {
    expect(agentErrorPayload(new Error('429 rate_limit exceeded'), 'LLM_FAILED')).toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
    });
    expect(agentErrorPayload(new Error('context_length exceeded'), 'LLM_FAILED')).toMatchObject({
      code: 'CONTEXT_TOO_LONG',
      retryable: true,
    });
    expect(agentErrorPayload(new Error('Connection error.'), 'LLM_FAILED')).toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: expect.stringContaining('模型 API 连接失败'),
    });
  });

  it('preserves explicit fallback codes and details for workflow errors', () => {
    expect(agentErrorPayload(new Error('bad save'), 'SAVE_FAILED', { phase: 'persist_artifacts' }))
      .toEqual({
        code: 'SAVE_FAILED',
        message: 'bad save',
        retryable: false,
        details: { phase: 'persist_artifacts' },
      });
  });
});
