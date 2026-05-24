import OpenAI from 'openai';
import { getApiKey } from '../../../utils/keychain';
import type { TokenUsage } from '@shared/types';
import type {
  ILLMProvider, LLMStreamOptions, ImageAttachment,
  ToolStreamRequest, ToolStreamResponse, ToolCallBlock, AssistantToolTurn,
} from '../adapter';
import { calculateUsageCostCny, getModelPrice, DEFAULT_PRICE } from '../pricing';
import { getCapability, type ThinkingStyle } from '../model-capabilities';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Translate effort budget to discrete reasoning_effort level.
 * Used by Grok-mini and OpenAI o-series.
 */
function budgetToEffort(budget: number): 'low' | 'medium' | 'high' {
  if (budget > 4096) return 'high';
  if (budget > 1024) return 'medium';
  return 'low';
}

/**
 * Build extra request fields for thinking / reasoning per provider style.
 * Returns:
 *   - extras   : fields to merge into the OpenAI create() body (sent as-is to upstream)
 *   - skipTemp : whether temperature must be omitted (some reasoning models reject it)
 */
function buildThinkingExtras(
  provider: string,
  model: string,
  thinkingBudget: number | undefined,
): { extras: Record<string, unknown>; skipTemp: boolean } {
  if (!thinkingBudget || thinkingBudget <= 0) return { extras: {}, skipTemp: false };

  const cap = getCapability(provider, model);
  const style: ThinkingStyle = cap.thinkingStyle;

  switch (style) {
    case 'extra-qwen':
      // Qwen3 via DashScope OpenAI-compat: enable_thinking + thinking_budget
      return {
        extras: { enable_thinking: true, thinking_budget: thinkingBudget },
        skipTemp: false,
      };
    case 'extra-gemini':
      // Gemini 2.5 via OpenAI-compat endpoint
      return {
        extras: { extra_body: { thinking: { budget_tokens: thinkingBudget } } },
        skipTemp: false,
      };
    case 'extra-grok':
      // Grok-3-mini: reasoning_effort 'low' | 'high' (no 'medium' upstream — map medium→high)
      return {
        extras: { reasoning_effort: budgetToEffort(thinkingBudget) === 'low' ? 'low' : 'high' },
        skipTemp: false,
      };
    case 'openai-effort':
      // OpenAI o-series: reasoning_effort, temperature unsupported
      return {
        extras: { reasoning_effort: budgetToEffort(thinkingBudget) },
        skipTemp: true,
      };
    case 'reasoner-model':
      // DeepSeek R1 etc: thinking enabled by model selection alone, no extra params,
      // and temperature is ignored upstream — drop it to match documented behaviour.
      return { extras: {}, skipTemp: true };
    default:
      return { extras: {}, skipTemp: false };
  }
}

