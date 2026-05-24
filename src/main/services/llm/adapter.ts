import type { LLMProvider, LLMMessage, TokenUsage } from '@shared/types';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';
import { OllamaProvider } from './providers/ollama';
import { getDb } from '../db/sqlite';
import { tokenMeter } from '../agent-context/token-meter';
import { countTokens } from './token-counter';
import { usageLedger } from './usage-ledger';
import { calculateUsageCostCny, getModelPrice } from './pricing';

// ── Tool-calling types ────────────────────────────────────────────────────────

/** Provider-neutral tool definition sent once per request */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object (same shape as Anthropic's input_schema) */
  inputSchema: Record<string, unknown>;
}

/** A single tool call the model wants to make */
export interface ToolCallBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result to feed back to the model */
export interface ToolResultBlock {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/** Initial or continuation user message in the tool loop */
export interface UserToolTurn {
  role: 'user';
  content: string;
}

/**
 * Assistant message that may contain text, tool calls, or both.
 * `_nativeContent` stores the raw Anthropic ContentBlock[] so Claude's
 * subsequent user message can echo it verbatim (Anthropic requirement).
 * `_reasoningContent` stores OpenAI-compatible reasoning_content so providers
 * like DeepSeek can replay thinking-mode assistant turns verbatim.
 */
export interface AssistantToolTurn {
  role: 'assistant';
  text: string;
  toolCalls: ToolCallBlock[];
  _nativeContent?: unknown;
  _reasoningContent?: string;
}

/** User message that carries tool results back to the model */
export interface ToolResultTurn {
  role: 'tool_results';
  results: ToolResultBlock[];
}

export type ToolTurnMessage = UserToolTurn | AssistantToolTurn | ToolResultTurn;

export type ToolStopReason = 'tool_use' | 'end_turn' | 'max_tokens';

export interface LLMUsageContext {
  sessionId?: string | null;
  courseId?: string | null;
  threadId?: string | null;
  /** Stored with token logs/estimates so auxiliary calls can be audited. */
  source?: string;
  /** Set false only when a caller deliberately accounts for the same API call elsewhere. */
  recordUsage?: boolean;
  /** Set false for calls whose prompt estimate is already recorded by a higher-level context manager. */
  recordEstimate?: boolean;
}

export interface ToolStreamRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt?: string;
  messages: ToolTurnMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** Thinking token budget. 0 disables; undefined = provider default (off). */
  thinkingBudget?: number;
  /** Stream callback for thinking / reasoning content (separate channel). */
  onThinkingChunk?: (text: string) => void;
  /** Images to attach to the last user message (vision-capable models only). */
  imageAttachments?: ImageAttachment[];
  /** PDF documents (Claude + future OpenAI/Gemini support). */
  pdfAttachments?: PdfAttachment[];
  /** Request provider JSON object mode when supported. */
  jsonMode?: boolean;
  usageContext?: LLMUsageContext;
}

