import { describe, expect, it } from 'vitest';
import { ContextWindowManager } from './context-window-manager';
import type { LLMMessage } from '@shared/types';

function longText(label: string): string {
  return `${label}\n${Array.from({ length: 1400 }, (_, index) => `长内容${index}`).join(' ')}`;
}

describe('ContextWindowManager projection', () => {
  it('does not count an empty draft as a live user turn', () => {
    const manager = new ContextWindowManager();
    const snapshot = manager.getSnapshot({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'main_tutor',
      fallbackMessages: [],
      currentUserMessage: '',
    });

    expect(snapshot.liveMessageCount).toBe(0);
    expect(snapshot.rawTranscriptTokens).toBe(0);
  });

  it('uses visible renderer messages for context status projections', () => {
    const manager = new ContextWindowManager();
    const empty = manager.getSnapshot({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'main_tutor',
      fallbackMessages: [],
      currentUserMessage: '',
    });
    const withVisibleMessage = manager.getSnapshot({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'main_tutor',
      visibleMessages: [{
        id: 'visible-user-1',
        role: 'user',
        content: 'Please generate a roadmap for machine learning.',
        timestamp: Date.now(),
      }],
      currentUserMessage: '',
    });

    expect(withVisibleMessage.liveMessageCount).toBe(1);
    expect(withVisibleMessage.estimatedInputTokens).toBeGreaterThan(empty.estimatedInputTokens);
  });

  it('counts tool schemas in the projected context window', () => {
    const manager = new ContextWindowManager();
    const withoutTools = manager.getSnapshot({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'main_tutor',
      fallbackMessages: [],
      currentUserMessage: 'hello',
    });
    const withTools = manager.getSnapshot({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'main_tutor',
      fallbackMessages: [],
      currentUserMessage: 'hello',
      tools: [{
        name: 'read_roadmap',
        description: 'Read the current roadmap with node ids and dependencies.',
        inputSchema: {
          type: 'object',
          properties: {
            chapter: { type: 'string' },
            include_edges: { type: 'boolean' },
          },
        },
      }],
    });

    expect(withTools.breakdown.toolSchemaTokens).toBeGreaterThan(0);
    expect(withTools.estimatedInputTokens).toBeGreaterThan(withoutTools.estimatedInputTokens);
  });

  it('micro-compacts old long messages in the active projection while preserving recent messages', async () => {
    const manager = new ContextWindowManager();
    const fallbackMessages: LLMMessage[] = [
      { role: 'assistant', content: longText('old long assistant answer') },
      { role: 'user', content: 'old short 1' },
      { role: 'assistant', content: 'old short 2' },
      { role: 'user', content: 'old short 3' },
      { role: 'assistant', content: 'old short 4' },
      { role: 'user', content: 'old short 5' },
      { role: 'assistant', content: 'old short 6' },
      { role: 'user', content: 'old short 7' },
      { role: 'assistant', content: 'recent assistant must stay exact' },
      { role: 'user', content: 'recent user must stay exact' },
    ];

    const prepared = await manager.prepareMessages({
      modelProvider: 'openai',
      model: 'gpt-test',
      courseId: 'course-1',
      agent: 'sub_tutor',
      systemPrompt: 'system',
      initialMessages: [],
      fallbackMessages,
      currentUserMessage: 'current question',
    });

    const text = prepared.messages.map((message) => {
      if (message.role === 'user') return message.content;
      if (message.role === 'assistant') return message.text;
      return message.results.map((result) => result.content).join('\n');
    }).join('\n');

    expect(text).toContain('消息级折叠');
    expect(text).toContain('recent assistant must stay exact');
    expect(text).toContain('recent user must stay exact');
    expect(prepared.snapshot.microCompactedCount).toBeGreaterThan(0);
  });
});
