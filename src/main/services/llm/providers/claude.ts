import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from '../../../utils/keychain';
import type {
  ILLMProvider, LLMStreamOptions, ImageAttachment, PdfAttachment,
  ToolStreamRequest, ToolStreamResponse, ToolTurnMessage, ToolCallBlock, AssistantToolTurn,
} from '../adapter';
import type { TokenUsage } from '@shared/types';

// CNY price per 1k tokens (input / output)
const PRICE: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':          { input: 0.021,  output: 0.105 },
  'claude-opus-4-6':            { input: 0.105,  output: 0.525 },
  'claude-sonnet-4-5-20251001': { input: 0.021,  output: 0.105 },
  'claude-opus-4-5-20251001':   { input: 0.105,  output: 0.525 },
  'claude-haiku-4-5-20251001':  { input: 0.0055, output: 0.0275 },
};
const DEFAULT_PRICE = PRICE['claude-sonnet-4-6'];

export class ClaudeProvider implements ILLMProvider {
  pricePer1kTokens = DEFAULT_PRICE;

  async stream(options: LLMStreamOptions): Promise<void> {
    const apiKey = await getApiKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API Key 未设置，请在设置中配置');

    const price = PRICE[options.model] ?? DEFAULT_PRICE;
    const client = new Anthropic({ apiKey });

    // Separate system prompt from messages
    const systemContent =
      options.systemPrompt ??
      options.messages.find((m) => m.role === 'system')?.content ??
      '';
    const userMessages = options.messages.filter((m) => m.role !== 'system');

    // Build messages, attaching images/PDFs to the last user message if provided
    const images: ImageAttachment[] = options.imageAttachments ?? [];
    const pdfs: PdfAttachment[] = options.pdfAttachments ?? [];
    const apiMessages: Anthropic.MessageParam[] = userMessages.map((m, i) => {
      const isLast = i === userMessages.length - 1;
      if (isLast && m.role === 'user' && (images.length > 0 || pdfs.length > 0)) {
        return {
          role: 'user' as const,
          content: [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: img.base64,
              },
            })),
            ...pdfs.map((pdf) => ({
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/pdf' as const,
                data: pdf.base64,
              },
            })),
            { type: 'text' as const, text: m.content },
          ],
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });

    const systemParam: Anthropic.TextBlockParam[] | string | undefined = systemContent
      ? options.cacheSystemPrompt
        ? [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' as const } }]
        : systemContent
      : undefined;

    const msgStream = client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      messages: apiMessages,
    });

    options.signal?.addEventListener('abort', () => { msgStream.abort(); });

    msgStream.on('text', (text) => {
      if (!options.signal?.aborted) options.onChunk(text);
    });

    try {
      const final = await msgStream.finalMessage();
      if (!options.signal?.aborted) {
        const u = final.usage as Anthropic.Usage & {
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const cacheRead  = u.cache_read_input_tokens ?? 0;
        const regularIn  = u.input_tokens;
        const usage: TokenUsage = {
          inputTokens: regularIn + cacheWrite + cacheRead,
          outputTokens: u.output_tokens,
          costCny:
            (regularIn  / 1000) * price.input +
            (cacheWrite / 1000) * price.input * 1.25 +
            (cacheRead  / 1000) * price.input * 0.1 +
            (u.output_tokens / 1000) * price.output,
        };
        options.onComplete(usage);
      }
    } catch (err) {
      if (!options.signal?.aborted) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    const apiKey = await getApiKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API Key 未设置，请在设置中配置');

    const price = PRICE[req.model] ?? DEFAULT_PRICE;
    const client = new Anthropic({ apiKey });

    // Convert provider-neutral ToolTurnMessage[] → Anthropic.MessageParam[]
    const apiMessages: Anthropic.MessageParam[] = req.messages.map((m: ToolTurnMessage) => {
      if (m.role === 'user') {
        return { role: 'user', content: m.content };
      }
      if (m.role === 'assistant') {
        // Prefer stored native content (ensures verbatim replay for Anthropic)
        if (m._nativeContent) {
          return { role: 'assistant', content: m._nativeContent as Anthropic.ContentBlock[] };
        }
        if (m.toolCalls.length > 0) {
          const blocks: Anthropic.ContentBlock[] = [];
          if (m.text) blocks.push({ type: 'text', text: m.text } as unknown as Anthropic.ContentBlock);
          blocks.push(...m.toolCalls.map((tc) => ({
            type:  'tool_use' as const,
            id:    tc.id,
            name:  tc.name,
            input: tc.input,
          } as unknown as Anthropic.ContentBlock)));
          return { role: 'assistant', content: blocks };
        }
        return { role: 'assistant', content: m.text };
      }
      // tool_results → Anthropic user message with tool_result blocks
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type:        'tool_result' as const,
          tool_use_id: r.toolCallId,
          content:     r.content,
          is_error:    r.isError ?? false,
        })),
      };
    });

    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const stream = client.messages.stream({
      model:      req.model,
      max_tokens: req.maxTokens ?? 8192,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      tools,
      messages: apiMessages,
    });

    req.signal?.addEventListener('abort', () => { stream.abort(); }, { once: true });
    stream.on('text', (text) => { if (!req.signal?.aborted) req.onChunk(text); });

    const final = await stream.finalMessage();

    // Compute usage (same cache-aware accounting as stream())
    const u = final.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead  = u.cache_read_input_tokens ?? 0;
    const regularIn  = u.input_tokens;
    const usage: TokenUsage = {
      inputTokens:  regularIn + cacheWrite + cacheRead,
      outputTokens: u.output_tokens,
      costCny:
        (regularIn   / 1000) * price.input +
        (cacheWrite  / 1000) * price.input * 1.25 +
        (cacheRead   / 1000) * price.input * 0.1 +
        (u.output_tokens / 1000) * price.output,
    };

    const textParts = (final.content as Anthropic.ContentBlock[])
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (final.stop_reason === 'tool_use') {
      const toolCalls: ToolCallBlock[] = (final.content as Anthropic.ContentBlock[])
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

      const assistantTurn: AssistantToolTurn = {
        role:           'assistant',
        text:           textParts,
        toolCalls,
        _nativeContent: final.content,
      };
      return { stopReason: 'tool_use', text: textParts, toolCalls, usage, assistantTurn };
    }

    const assistantTurn: AssistantToolTurn = {
      role:           'assistant',
      text:           textParts,
      toolCalls:      [],
      _nativeContent: final.content,
    };

    if (final.stop_reason === 'max_tokens') {
      return { stopReason: 'max_tokens', text: textParts, toolCalls: [], usage, assistantTurn };
    }

    // end_turn (default)
    return { stopReason: 'end_turn', text: textParts, toolCalls: [], usage, assistantTurn };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
