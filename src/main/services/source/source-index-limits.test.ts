import { describe, expect, it } from 'vitest';
import { resolveSourceMaxChunks } from './source-index-limits';

describe('source index limits', () => {
  it('keeps existing small-source defaults', () => {
    expect(resolveSourceMaxChunks({ sourceKind: 'web' })).toBe(40);
    expect(resolveSourceMaxChunks({ sourceKind: 'generated' })).toBe(80);
    expect(resolveSourceMaxChunks({ sourceKind: 'upload' })).toBe(160);
  });

  it('scales upload budgets by page count with a hard ceiling', () => {
    expect(resolveSourceMaxChunks({ sourceKind: 'upload', pageCount: 100 })).toBe(300);
    expect(resolveSourceMaxChunks({ sourceKind: 'upload', pageCount: 2_000 })).toBe(3000);
  });

  it('honors explicit positive limits', () => {
    expect(resolveSourceMaxChunks({ sourceKind: 'upload', pageCount: 2_000, explicit: 42 })).toBe(42);
  });
});
