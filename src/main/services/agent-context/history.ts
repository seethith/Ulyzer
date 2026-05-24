import type { LLMMessage, LLMProvider, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import type { AssistantToolTurn, ToolTurnMessage, UserToolTurn } from '../llm/adapter';
import { localMsg, message } from '../agent-i18n/messages';

const HISTORY_RAW_KEEP = 16;
const HISTORY_COMPRESS_THRESHOLD = 20;

const SNIP_THRESHOLD = 8_000;
const SNIP_KEEP = 3_000;

export function snipMessage(content: string): string {
  if (content.length <= SNIP_THRESHOLD) return content;
  return (
    content.slice(0, SNIP_KEEP) +
    `\n…[内容过长，已截断 ${content.length - SNIP_KEEP} 字符]…`
  );
}

/** Compress plain-text chat history while preserving the newest raw turns. */
export function compressHistory(messages: LLMMessage[]): LLMMessage[] {
  const snipped = messages.map((m) => ({ ...m, content: snipMessage(m.content) }));

  if (snipped.length <= HISTORY_COMPRESS_THRESHOLD) return snipped;

  const cutoff = snipped.length - HISTORY_RAW_KEEP;
  const old = snipped.slice(0, cutoff);
  const recent = snipped.slice(cutoff);

  const oldUserTexts = old
    .filter((m) => m.role === 'user')
    .map((m) => m.content.slice(0, 120).replace(/\n/g, ' '))
    .join('；');

  const summary: LLMMessage = {
    role: 'user',
    content: `[之前对话摘要] 学员在这次对话中曾提问：${oldUserTexts}。以下是最近的对话记录：`,
  };
  const ack: LLMMessage = {
    role: 'assistant',
    content: '好的，我已了解之前的对话背景，请继续。',
  };

  return [summary, ack, ...recent];
}

/** Microcompact pass for tool-turn history used by tool-enabled workflows. */
export function compressToolHistory(messages: ToolTurnMessage[], language?: string): ToolTurnMessage[] {
  if (messages.length <= HISTORY_COMPRESS_THRESHOLD) return messages;

  const cutoff = messages.length - HISTORY_RAW_KEEP;
  const old = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  const oldTexts = old
    .filter((m): m is AssistantToolTurn => m.role === 'assistant')
    .map((m) => m.text.slice(0, 120).replace(/\n/g, ' '))
    .filter(Boolean)
    .join('；');

  const summary: UserToolTurn = {
    role: 'user',
    content: localMsg(
      language,
      `[之前对话摘要] 助手之前处理：${oldTexts}。以下是最近的对话记录：`,
      `[Previous conversation summary] The assistant previously handled: ${oldTexts}. Recent conversation follows:`,
    ),
  };
  const ack: AssistantToolTurn = {
    role: 'assistant',
    text: localMsg(
      language,
      '好的，我已了解之前的处理历史，请继续当前任务。',
      'Understood. I have the previous handling history; please continue the current task.',
    ),
    toolCalls: [],
  };

  return [summary, ack, ...recent];
}

function collapseSystemPrompt(language?: string): string {
  return localMsg(
    language,
    `你是上下文压缩助手。将以下多轮对话历史压缩为一段简洁摘要（中文，400字以内），` +
      `保留关键事实：已执行的工具、生成的内容类型、重要决策。只输出摘要文本，不加任何标题或前言。`,
    `You are a context compression assistant. Compress the following multi-turn conversation into a concise English summary under 400 words. ` +
      `Preserve key facts: tools used, generated content types, and important decisions. Output only the summary text with no title or preface.`,
  );
}

export async function collapseContext(
  messages: ToolTurnMessage[],
  opts: {
    provider: LLMProvider;
    model: string;
    signal?: AbortSignal;
    language?: string;
    onProgress: (msg: string) => void;
    onUsage?: (usage: TokenUsage) => void;
  },
): Promise<ToolTurnMessage[]> {
  const historyText = messages
    .map((m) => {
      if (m.role === 'user') {
        return localMsg(opts.language, `用户：${m.content.slice(0, 300)}`, `User: ${m.content.slice(0, 300)}`);
      }
      if (m.role === 'assistant') {
        return localMsg(opts.language, `助手：${m.text.slice(0, 300)}`, `Assistant: ${m.text.slice(0, 300)}`);
      }
      const results = m.results.map((r) => r.content.slice(0, 100)).join(localMsg(opts.language, '；', '; '));
      return localMsg(opts.language, `工具结果：${results}`, `Tool results: ${results}`);
    })
    .join('\n');

  let summary = '';
  try {
    await LLMAdapter.stream({
      provider: opts.provider,
      model: opts.model,
      systemPrompt: collapseSystemPrompt(opts.language),
      messages: [{ role: 'user', content: historyText }],
      maxTokens: 512,
      temperature: 0.3,
      signal: opts.signal,
      onChunk: (c) => { summary += c; },
      onComplete: (usage) => { opts.onUsage?.(usage); },
      onError: () => { /* fall through */ },
    });
  } catch {
    opts.onProgress(message('summaryGenerationFailedMicrocompact', opts.language));
    return compressToolHistory(messages, opts.language);
  }

  if (!summary.trim()) return compressToolHistory(messages, opts.language);

  const summaryTurn: UserToolTurn = {
    role: 'user',
    content: localMsg(
      opts.language,
      `[上下文摘要（原始历史已压缩）]\n${summary}`,
      `[Context summary (original history has been compressed)]\n${summary}`,
    ),
  };
  const ackTurn: AssistantToolTurn = {
    role: 'assistant',
    text: localMsg(
      opts.language,
      '好的，我已了解之前的处理历史，请继续当前任务。',
      'Understood. I have the previous handling history; please continue the current task.',
    ),
    toolCalls: [],
  };

  return [summaryTurn, ackTurn, ...messages.slice(-4)];
}
