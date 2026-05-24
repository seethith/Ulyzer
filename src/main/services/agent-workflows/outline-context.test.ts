import { describe, expect, it } from 'vitest';
import { normalizeOutlineVersionForArtifact } from './outline-context';

describe('normalizeOutlineVersionForArtifact', () => {
  it('does not treat a second theory material as an outline v2 upgrade', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'theory',
      outlineVersion: 'v2',
      userMessage: '请再生成一份原理资料，换个案例视角',
    })).toBeUndefined();
  });

  it('keeps an explicitly requested outline version', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'theory',
      outlineVersion: 'v2',
      userMessage: '请按 outline v2 生成一份原理资料',
    })).toBe('v2');
  });

  it('does not let practice material drift away from the practice blueprint by accident', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'practice',
      outlineVersion: 'v1',
      userMessage: '请再生成一套实践资料，题目更难一点',
    })).toBeUndefined();
  });

  it('does not let review material drift away from the review blueprint by accident', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'review',
      outlineVersion: 'v1',
      userMessage: '我学完了，再生成一份复盘清单',
    })).toBeUndefined();
  });

  it('keeps an explicitly requested practice outline version', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'practice',
      outlineVersion: 'v1',
      userMessage: '请按纲要 v1 出一套基础练习',
    })).toBe('v1');
  });

  it('uses artifact-default routing when no version is selected', () => {
    expect(normalizeOutlineVersionForArtifact({
      artifactKind: 'practice',
      outlineVersion: 'latest',
      userMessage: '请生成实践资料',
    })).toBeUndefined();
  });
});
