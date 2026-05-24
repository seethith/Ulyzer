import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from '../../../utils/keychain';
import type {
  ILLMProvider, LLMStreamOptions, ImageAttachment, PdfAttachment,
  ToolStreamRequest, ToolStreamResponse, ToolTurnMessage, ToolCallBlock, AssistantToolTurn,
} from '../adapter';
import type { TokenUsage } from '@shared/types';
import { getModelPrice, MODEL_PRICES } from '../pricing';
import { getCapability } from '../model-capabilities';

const DEFAULT_PRICE = MODEL_PRICES['claude-sonnet-4-6'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a cacheable system param (array form with cache_control) when caching is requested. */
function buildSystemParam(
  systemContent: string,
  cache: boolean,
): Anthropic.TextBlockParam[] | string | undefined {
  if (!systemContent) return undefined;
  if (!cache) return systemContent;
  return [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }];
}

/**
 * Resolve thinking config + safe max_tokens.
 *
 * Constraints (per Anthropic):
 *   - budget_tokens minimum 1024
 *   - max_tokens must exceed budget_tokens (we ensure ≥ budget + 1024 headroom)
 *   - temperature must NOT be set when thinking is enabled
 */
function resolveThinking(
  model: string,
  requestedBudget: number | undefined,
  requestedMaxTokens: number | undefined,
): {
  thinking: Anthropic.ThinkingConfigParam | undefined;
  maxTokens: number;
  allowTemperature: boolean;
} {
  const cap = getCapability('anthropic', model);
  const defaultMax = Math.min(16_000, cap.maxOutputTokens);
  const baseMax = Math.min(requestedMaxTokens ?? defaultMax, cap.maxOutputTokens);

  if (
    cap.thinkingStyle !== 'anthropic' ||
    !requestedBudget ||
    requestedBudget <= 0
  ) {
    return { thinking: undefined, maxTokens: baseMax, allowTemperature: true };
  }

  const budget = Math.max(1024, requestedBudget);
  // max_tokens must exceed thinking budget; give the final answer at least 1024 tokens of headroom
  const maxTokens = Math.min(Math.max(baseMax, budget + 1024), cap.maxOutputTokens);
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    maxTokens,
    allowTemperature: false,
  };
}

/** Add cache_control to the last tool definition so tool schemas are cached too. */
function buildToolsWithCache(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral' } } as Anthropic.Tool)
      : t,
  );
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class ClaudeProvider implements ILLMProvider {
  pricePer1kTokens = DEFAULT_PRICE;

  async stream(options: LLMStreamOptions): Promise<void> {
    const apiKey = await getApiKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API Key 未设置，请在设置中配置');

    const price = getModelPrice('anthropic', options.model);
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

    const systemParam = buildSystemParam(systemContent, options.cacheSystemPrompt ?? false);
    const { thinking, maxTokens, allowTemperature } = resolveThinking(
      options.model,
      options.thinkingBudget,
      options.maxTokens,
    );

    const msgStream = client.messages.stream({
      model: options.model,
      max_tokens: maxTokens,
      ...(allowTemperature && options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      ...(thinking ? { thinking } : {}),
      messages: apiMessages,
    });

    options.signal?.addEventListener('abort', () => { msgStream.abort(); });

    msgStream.on('text', (text) => {
      if (!options.signal?.aborted) options.onChunk(text);
    });
    msgStream.on('thinking', (thinkingDelta) => {
      if (!options.signal?.aborted) options.onThinkingChunk?.(thinkingDelta);
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
        options.onStop?.(final.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn');
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

    const price = getModelPrice('anthropic', req.model);
    const client = new Anthropic({ apiKey });

    const images: ImageAttachment[] = req.imageAttachments ?? [];
    const pdfs: PdfAttachment[] = req.pdfAttachments ?? [];
    const lastUserIndex = images.length > 0 || pdfs.length > 0
      ? req.messages.reduce((last, message, index) => message.role === 'user' ? index : last, -1)
      : -1;

    // Convert provider-neutral ToolTurnMessage[] → Anthropic.MessageParam[]
    const apiMessages: Anthropic.MessageParam[] = req.messages.map((m: ToolTurnMessage, index) => {
      if (m.role === 'user') {
        if (index === lastUserIndex) {
          return {
            role: 'user',
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
        return { role: 'user', content: m.content };
      }
      if (m.role === 'assistant') {
        // Prefer stored native content (ensures verbatim replay for Anthropic — required when
        // the previous turn contained thinking blocks, which must be replayed signature-intact)
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

    const tools: Anthropic.Tool[] = buildToolsWithCache(
      req.tools.map((t) => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      })),
    );

    // System prompt is always cached in the tool loop — the same prompt is replayed on every
    // turn, so caching saves ~90% of system-prompt token cost across multi-turn conversations.
    const systemParam = buildSystemParam(req.systemPrompt ?? '', true);
    const { thinking, maxTokens, allowTemperature: _ } = resolveThinking(
      req.model,
      req.thinkingBudget,
      req.maxTokens,
    );

    const stream = client.messages.stream({
      model:      req.model,
      max_tokens: maxTokens,
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      ...(thinking ? { thinking } : {}),
      tools,
      messages: apiMessages,
    });

    req.signal?.addEventListener('abort', () => { stream.abort(); }, { once: true });
    stream.on('text', (text) => { if (!req.signal?.aborted) req.onChunk(text); });
    stream.on('thinking', (thinkingDelta) => {
      if (!req.signal?.aborted) req.onThinkingChunk?.(thinkingDelta);
    });

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

    // Extract text only — thinking/redacted_thinking blocks stay in _nativeContent for replay
    // but must NOT be concatenated into the user-visible text response.
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
