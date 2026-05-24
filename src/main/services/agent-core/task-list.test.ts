import { describe, expect, it } from 'vitest';
import { TaskList, applyWriteTodos } from './task-list';

describe('TaskList', () => {
  it('starts empty with no open items', () => {
    const list = new TaskList();
    expect(list.isEmpty()).toBe(true);
    expect(list.hasOpenItems()).toBe(false);
    expect(list.openCount()).toBe(0);
    expect(list.render()).toBe('');
  });

  it('replace() assigns stable ids, drops blanks, and tracks open items', () => {
    const list = new TaskList();
    list.replace([
      { content: 'plan', status: 'completed' },
      { content: '  ', status: 'pending' },
      { content: 'write', status: 'in_progress' },
      { content: 'review', status: 'pending' },
    ]);
    expect(list.list().map((i) => i.id)).toEqual(['t1', 't2', 't3']);
    expect(list.openCount()).toBe(2);
    expect(list.hasOpenItems()).toBe(true);
  });

  it('renders a compact checklist with status marks', () => {
    const list = new TaskList();
    list.replace([
      { content: 'done thing', status: 'completed' },
      { content: 'doing thing', status: 'in_progress' },
      { content: 'todo thing', status: 'pending' },
    ]);
    const render = list.render('en');
    expect(render).toContain('[x] done thing');
    expect(render).toContain('[~] doing thing');
    expect(render).toContain('[ ] todo thing');
  });

  it('round-trips through JSON for checkpointing', () => {
    const list = new TaskList();
    list.replace([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }]);
    const restored = TaskList.fromJSON(list.toJSON());
    expect(restored.list()).toEqual(list.list());
    expect(restored.openCount()).toBe(1);
  });

  it('normalizes unknown statuses to pending', () => {
    const list = new TaskList();
    list.loadFrom({ items: [{ id: 'x', content: 'c', status: 'bogus' as never }] });
    expect(list.list()[0].status).toBe('pending');
  });

  it('openSummary lists open items only, truncating with a count', () => {
    const list = new TaskList();
    list.replace([
      { content: 'one', status: 'pending' },
      { content: 'two', status: 'pending' },
      { content: 'done', status: 'completed' },
    ]);
    const summary = list.openSummary('en', 1);
    expect(summary).toContain('one');
    expect(summary).toContain('(+1)');
    expect(summary).not.toContain('done');
  });
});

describe('applyWriteTodos', () => {
  it('replaces the list and reports counts', () => {
    const list = new TaskList();
    const reply = applyWriteTodos(list, {
      todos: [
        { content: 'step 1', status: 'completed' },
        { content: 'step 2', status: 'pending' },
      ],
    }, 'en');
    expect(list.list()).toHaveLength(2);
    expect(list.openCount()).toBe(1);
    expect(reply).toContain('2');
    expect(reply).toContain('1 open');
  });

  it('is a no-op-safe message when no task list is bound', () => {
    expect(applyWriteTodos(undefined, { todos: [] }, 'en')).toMatch(/not available/i);
  });

  it('tolerates malformed todo entries', () => {
    const list = new TaskList();
    applyWriteTodos(list, { todos: [{ content: 123 as never }, { status: 'pending' }] }, 'en');
    // Numeric content coerced away, missing content dropped → empty list.
    expect(list.isEmpty()).toBe(true);
  });
});
