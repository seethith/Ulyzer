import OpenAI from 'openai';
import { getApiKey } from '../../../utils/keychain';
import type { TokenUsage } from '@shared/types';
import type {
  ILLMProvider, LLMStreamOptions, ImageAttachment,
  ToolStreamRequest, ToolStreamResponse, ToolCallBlock, AssistantToolTurn,
} from '../adapter';

// CNY price per 1k tokens
const PRICE: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o':              { input: 0.036,    output: 0.108 },
  'gpt-4o-mini':         { input: 0.0108,   output: 0.0432 },
  // DeepSeek
  'deepseek-chat':       { input: 0.001,    output: 0.002 },
  'deepseek-reasoner':   { input: 0.004,    output: 0.016 },
  // Grok (xAI) — $3/$15 per 1M tokens × 7.2 CNY/USD ÷ 1000
  'grok-3':              { input: 0.0216,   output: 0.108 },
  'grok-3-mini':         { input: 0.00216,  output: 0.0036 },
  // Google Gemini — $1.25/$10 per 1M (Pro), $0.1/$0.4 (Flash) × 7.2
  'gemini-2.5-pro':      { input: 0.009,    output: 0.072 },
  'gemini-2.0-flash':    { input: 0.00072,  output: 0.00288 },
  // MiniMax — ¥0.1/¥1 per 1M (Text-01), ¥1/¥5 per 1M (M1)
  'MiniMax-Text-01':     { input: 0.0001,   output: 0.001 },
  'MiniMax-M1':          { input: 0.001,    output: 0.005 },
  // Qwen (Alibaba) — ¥0.3/¥0.6, ¥0.8/¥2, ¥4/¥12 per 1M
  'qwen-turbo':                    { input: 0.0003,   output: 0.0006 },
  'qwen-plus':                     { input: 0.0008,   output: 0.002 },
  'qwen-max':                      { input: 0.004,    output: 0.012 },
  // Mistral AI — $2/$6, $0.2/$0.6, $0.3/$0.9 per 1M × 7.2
  'mistral-large-latest':          { input: 0.0144,   output: 0.0432 },
  'mistral-small-latest':          { input: 0.00144,  output: 0.00432 },
  'codestral-latest':              { input: 0.00216,  output: 0.00648 },
  // Groq — $0.59/$0.79, $0.05/$0.08, $0.24/$0.24 per 1M × 7.2
  'llama-3.3-70b-versatile':       { input: 0.00425,  output: 0.00569 },
  'llama-3.1-8b-instant':          { input: 0.00036,  output: 0.000576 },
  'mixtral-8x7b-32768':            { input: 0.001728, output: 0.001728 },
  // Moonshot (Kimi) — ¥12/¥12, ¥24/¥24, ¥60/¥60 per 1M
  'moonshot-v1-8k':                { input: 0.012,    output: 0.012 },
  'moonshot-v1-32k':               { input: 0.024,    output: 0.024 },
  'moonshot-v1-128k':              { input: 0.06,     output: 0.06 },
  // Zhipu AI — ¥0.1/¥0.1, ¥0.001/¥0.001 per 1k
  'glm-4':                         { input: 0.1,      output: 0.1 },
  'glm-4-flash':                   { input: 0.001,    output: 0.001 },
  'glm-4-air':                     { input: 0.001,    output: 0.001 },
  // ByteDance Doubao — ¥0.0008/¥0.002, ¥0.0003/¥0.0006 per 1k
  'doubao-pro-32k':                { input: 0.0008,   output: 0.002 },
  'doubao-lite-32k':               { input: 0.0003,   output: 0.0006 },
  // Perplexity — $3/$15, $1/$1 per 1M × 7.2
  'sonar-pro':                     { input: 0.0216,   output: 0.108 },
  'sonar':                         { input: 0.0072,   output: 0.0072 },
  // Cohere — $2.5/$10, $0.15/$0.6 per 1M × 7.2
  'command-r-plus':                { input: 0.018,    output: 0.072 },
  'command-r':                     { input: 0.00108,  output: 0.00432 },
};
const DEFAULT_PRICE = { input: 0.036, output: 0.108 };

/**
 * OpenAI-compatible provider.
 * Pass baseURL + keychainKey to use DeepSeek or other compatible APIs.
 */
export class OpenAIProvider implements ILLMProvider {
  private baseURL: string | undefined;
  private keychainKey: string;

  pricePer1kTokens = DEFAULT_PRICE;

  constructor(baseURL?: string, keychainKey = 'openai') {
    this.baseURL = baseURL;
    this.keychainKey = keychainKey;
  }

  async stream(options: LLMStreamOptions): Promise<void> {
    const apiKey = await getApiKey(this.keychainKey);
    if (!apiKey) throw new Error(`${this.keychainKey} API Key 未设置，请在设置中配置`);

    const price = PRICE[options.model] ?? DEFAULT_PRICE;
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

    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await client.chat.completions.create({
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    for await (const chunk of stream) {
      if (options.signal?.aborted) break;

      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) options.onChunk(text);

      // Last chunk with usage
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    if (!options.signal?.aborted) {
      options.onComplete({
        inputTokens,
        outputTokens,
        costCny:
          (inputTokens / 1000) * price.input +
          (outputTokens / 1000) * price.output,
      });
    }
  }

  async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    const apiKey = await getApiKey(this.keychainKey);
    if (!apiKey) throw new Error(`${this.keychainKey} API Key 未设置，请在设置中配置`);

    const price = PRICE[req.model] ?? DEFAULT_PRICE;
    const client = new OpenAI({ apiKey, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });

    // Convert ToolTurnMessage[] → OpenAI messages
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });

    for (const m of req.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        if (m.toolCalls.length > 0) {
          messages.push({
            role:       'assistant',
            content:    m.text || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id:       tc.id,
              type:     'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          });
        } else {
          messages.push({ role: 'assistant', content: m.text });
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

    // Accumulate tool call deltas
    interface PartialTC { id: string; name: string; argsJson: string }
    const tcMap = new Map<number, PartialTC>();
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';

    const stream = await client.chat.completions.create({
      model:    req.model,
      messages,
      tools,
      tool_choice: 'auto',
      stream:   true,
      stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    });

    for await (const chunk of stream) {
      if (req.signal?.aborted) break;

      const delta = chunk.choices[0]?.delta;
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

      if (delta?.content) { content += delta.content; req.onChunk(delta.content); }

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
        inputTokens  = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      costCny: (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output,
    };

    if (finishReason === 'tool_calls' && tcMap.size > 0) {
      const toolCalls: ToolCallBlock[] = [...tcMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id:    tc.id,
          name:  tc.name,
          input: (() => { try { return JSON.parse(tc.argsJson) as Record<string, unknown>; } catch { return {}; } })(),
        }));

      const assistantTurn: AssistantToolTurn = { role: 'assistant', text: content, toolCalls };
      return { stopReason: 'tool_use', text: content, toolCalls, usage, assistantTurn };
    }

    const assistantTurn: AssistantToolTurn = { role: 'assistant', text: content, toolCalls: [] };

    if (finishReason === 'length') {
      return { stopReason: 'max_tokens', text: content, toolCalls: [], usage, assistantTurn };
    }

    return { stopReason: 'end_turn', text: content, toolCalls: [], usage, assistantTurn };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
