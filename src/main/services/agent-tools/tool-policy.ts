import type { AgentTool } from './types';
import { message, normalizeLanguage } from '../agent-i18n/messages';

export const DEFAULT_MAX_RESULT_CHARS = 4000;

export function truncateToolResult(text: string, maxChars = DEFAULT_MAX_RESULT_CHARS, language?: string): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}${message('toolResultTruncated', language)}${text.slice(-half)}`;
}

export function isReadOnlyTool(tool: AgentTool | undefined): boolean {
  return tool?.permissions.readOnly === true;
}

export function formatToolStart(language: string | undefined, name: string): string {
  return message('toolStart', language, { name });
}

export function formatUnknownTool(language: string | undefined, name: string, available: string[]): string {
  return message('unknownTool', language, {
    name,
    available: available.join(normalizeLanguage(language) === 'en' ? ', ' : '、'),
  });
}

export function formatToolFailure(language: string | undefined, error: string): string {
  return message('toolFailure', language, { error });
}

export function formatToolFailureProgress(language: string | undefined, error: string): string {
  return message('toolFailureProgress', language, { error });
}
