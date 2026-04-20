import { describe, it, expect } from 'vitest';
import { createBudget } from './token-budget';

describe('createBudget', () => {
  it('starts with zero usage', () => {
    const b = createBudget();
    expect(b.used).toBe(0);
    expect(b.percentUsed()).toBe(0);
    expect(b.shouldCompress()).toBe(false);
  });

  it('accumulates tokens correctly', () => {
    const b = createBudget(1000);
    b.add(400, 100);
    expect(b.used).toBe(500);
    expect(b.percentUsed()).toBe(0.5);
    b.add(200, 50);
    expect(b.used).toBe(750);
  });

  it('shouldCompress is false at 85%', () => {
    const b = createBudget(1000);
    b.add(800, 50); // exactly 85% — threshold is strict (>), so false
    expect(b.shouldCompress()).toBe(false);
  });

  it('shouldCompress triggers just above 85%', () => {
    const b = createBudget(1000);
    b.add(800, 51); // 85.1%
    expect(b.shouldCompress()).toBe(true);
  });

  it('shouldCompress triggers well above 85%', () => {
    const b = createBudget(1000);
    b.add(900, 0); // 90%
    expect(b.shouldCompress()).toBe(true);
  });

  it('accepts a custom limit', () => {
    const b = createBudget(500);
    expect(b.limit).toBe(500);
    b.add(425, 1); // > 85%
    expect(b.shouldCompress()).toBe(true);
  });

  it('defaults to 180 000 limit', () => {
    const b = createBudget();
    expect(b.limit).toBe(180_000);
  });
});
