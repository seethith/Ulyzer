import { describe, it, expect } from 'vitest';
import { classifyError, exponentialBackoff } from './errors';

describe('classifyError', () => {
  it('classifies rate limit errors', () => {
    expect(classifyError(new Error('rate_limit exceeded')).type).toBe('rate_limit');
    expect(classifyError(new Error('429 Too Many Requests')).type).toBe('rate_limit');
    expect(classifyError(new Error('too many requests')).type).toBe('rate_limit');
  });

  it('classifies context_too_long errors', () => {
    expect(classifyError(new Error('context_length exceeded')).type).toBe('context_too_long');
    expect(classifyError(new Error('prompt_too_long')).type).toBe('context_too_long');
    expect(classifyError(new Error('context window full')).type).toBe('context_too_long');
  });

  it('classifies auth errors', () => {
    expect(classifyError(new Error('401 Unauthorized')).type).toBe('auth_error');
    expect(classifyError(new Error('invalid_api_key')).type).toBe('auth_error');
  });

  it('classifies model unavailable errors', () => {
    expect(classifyError(new Error('model not found')).type).toBe('model_unavailable');
    expect(classifyError(new Error('model overloaded')).type).toBe('model_unavailable');
  });

  it('classifies abort errors', () => {
    expect(classifyError(new Error('AbortError: abort')).type).toBe('abort');
    expect(classifyError(new Error('request cancelled')).type).toBe('abort');
  });

  it('classifies network/API connection errors', () => {
    expect(classifyError(new Error('Connection error.')).type).toBe('network_error');
    expect(classifyError(new Error('fetch failed')).type).toBe('network_error');
    expect(classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).type).toBe('network_error');
    expect(classifyError(Object.assign(new Error('APIConnectionError'), { name: 'APIConnectionError' })).retryable).toBe(true);
  });

  it('classifies unknown errors', () => {
    const result = classifyError(new Error('some random failure'));
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.message).toBe('some random failure');
  });

  it('marks rate_limit and context_too_long as retryable', () => {
    expect(classifyError(new Error('rate_limit')).retryable).toBe(true);
    expect(classifyError(new Error('context_length')).retryable).toBe(true);
    expect(classifyError(new Error('Connection error.')).retryable).toBe(true);
  });

  it('marks auth and model errors as non-retryable', () => {
    expect(classifyError(new Error('invalid_api_key')).retryable).toBe(false);
    expect(classifyError(new Error('model unavailable')).retryable).toBe(false);
  });

  it('accepts non-Error values', () => {
    const result = classifyError('string error');
    expect(result.type).toBe('unknown');
    expect(result.message).toBe('string error');
  });
});

describe('exponentialBackoff', () => {
  it('respects explicit retryAfterMs', async () => {
    const start = Date.now();
    await exponentialBackoff(0, 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(18); // allow small jitter
  });

  it('completes without throwing', async () => {
    await expect(exponentialBackoff(0, 1)).resolves.toBeUndefined();
  });
});