export interface ToolStreamResponse {
  stopReason: ToolStopReason;
  /** Text the model emitted this turn (already streamed via onChunk) */
  text: string;
  /** Populated when stopReason === 'tool_use' */
  toolCalls: ToolCallBlock[];
  usage: TokenUsage;
  /**
   * The assistant turn to append to messages[] before the next call.
   * For Claude, contains _nativeContent so the raw content blocks are
   * replayed verbatim in the next request.
   */
  assistantTurn: AssistantToolTurn;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ImageAttachment {
  mediaType: string;  // e.g. "image/png"
  base64: string;
  name: string;
}

export interface PdfAttachment {
  name: string;
  base64: string;
}

export interface AudioAttachment {
  mediaType: string;  // e.g. "audio/mp3", "audio/wav"
  base64: string;
  name: string;
}

export interface VideoAttachment {
  mediaType: string;  // e.g. "video/mp4"
  base64: string;
  name: string;
}

export interface ResponseSchema {
  /** Schema name (used by OpenAI strict json_schema) */
  name: string;
  schema: Record<string, unknown>;
}

export interface LLMStreamOptions {
  provider: LLMProvider;
  model: string;
  messages: LLMMessage[];
  systemPrompt?: string;
  /** When true, send the system prompt with Anthropic prompt-cache headers (Claude only). */
  cacheSystemPrompt?: boolean;
  maxTokens?: number;
  temperature?: number;
  onChunk: (chunk: string) => void;
  onComplete: (usage: TokenUsage) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
  /** Images to attach to the last user message (multimodal). Only sent to vision-capable models. */
  imageAttachments?: ImageAttachment[];
  /** PDF documents to attach (Claude only — sent as document blocks). */
  pdfAttachments?: PdfAttachment[];
  /** Audio attachments — only sent to audio-capable models (e.g. Gemini). */
  audioAttachments?: AudioAttachment[];
  /** Video attachments — only sent to video-capable models (e.g. Gemini). */
  videoAttachments?: VideoAttachment[];
  /** Thinking token budget. 0 disables; undefined = provider default (off). */
  thinkingBudget?: number;
  /** Stream callback for thinking / reasoning content (separate channel from onChunk). */
  onThinkingChunk?: (text: string) => void;
  /** Provider stop reason for callers that need truncation-aware continuation. */
  onStop?: (reason: ToolStopReason) => void;
  /** Strict JSON schema for the response (OpenAI / Gemini strict mode). */
  responseSchema?: ResponseSchema;
  /** Enable provider-native web search / grounding (e.g. Gemini google_search). */
  enableNativeSearch?: boolean;
  /** Request provider JSON object mode when supported. */
  jsonMode?: boolean;
  usageContext?: LLMUsageContext;
}

export interface ILLMProvider {
  stream(options: LLMStreamOptions): Promise<void>;
  /** Agentic single-turn: send messages + tool definitions, return one normalised response. */
  streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse>;
  countTokens(text: string): number;
  pricePer1kTokens: { input: number; output: number };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class LLMAdapter {
  static async stream(options: LLMStreamOptions): Promise<void> {
    const provider = LLMAdapter.getProvider(options.provider);
    const estimatedInputTokens = recordStreamEstimate(options);
    let streamedText = '';
    let streamedThinking = '';
    await provider.stream({
      ...options,
      onChunk: (chunk) => {
        streamedText += chunk;
        options.onChunk(chunk);
      },
      onThinkingChunk: (chunk) => {
        streamedThinking += chunk;
        options.onThinkingChunk?.(chunk);
      },
      onComplete: (usage) => {
        const finalUsage = ensureUsage(
          usage,
          options.provider,
          options.model,
          estimatedInputTokens,
          streamedText,
          streamedThinking,
        );
        recordUsage(options.usageContext, options.provider, options.model, finalUsage, 'llm_stream');
        options.onComplete(finalUsage);
      },
    });
  }

  static async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    const provider = LLMAdapter.getProvider(req.provider);
    const estimatedInputTokens = recordToolStreamEstimate(req);
    let streamedText = '';
    let streamedThinking = '';
    const response = await provider.streamWithTools({
      ...req,
      onChunk: (chunk) => {
        streamedText += chunk;
        req.onChunk(chunk);
      },
      onThinkingChunk: (chunk) => {
        streamedThinking += chunk;
        req.onThinkingChunk?.(chunk);
      },
    });
    const toolOutputText = response.text || streamedText;
    const toolCallText = response.toolCalls.length > 0 ? JSON.stringify(response.toolCalls) : '';
    const finalUsage = ensureUsage(
      response.usage,
      req.provider,
      req.model,
      estimatedInputTokens,
      toolOutputText + toolCallText,
      streamedThinking,
    );
    recordUsage(req.usageContext, req.provider, req.model, finalUsage, 'llm_tool_stream');
    return { ...response, usage: finalUsage };
  }