/** Read the non-standard `reasoning_content` field from a streaming delta. */
function readReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const v = (delta as { reasoning_content?: unknown }).reasoning_content;
  return typeof v === 'string' ? v : '';
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseOpenAIUsage(raw: unknown): Omit<TokenUsage, 'costCny'> {
  if (!raw || typeof raw !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const usage = raw as Record<string, unknown>;
  const promptDetails: Record<string, unknown> = objectField(usage, 'prompt_tokens_details')
    ?? objectField(usage, 'input_tokens_details')
    ?? {};
  const inputTokens = numberField(usage, 'prompt_tokens') || numberField(usage, 'input_tokens');
  const outputTokens = numberField(usage, 'completion_tokens') || numberField(usage, 'output_tokens');
  const inputCacheHitTokens =
    numberField(usage, 'prompt_cache_hit_tokens') ||
    numberField(usage, 'input_cache_hit_tokens') ||
    numberField(promptDetails, 'cached_tokens') ||
    numberField(promptDetails, 'cache_read_tokens');
  const explicitCacheMiss =
    numberField(usage, 'prompt_cache_miss_tokens') ||
    numberField(usage, 'input_cache_miss_tokens') ||
    numberField(promptDetails, 'cache_miss_tokens');
  const inputCacheMissTokens = explicitCacheMiss > 0
    ? explicitCacheMiss
    : inputCacheHitTokens > 0 && inputTokens > 0
      ? Math.max(inputTokens - inputCacheHitTokens, 0)
      : 0;
  const normalizedInputTokens = inputTokens || inputCacheHitTokens + inputCacheMissTokens;

  return {
    inputTokens: normalizedInputTokens,
    outputTokens,
    ...(inputCacheHitTokens > 0 ? { inputCacheHitTokens } : {}),
    ...(inputCacheMissTokens > 0 ? { inputCacheMissTokens } : {}),
  };
}

function usageWithCost(raw: unknown, price: ReturnType<typeof getModelPrice>): TokenUsage {
  const usage = parseOpenAIUsage(raw);
  return {
    ...usage,
    costCny: calculateUsageCostCny(usage, price),
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * OpenAI-compatible provider.
 * Pass baseURL + keychainKey to use DeepSeek or other compatible APIs.
 */
export class OpenAIProvider implements ILLMProvider {
  private baseURL: string | undefined;
  private keychainKey: string;

  pricePer1kTokens = DEFAULT_PRICE;

  constructor(baseURL?: string, keychainKey = 'openai', private readonly providerId = keychainKey) {
    this.baseURL = baseURL;
    this.keychainKey = keychainKey;
  }

  async stream(options: LLMStreamOptions): Promise<void> {
    const apiKey = await getApiKey(this.keychainKey);
    if (!apiKey) throw new Error(`${this.keychainKey} API Key 未设置，请在设置中配置`);

    const price = getModelPrice(this.providerId, options.model);
    const client = new OpenAI({
      apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });

    // Merge system prompt into messages array
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const sysContent =
      options.systemPrompt ??
      options.messages.find((m) => m.role === 'system')?.content;
    if (sysContent) messages.push({ role: 'system', content: sysContent });

    const images: ImageAttachment[] = options.imageAttachments ?? [];
    const userMsgs = options.messages.filter((m) => m.role !== 'system');
    messages.push(
      ...userMsgs.map((m, i) => {
        const isLast = i === userMsgs.length - 1;
        if (isLast && m.role === 'user' && images.length > 0) {
          return {
            role: 'user' as const,
            content: [
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
              })),
              { type: 'text' as const, text: m.content },
            ],
          };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      })
    );

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    let finishReason = 'stop';

    const { extras, skipTemp } = buildThinkingExtras(this.providerId, options.model, options.thinkingBudget);

    const params: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(!skipTemp && options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...extras,
    };

    try {
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: options.signal },
      );

      for await (const chunk of stream) {
        if (options.signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        const text = delta?.content ?? '';
        if (text) options.onChunk(text);

        const reasoning = readReasoningDelta(delta);
        if (reasoning) options.onThinkingChunk?.(reasoning);

        // Last chunk with usage
        if (chunk.usage) {
          usage = usageWithCost(chunk.usage, price);
        }
      }
    } catch (err) {
      // With the abort signal wired into the SDK, a user cancel surfaces as a
      // thrown error; swallow it (matching the Claude provider's silent stop) so
      // only genuine errors propagate to the caller.
      if (!options.signal?.aborted) throw err;
    }

    if (!options.signal?.aborted) {
      options.onStop?.(finishReason === 'length' ? 'max_tokens' : 'end_turn');
      options.onComplete(usage);
    }
  }

  async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    const apiKey = await getApiKey(this.keychainKey);
    if (!apiKey) throw new Error(`${this.keychainKey} API Key 未设置，请在设置中配置`);

    const price = getModelPrice(this.providerId, req.model);
    const client = new OpenAI({ apiKey, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });

    // Convert ToolTurnMessage[] → OpenAI messages
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });

    const images: ImageAttachment[] = req.imageAttachments ?? [];
    const lastUserIndex = images.length > 0
      ? req.messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1)
      : -1;

    for (const [index, m] of req.messages.entries()) {
      if (m.role === 'user') {
        if (index === lastUserIndex) {
          messages.push({
            role: 'user',
            content: [
              ...images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
              })),
              { type: 'text' as const, text: m.content },
            ],
          });
          continue;
        }
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        if (m.toolCalls.length > 0) {
          const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam & { reasoning_content?: string } = {
            role:       'assistant',
            content:    m.text || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id:       tc.id,
              type:     'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          };
          if (m._reasoningContent) assistantMessage.reasoning_content = m._reasoningContent;
          messages.push(assistantMessage);
        } else {
          const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam & { reasoning_content?: string } = {
            role: 'assistant',
            content: m.text,
          };
          if (m._reasoningContent) assistantMessage.reasoning_content = m._reasoningContent;
          messages.push(assistantMessage);
        }
      } else {
        // tool_results → one 'tool' message per result
        for (const r of m.results) {
          messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        }
      }
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] = req.tools.map((t) => ({
      type:     'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const hasTools = tools.length > 0;

    // Accumulate tool call deltas
    interface PartialTC { id: string; name: string; argsJson: string }
    const tcMap = new Map<number, PartialTC>();
    let content = '';
    let reasoningContent = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    let finishReason = 'stop';

    const { extras, skipTemp: _skipTemp } = buildThinkingExtras(this.providerId, req.model, req.thinkingBudget);

    const params: Record<string, unknown> = {
      model:    req.model,
      messages,
      ...(hasTools ? { tools, tool_choice: 'auto' } : {}),
      stream:   true,
      stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...extras,
    };

    try {
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: req.signal },
      );

      for await (const chunk of stream) {
        if (req.signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

        if (delta?.content) { content += delta.content; req.onChunk(delta.content); }

        const reasoning = readReasoningDelta(delta);
        if (reasoning) {
          reasoningContent += reasoning;
          req.onThinkingChunk?.(reasoning);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const cur = tcMap.get(tc.index) ?? { id: '', name: '', argsJson: '' };
            if (tc.id)                cur.id       = tc.id;
            if (tc.function?.name)    cur.name    += tc.function.name;
            if (tc.function?.arguments) cur.argsJson += tc.function.arguments;
            tcMap.set(tc.index, cur);
          }
        }

        if (chunk.usage) {
          usage = usageWithCost(chunk.usage, price);
        }
      }
    } catch (err) {
      // User cancel surfaces as a thrown abort error once the signal is wired into
      // the SDK; swallow it and fall through to return whatever was accumulated, so
      // only genuine errors propagate.
      if (!req.signal?.aborted) throw err;
    }

    if (finishReason === 'tool_calls' && tcMap.size > 0) {
      const toolCalls: ToolCallBlock[] = [...tcMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id:    tc.id,
          name:  tc.name,
          input: (() => { try { return JSON.parse(tc.argsJson) as Record<string, unknown>; } catch { return {}; } })(),
        }));

      const assistantTurn: AssistantToolTurn = {
        role: 'assistant',
        text: content,
        toolCalls,
        ...(reasoningContent ? { _reasoningContent: reasoningContent } : {}),
      };
      return { stopReason: 'tool_use', text: content, toolCalls, usage, assistantTurn };
    }

    const assistantTurn: AssistantToolTurn = {
      role: 'assistant',
      text: content,
      toolCalls: [],
      ...(reasoningContent ? { _reasoningContent: reasoningContent } : {}),
    };

    if (finishReason === 'length') {
      return { stopReason: 'max_tokens', text: content, toolCalls: [], usage, assistantTurn };
    }

    return { stopReason: 'end_turn', text: content, toolCalls: [], usage, assistantTurn };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
