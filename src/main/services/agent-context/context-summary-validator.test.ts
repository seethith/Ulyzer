import { describe, expect, it } from 'vitest';
import type { ThreadMessageRow } from '../db/repositories/chat-thread-context.repo';
import { appendMissingMustKeeps, extractMustKeepItems, validateContextSummary } from './context-summary-validator';

function row(id: string, content: string): ThreadMessageRow {
  return {
    id,
    role: 'user',
    content,
    progress: null,
    created_at: `2026-01-01T00:00:0${id}.000Z`,
    token_count: 0,
  };
}

describe('context summary validator', () => {
  it('extracts user corrections, constraints, todos, and file references as must-keep items', () => {
    const items = extractMustKeepItems([
      row('1', '不是把资料放在 notes.md，而是必须写入 纲要/_outline_v2.md。下一步继续检查覆盖率。'),
    ]);

    expect(items.map((item) => item.reason)).toContain('correction');
    expect(items.map((item) => item.reason)).toContain('file');
    expect(items.some((item) => item.text.includes('_outline_v2.md'))).toBe(true);
  });

  it('appends missing must-keep items when a summary drops important facts', () => {
    const rows = [
      row('1', '记住：以后生成练习题不要出选择题，必须用项目题。'),
      row('2', 'TODO：下一步补充 /tmp/course/answer.md。'),
    ];
    const validation = validateContextSummary('用户想继续学习当前节点。', rows);
    const repaired = appendMissingMustKeeps('用户想继续学习当前节点。', validation);

    expect(validation.missingFacts.length).toBeGreaterThan(0);
    expect(repaired).toContain('必须保留的原始对话要点');
    expect(repaired).toContain('不要出选择题');
    expect(repaired).toContain('/tmp/course/answer.md');
  });
});