  static getProvider(provider: LLMProvider): ILLMProvider {
    switch (provider) {
      case 'anthropic':
        return new ClaudeProvider();
      case 'openai':
        return new OpenAIProvider(undefined, 'openai', 'openai');
      case 'deepseek':
        return new OpenAIProvider('https://api.deepseek.com', 'deepseek', 'deepseek');
      case 'grok':
        return new OpenAIProvider('https://api.x.ai/v1', 'grok', 'grok');
      case 'gemini':
        return new OpenAIProvider('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini', 'gemini');
      case 'qwen':
        return new OpenAIProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen', 'qwen');
      case 'minimax':
        return new OpenAIProvider('https://api.minimax.chat/v1', 'minimax', 'minimax');
      case 'openrouter':
        return new OpenAIProvider('https://openrouter.ai/api/v1', 'openrouter', 'openrouter');
      case 'ollama': {
        // Read configured base URL from DB (defaults to localhost:11434 in seed)
        try {
          interface ProvRow { base_url: string | null }
          const row = getDb()
            .prepare<[string], ProvRow>('SELECT base_url FROM providers WHERE id = ?')
            .get('ollama');
          return new OllamaProvider(row?.base_url ?? undefined);
        } catch {
          return new OllamaProvider();
        }
      }
      default: {
        // Look up custom provider from DB
        try {
          interface ProvRow { type: string; base_url: string | null; api_key_name: string | null }
          const row = getDb()
            .prepare<[string], ProvRow>('SELECT type, base_url, api_key_name FROM providers WHERE id = ?')
            .get(provider);
          if (!row) throw new Error(`Unknown LLM provider: ${provider}`);
          if (row.type === 'ollama') {
            return new OllamaProvider(row.base_url ?? undefined);
          }
          // openai_compat or anthropic-type custom provider
          return new OpenAIProvider(row.base_url ?? undefined, row.api_key_name ?? provider, provider);
        } catch (err) {
          throw new Error(`Failed to load provider "${provider}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

function recordUsage(
  context: LLMUsageContext | undefined,
  provider: string,
  model: string,
  usage: TokenUsage,
  fallbackSource: string,
): void {
  if (!context || context.recordUsage === false) return;
  usageLedger.record({
    sessionId: context.sessionId,
    courseId: context.courseId,
    provider,
    model,
    usage,
    source: context.source ?? fallbackSource,
    estimateSource: context.source ?? fallbackSource,
  });
}

function hasUsableUsage(usage: Partial<TokenUsage> | undefined): boolean {
  if (!usage) return false;
  return (usage.inputTokens ?? 0) > 0
    || (usage.outputTokens ?? 0) > 0
    || (usage.inputCacheHitTokens ?? 0) > 0
    || (usage.inputCacheMissTokens ?? 0) > 0
    || (usage.costCny ?? 0) > 0;
}

function normalizeReturnedUsage(usage: TokenUsage): TokenUsage {
  const inputCacheHitTokens = usage.inputCacheHitTokens ?? 0;
  const inputCacheMissTokens = usage.inputCacheMissTokens ?? 0;
  const inputTokens = usage.inputTokens || inputCacheHitTokens + inputCacheMissTokens;
  return {
    ...usage,
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    costCny: usage.costCny ?? 0,
    ...(inputCacheHitTokens > 0 ? { inputCacheHitTokens } : {}),
    ...(inputCacheMissTokens > 0 ? { inputCacheMissTokens } : {}),
  };
}

function ensureUsage(
  usage: TokenUsage,
  provider: LLMProvider,
  model: string,
  estimatedInputTokens: number,
  outputText: string,
  thinkingText: string,
): TokenUsage {
  if (hasUsableUsage(usage)) return normalizeReturnedUsage(usage);

  const outputTokens = countTokens(outputText) + countTokens(thinkingText);
  const estimated: TokenUsage = {
    inputTokens: estimatedInputTokens,
    outputTokens,
    inputCacheMissTokens: estimatedInputTokens,
    estimated: true,
    costCny: 0,
  };
  estimated.costCny = provider === 'ollama'
    ? 0
    : calculateUsageCostCny(estimated, getModelPrice(provider, model));
  return estimated;
}

function recordStreamEstimate(options: LLMStreamOptions): number {
  const estimatedInputTokens = estimateStreamInputTokens(options);
  const context = options.usageContext;
  if (!context || context.recordEstimate === false) return estimatedInputTokens;
  tokenMeter.recordEstimate({
    sessionId: context.sessionId,
    courseId: context.courseId,
    threadId: context.threadId,
    provider: options.provider,
    model: options.model,
    estimatedInputTokens,
    estimatedOutputTokens: options.maxTokens ?? 0,
    source: context.source ?? 'llm_stream',
  });
  return estimatedInputTokens;
}

function recordToolStreamEstimate(req: ToolStreamRequest): number {
  const estimatedInputTokens = estimateToolStreamInputTokens(req);
  const context = req.usageContext;
  if (!context || context.recordEstimate === false) return estimatedInputTokens;
  tokenMeter.recordEstimate({
    sessionId: context.sessionId,
    courseId: context.courseId,
    threadId: context.threadId,
    provider: req.provider,
    model: req.model,
    estimatedInputTokens,
    estimatedOutputTokens: req.maxTokens ?? 0,
    source: context.source ?? 'llm_tool_stream',
  });
  return estimatedInputTokens;
}

function estimateStreamInputTokens(options: LLMStreamOptions): number {
  const textTokens = countTokens(options.systemPrompt ?? '')
    + options.messages.reduce((sum, message) => sum + countTokens(message.content), 0);
  const mediaTokens =
    (options.imageAttachments?.length ?? 0) * 1_600
    + (options.pdfAttachments?.length ?? 0) * 1_200
    + (options.audioAttachments?.length ?? 0) * 2_000
    + (options.videoAttachments?.length ?? 0) * 4_000;
  return textTokens + mediaTokens + options.messages.length * 4 + 16;
}

function estimateToolStreamInputTokens(req: ToolStreamRequest): number {
  const toolSchemaTokens = countTokens(JSON.stringify(req.tools));
  const messageTokens = req.messages.reduce((sum, message) => {
    if (message.role === 'user') return sum + countTokens(message.content);
    if (message.role === 'assistant') {
      return sum + countTokens(message.text) + countTokens(JSON.stringify(message.toolCalls));
    }
    return sum + countTokens(message.results.map((result) => result.content).join('\n'));
  }, 0);
  const mediaTokens =
    (req.imageAttachments?.length ?? 0) * 1_600
    + (req.pdfAttachments?.length ?? 0) * 1_200;
  return countTokens(req.systemPrompt ?? '') + toolSchemaTokens + messageTokens + mediaTokens + req.messages.length * 4 + 24;
}
