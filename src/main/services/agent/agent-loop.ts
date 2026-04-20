import { LLMAdapter } from '../llm/adapter';
import { buildDagSearchResults } from '../web/source-strategy';
import type { LLMProvider, LLMMessage, TokenUsage } from '@shared/types';
import type {
  ImageAttachment, PdfAttachment,
  ToolTurnMessage, UserToolTurn, AssistantToolTurn,
} from '../llm/adapter';

// ── History compression ───────────────────────────────────────────────────────
// Shared utility used by both SubTutor and MainTutor to keep context windows lean.

const HISTORY_RAW_KEEP           = 16;
const HISTORY_COMPRESS_THRESHOLD = 20;

/** Truncate a single message that exceeds the snip threshold (8 000 chars). */
const SNIP_THRESHOLD = 8_000;
const SNIP_KEEP      = 3_000;

export function snipMessage(content: string): string {
  if (content.length <= SNIP_THRESHOLD) return content;
  return (
    content.slice(0, SNIP_KEEP) +
    `\n…[内容过长，已截断 ${content.length - SNIP_KEEP} 字符]…`
  );
}

/** Compress LLMMessage[] history (plain-text chat, used by AgentLoop / MainTutor). */
export function compressHistory(messages: LLMMessage[]): LLMMessage[] {
  // Snip pre-pass: truncate any oversized single message before counting
  const snipped = messages.map((m) => ({ ...m, content: snipMessage(m.content) }));

  if (snipped.length <= HISTORY_COMPRESS_THRESHOLD) return snipped;

  const cutoff = snipped.length - HISTORY_RAW_KEEP;
  const old    = snipped.slice(0, cutoff);
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

/**
 * Microcompact pass for tool-turn history (used by SubTutorLoop).
 * Preserves tool result turns so the model can reference what was already fetched.
 */
export function compressToolHistory(messages: ToolTurnMessage[]): ToolTurnMessage[] {
  if (messages.length <= HISTORY_COMPRESS_THRESHOLD) return messages;

  const cutoff = messages.length - HISTORY_RAW_KEEP;
  const old    = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  const oldTexts = old
    .filter((m): m is AssistantToolTurn => m.role === 'assistant')
    .map((m) => m.text.slice(0, 120).replace(/\n/g, ' '))
    .filter(Boolean)
    .join('；');

  const summary: UserToolTurn = {
    role:    'user',
    content: `[之前对话摘要] 助手之前处理：${oldTexts}。以下是最近的对话记录：`,
  };
  const ack: AssistantToolTurn = {
    role:      'assistant',
    text:      '好的，我已了解之前的处理历史，请继续当前任务。',
    toolCalls: [],
  };

  return [summary, ack, ...recent];
}

/**
 * Context Collapse — triggered at 90% budget.
 * Calls the LLM to summarise the full tool-turn history, then replaces it with a
 * two-message summary + the last 4 raw turns as immediate context.
 * Falls back to microcompact if the LLM call fails.
 */
const COLLAPSE_SYSTEM =
  `你是上下文压缩助手。将以下多轮对话历史压缩为一段简洁摘要（中文，400字以内），` +
  `保留关键事实：已执行的工具、生成的内容类型、重要决策。只输出摘要文本，不加任何标题或前言。`;

export async function collapseContext(
  messages: ToolTurnMessage[],
  opts: {
    provider: LLMProvider;
    model:    string;
    signal?:  AbortSignal;
    onProgress: (msg: string) => void;
  },
): Promise<ToolTurnMessage[]> {
  const historyText = messages
    .map((m) => {
      if (m.role === 'user')         return `用户：${m.content.slice(0, 300)}`;
      if (m.role === 'assistant')    return `助手：${m.text.slice(0, 300)}`;
      /* tool_results */             return `工具结果：${m.results.map((r) => r.content.slice(0, 100)).join('；')}`;
    })
    .join('\n');

  let summary = '';
  try {
    await LLMAdapter.stream({
      provider:    opts.provider,
      model:       opts.model,
      systemPrompt: COLLAPSE_SYSTEM,
      messages:    [{ role: 'user', content: historyText }],
      maxTokens:   512,
      temperature: 0.3,
      signal:      opts.signal,
      onChunk:     (c) => { summary += c; },
      onComplete:  () => { /* no-op */ },
      onError:     () => { /* fall through */ },
    });
  } catch {
    opts.onProgress('⚠️ 摘要生成失败，降级为微压缩\n');
    return compressToolHistory(messages);
  }

  if (!summary.trim()) return compressToolHistory(messages);

  const summaryTurn: UserToolTurn = {
    role:    'user',
    content: `[上下文摘要（原始历史已压缩）]\n${summary}`,
  };
  const ackTurn: AssistantToolTurn = {
    role:      'assistant',
    text:      '好的，我已了解之前的处理历史，请继续当前任务。',
    toolCalls: [],
  };

  // Keep the last 4 raw turns so the model has immediate context
  const rawTail = messages.slice(-4);
  return [summaryTurn, ackTurn, ...rawTail];
}

// ── Think decision ────────────────────────────────────────────────────────────

interface ThinkDecision {
  action: 'search' | 'answer';
  query?: string;
}

const THINK_SYSTEM_PROMPT = `你是学习助手的决策层。分析用户的问题，决定是否需要先搜索网络再回答。

只返回 JSON（不加任何代码块）：
- 需要搜索：{"action":"search","query":"精确搜索词（中英文均可）"}
- 直接回答：{"action":"answer"}

应搜索的情况：
- 用户询问 2024 年及以后的新技术、新版本（如 React 19、Next.js 15 等）
- 用户明确要求查找最新信息或官方文档链接
- 需要确认具体版本号、发布日期、API 变更等

应直接回答的情况：
- 基础概念解释、原理分析
- 代码调试和错误排查（用户提供了错误信息）
- 经典技术栈问题（SQL/HTTP/数据结构/算法等）
- 个人建议或方法论问题
- 话题历史悠久，训练数据已包含`;

// Heuristic: only run the think step when the message might actually need search.
// This avoids adding 2-3s of latency to every conversational message.
const MIGHT_NEED_SEARCH_RE =
  /最新|新版本|2024|2025|最近发布|now|latest|recent|current version|\d+\.\d+\.\d+/i;

// ── Loop request ──────────────────────────────────────────────────────────────

export interface LoopRequest {
  /** Conversation history (NOT including the current user message) */
  messages: LLMMessage[];
  userMessage: string;
  systemPrompt?: string;
  /** Forward to LLMAdapter — enables Anthropic prompt caching on the system block */
  cacheSystemPrompt?: boolean;
  /** Skip think step and always run a web search with the user message as query */
  forceWebSearch?: boolean;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  onChunk: (chunk: string) => void;
  onComplete: (usage: TokenUsage) => void;
  onError: (err: Error) => void;
}

// ── AgentLoop ─────────────────────────────────────────────────────────────────

/**
 * Agent Loop: think → (optional web search) → stream answer.
 *
 * Step-status prefixes (🤔/🔍/📄/✅) are emitted as stream chunks so the user
 * can watch the AI's reasoning in real time (plan section 2.3).
 *
 * The think step is skipped for routine questions to keep latency low.
 * Web search is only triggered when the think step decides it's needed.
 */
export class AgentLoop {
  async run(req: LoopRequest): Promise<void> {
    const { provider, model, messages, userMessage, signal, imageAttachments, pdfAttachments } = req;
    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };

    function addUsage(u: TokenUsage): void {
      accUsage.inputTokens  += u.inputTokens;
      accUsage.outputTokens += u.outputTokens;
      accUsage.costCny      += u.costCny;
    }

    // ── Step 1: Think (heuristic-gated) ───────────────────────────────────────
    // forceWebSearch skips the think step and goes directly to search using the
    // user message as the query (explicit user intent overrides heuristics).
    let decision: ThinkDecision = { action: 'answer' };

    if (req.forceWebSearch) {
      decision = { action: 'search', query: userMessage };
    } else if (MIGHT_NEED_SEARCH_RE.test(userMessage)) {
      req.onChunk('🤔 正在分析问题...\n');
      let thinkResponse = '';
      try {
        await LLMAdapter.stream({
          provider, model,
          systemPrompt: THINK_SYSTEM_PROMPT,
          messages: [...messages.slice(-6), { role: 'user', content: userMessage }],
          maxTokens: 120,
          temperature: 0.1,
          signal,
          onChunk: (c) => { thinkResponse += c; },
          onComplete: addUsage,
          onError: () => { /* default to answer */ },
        });
        const match = thinkResponse.match(/\{[\s\S]*\}/);
        if (match) decision = JSON.parse(match[0]) as ThinkDecision;
      } catch {
        // Think failed — proceed directly to answer
      }
    }

    // ── Step 2: Optional web search ───────────────────────────────────────────
    let extraContext = '';

    if (decision.action === 'search' && decision.query) {
      req.onChunk(`🔍 搜索：${decision.query}\n`);
      try {
        const { answer, results } = await buildDagSearchResults(decision.query, {
          provider: req.provider as string,
          model: req.model,
          signal: req.signal,
          maxResults: 4,
        });
        if (results.length > 0) {
          req.onChunk(`📄 获取到 ${results.length} 条参考资料\n`);
          const snippets = results
            .slice(0, 3)
            .map((r, i) =>
              `[${i + 1}] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 350)}`
            )
            .join('\n\n');
          extraContext = answer
            ? `[搜索摘要] ${answer}\n\n[详细来源]\n${snippets}`
            : `[网络搜索结果 - 查询: "${decision.query}"]\n\n${snippets}`;
        }
      } catch {
        // Search failed — continue without web results
      }
    }

    // ── Step 3: Stream final answer ───────────────────────────────────────────
    if (decision.action === 'search') {
      // Only show "整合信息" when a search step preceded this
      req.onChunk('✅ 整合信息中...\n\n');
    }

    const finalSystemPrompt = extraContext
      ? `${req.systemPrompt ?? ''}\n\n${extraContext}`.trim()
      : req.systemPrompt;

    await LLMAdapter.stream({
      provider, model,
      messages: [...messages, { role: 'user', content: userMessage }],
      systemPrompt: finalSystemPrompt,
      cacheSystemPrompt: extraContext ? false : req.cacheSystemPrompt,
      maxTokens: 2048,
      temperature: 0.7,
      signal,
      imageAttachments,
      pdfAttachments,
      onChunk: req.onChunk,
      onComplete: (u) => { addUsage(u); req.onComplete(accUsage); },
      onError: req.onError,
    });
  }
}
