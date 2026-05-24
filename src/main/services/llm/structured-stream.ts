import type { LLMMessage, LLMProvider, TokenUsage } from '@shared/types';
import { localMsg, message as i18nMessage } from '../agent-i18n/messages';
import { LLMAdapter, type LLMUsageContext, type ToolStopReason } from './adapter';

export type StructuredContinuationKind = 'json' | 'text';

export interface StructuredStreamInput {
  provider: LLMProvider;
  model: string;
  systemPrompt?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  kind: StructuredContinuationKind;
  language?: string;
  usageContext?: LLMUsageContext;
  signal?: AbortSignal;
  maxContinuations?: number;
  onProgress?: (message: string) => void;
  onThinkingChunk?: (chunk: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface StructuredStreamResult {
  text: string;
  stopReason: ToolStopReason;
  continuationCount: number;
  hitContinuationLimit: boolean;
}

const CONTINUATION_TAIL_CHARS = 16_000;

function continuationPrompt(kind: StructuredContinuationKind, language?: string): string {
  if (kind === 'json') {
    return localMsg(
      language,
      '上一段 JSON 输出因为长度上限被截断。请只输出从上一段最后一个字符之后开始的缺失 JSON 后缀。不要重头输出，不要重复已有内容，不要 Markdown、代码块或解释。如果你判断 JSON 已经完整，请输出空字符串。',
      'The previous JSON output was truncated by the token limit. Output only the missing JSON suffix beginning immediately after the previous final character. Do not restart, do not repeat existing content, and do not use Markdown, code fences, or explanations. If the JSON is already complete, output an empty string.',
    );
  }
  return localMsg(
    language,
    '上一段输出因为长度上限被截断。请从上一段最后一个字符之后继续写，只输出缺失后续内容，不要重复已有内容。',
    'The previous output was truncated by the token limit. Continue immediately after the previous final character and output only the missing continuation. Do not repeat existing content.',
  );
}

function tailForContinuation(text: string): string {
  return text.length > CONTINUATION_TAIL_CHARS
    ? text.slice(-CONTINUATION_TAIL_CHARS)
    : text;
}

function appendWithOverlap(base: string, suffix: string): string {
  if (!suffix) return base;
  const max = Math.min(base.length, suffix.length, 4_000);
  for (let size = max; size > 0; size--) {
    if (base.endsWith(suffix.slice(0, size))) {
      return base + suffix.slice(size);
    }
  }
  return base + suffix;
}

export async function streamStructuredCompletion(input: StructuredStreamInput): Promise<StructuredStreamResult> {
  const maxContinuations = Math.max(0, input.maxContinuations ?? 3);
  let text = '';
  let stopReason: ToolStopReason = 'end_turn';
  let continuationCount = 0;
  let currentMessages = input.messages;

  while (true) {
    let turnText = '';
    const turnState: { stopReason: ToolStopReason } = { stopReason: 'end_turn' };
    let streamError: Error | null = null;

    await LLMAdapter.stream({
      provider: input.provider,
      model: input.model,
      systemPrompt: input.systemPrompt,
      messages: currentMessages,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      jsonMode: continuationCount === 0 ? input.jsonMode : false,
      usageContext: input.usageContext,
      signal: input.signal,
      onChunk: (chunk) => { turnText += chunk; },
      onThinkingChunk: input.onThinkingChunk,
      onStop: (reason) => { turnState.stopReason = reason; },
      onComplete: (usage) => { input.onUsage?.(usage); },
      onError: (err) => { streamError = err; },
    });

    if (streamError) throw streamError;
    text = appendWithOverlap(text, turnText);
    stopReason = turnState.stopReason;

    if (turnState.stopReason !== 'max_tokens') {
      return { text, stopReason, continuationCount, hitContinuationLimit: false };
    }

    if (continuationCount >= maxContinuations) {
      input.onProgress?.(i18nMessage('outputContinuationLimit', input.language));
      return { text, stopReason, continuationCount, hitContinuationLimit: true };
    }

    continuationCount += 1;
    input.onProgress?.(i18nMessage('outputContinuation', input.language, {
      attempt: continuationCount,
      max: maxContinuations,
    }));
    currentMessages = [
      ...input.messages,
      { role: 'assistant', content: tailForContinuation(text) },
      { role: 'user', content: continuationPrompt(input.kind, input.language) },
    ];
  }
}
