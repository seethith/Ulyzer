import { describe, expect, it } from 'vitest';
import { outlineHasBloomTags, outlineHasLearningBlueprintSections } from './material/material-generation-loop';

describe('outlineHasBloomTags', () => {
  it('accepts current Chinese outline format without square brackets', () => {
    expect(outlineHasBloomTags('- 布鲁姆层级：应用')).toBe(true);
  });

  it('accepts bracketed and English outline formats', () => {
    expect(outlineHasBloomTags('- 布鲁姆层级：[分析/评估]')).toBe(true);
    expect(outlineHasBloomTags('- Bloom Level: Apply')).toBe(true);
  });

  it('detects the learning blueprint format', () => {
    expect(outlineHasLearningBlueprintSections(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
内容

## 3. 核心知识结构
### KC1: 示例

## 4. 学习推进顺序
内容

## 5. 掌握证据与诊断
内容`)).toBe(true);
  });
});
