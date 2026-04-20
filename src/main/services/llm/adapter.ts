import type { LLMProvider, LLMMessage, TokenUsage } from '@shared/types';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';
import { OllamaProvider } from './providers/ollama';
import { getDb } from '../db/sqlite';

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
 * Other providers leave it undefined.
 */
export interface AssistantToolTurn {
  role: 'assistant';
  text: string;
  toolCalls: ToolCallBlock[];
  _nativeContent?: unknown;
}

/** User message that carries tool results back to the model */
export interface ToolResultTurn {
  role: 'tool_results';
  results: ToolResultBlock[];
}

export type ToolTurnMessage = UserToolTurn | AssistantToolTurn | ToolResultTurn;

export type ToolStopReason = 'tool_use' | 'end_turn' | 'max_tokens';

export interface ToolStreamRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt?: string;
  messages: ToolTurnMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
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
    await provider.stream(options);
  }

  static async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    const provider = LLMAdapter.getProvider(req.provider);
    return provider.streamWithTools(req);
  }

  static getProvider(provider: LLMProvider): ILLMProvider {
    switch (provider) {
      case 'anthropic':
        return new ClaudeProvider();
      case 'openai':
        return new OpenAIProvider();
      case 'deepseek':
        return new OpenAIProvider('https://api.deepseek.com', 'deepseek');
      case 'grok':
        return new OpenAIProvider('https://api.x.ai/v1', 'grok');
      case 'gemini':
        return new OpenAIProvider('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini');
      case 'qwen':
        return new OpenAIProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen');
      case 'minimax':
        return new OpenAIProvider('https://api.minimax.chat/v1', 'minimax');
      case 'openrouter':
        return new OpenAIProvider('https://openrouter.ai/api/v1', 'openrouter');
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
          return new OpenAIProvider(row.base_url ?? undefined, row.api_key_name ?? provider);
        } catch (err) {
          throw new Error(`Failed to load provider "${provider}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
