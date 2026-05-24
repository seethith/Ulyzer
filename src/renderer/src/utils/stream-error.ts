import type { StreamErrorPayload } from '@shared/types';

function detailText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function formatStreamError(payload: StreamErrorPayload): string {
  const details = payload.details ?? {};
  const parts: string[] = [];
  if (payload.code) parts.push(`code=${payload.code}`);
  if (payload.retryable !== undefined) parts.push(`retryable=${payload.retryable ? 'yes' : 'no'}`);

  for (const key of ['agentType', 'provider', 'model', 'searchMode', 'status', 'errorName', 'errorCode', 'causeCode'] as const) {
    const text = detailText(details[key]);
    if (text) parts.push(`${key}=${text}`);
  }

  const rawMessage = detailText(details.rawMessage);
  if (rawMessage && rawMessage !== payload.error) parts.push(`raw=${rawMessage}`);

  return parts.length > 0
    ? `${payload.error}\n${parts.join(' · ')}`
    : payload.error;
}
