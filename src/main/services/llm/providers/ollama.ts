import { randomUUID } from 'crypto';
import type { ILLMProvider, LLMStreamOptions, ToolStreamRequest, ToolStreamResponse, ToolCallBlock, AssistantToolTurn } from '../adapter';
import type { TokenUsage } from '@shared/types';

interface OllamaChunk {
  message?: { content?: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ILLMProvider {
  pricePer1kTokens = { input: 0, output: 0 }; // local, no cost

  constructor(private readonly baseUrl: string = 'http://localhost:11434') {}

  async stream(options: LLMStreamOptions): Promise<void> {
    const messages = options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (options.systemPrompt) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');

    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as OllamaChunk;
            const text = chunk.message?.content ?? '';
            if (text && !options.signal?.aborted) options.onChunk(text);
            if (chunk.done) {
              inputTokens = chunk.prompt_eval_count ?? 0;
              outputTokens = chunk.eval_count ?? 0;
            }
          } catch {
            // ignore malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!options.signal?.aborted) {
      const usage: TokenUsage = { inputTokens, outputTokens, costCny: 0 };
      options.onComplete(usage);
    }
  }

  async streamWithTools(req: ToolStreamRequest): Promise<ToolStreamResponse> {
    // Build Ollama messages (OpenAI-compatible format)
    const messages: { role: string; content: string; tool_calls?: unknown }[] = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });

    for (const m of req.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        if (m.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: m.text ?? '',
            tool_calls: m.toolCalls.map((tc) => ({
              function: { name: tc.name, arguments: tc.input },
            })),
          });
        } else {
          messages.push({ role: 'assistant', content: m.text });
        }
      } else {
        // tool_results — Ollama uses 'tool' role
        for (const r of m.results) {
          messages.push({ role: 'tool', content: r.content });
        }
      }
    }

    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    interface OllamaStreamChunk {
      message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
      done: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    req.model,
        messages,
        tools,
        stream:   true,
        ...(req.maxTokens !== undefined ? { options: { num_predict: req.maxTokens } } : {}),
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');

    const decoder = new TextDecoder();
    let content = '';
    const allToolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as OllamaStreamChunk;
            if (chunk.message?.content) {
              content += chunk.message.content;
              if (!req.signal?.aborted) req.onChunk(chunk.message.content);
            }
            if (chunk.message?.tool_calls?.length) {
              allToolCalls.push(...chunk.message.tool_calls);
            }
            if (chunk.done) {
              inputTokens  = chunk.prompt_eval_count ?? 0;
              outputTokens = chunk.eval_count ?? 0;
            }
          } catch { /* ignore malformed lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const usage: TokenUsage = { inputTokens, outputTokens, costCny: 0 };

    if (allToolCalls.length > 0) {
      const toolCalls: ToolCallBlock[] = allToolCalls.map((tc) => ({
        id:    randomUUID(), // Ollama doesn't provide tool call IDs
        name:  tc.function.name,
        input: tc.function.arguments,
      }));
      const assistantTurn: AssistantToolTurn = { role: 'assistant', text: content, toolCalls };
      return { stopReason: 'tool_use', text: content, toolCalls, usage, assistantTurn };
    }

    const assistantTurn: AssistantToolTurn = { role: 'assistant', text: content, toolCalls: [] };
    return { stopReason: 'end_turn', text: content, toolCalls: [], usage, assistantTurn };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
