import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { collectCodeBlocks, collectLinkAtPosition, collectTables } from './parse';

function markdownState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

describe('markdown live parser helpers', () => {
  it('collects GFM pipe tables as a single block range', () => {
    const state = markdownState([
      '|对比维度|特征值分解（EVD）|奇异值分解（SVD）|',
      '|--------|-----------------|-----------------|',
      '|适用对象|仅可对角化的方阵|任意矩阵|',
    ].join('\n'));

    expect(collectTables(state)).toEqual([
      {
        from: 0,
        to: state.doc.length,
        source: state.doc.toString(),
      },
    ]);
  });

  it('keeps tables with inline math collectible as one table block', () => {
    const state = markdownState([
      '|序号|错误描述|正确做法|',
      '|-----|--------|--------|',
      '|1|忘记对特征值开方：直接取 $A^T A$ 的特征值作为奇异值|$\\sigma_i=\\sqrt{\\lambda_i}$|',
    ].join('\n'));

    expect(collectTables(state)).toEqual([
      {
        from: 0,
        to: state.doc.length,
        source: state.doc.toString(),
      },
    ]);
  });

  it('falls back to line scanning when a table node is unavailable', () => {
    const doc = [
      '前言',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '后记',
    ].join('\n');
    const state = EditorState.create({ doc });

    expect(collectTables(state)).toHaveLength(1);
    expect(collectTables(state)[0]?.source).toBe('| A | B |\n|---|---|\n| 1 | 2 |');
  });

  it('collects mermaid fenced code blocks with their info string', () => {
    const state = markdownState('```mermaid\nmindmap\n  root((SVD))\n```');
    const blocks = collectCodeBlocks(state);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      from: 0,
      to: state.doc.length,
      info: 'mermaid',
      code: 'mindmap\n  root((SVD))',
    });
    expect(state.sliceDoc(blocks[0]?.codeFrom ?? 0, blocks[0]?.codeTo ?? 0)).toBe('mindmap\n  root((SVD))');
  });

  it('finds clickable Markdown links by visible text position', () => {
    const state = markdownState('## 4.3 常见错误清单 [AI 补充](https://example.com/ai)');
    const textPosition = state.doc.toString().indexOf('AI 补充') + 1;

    expect(collectLinkAtPosition(state, textPosition)?.url).toBe('https://example.com/ai');
  });

  it('finds clickable Markdown links when the raw URL portion is revealed', () => {
    const state = markdownState('[YouTube 教程](https://www.youtube.com/results?search_query=SVD)');
    const rawUrlPosition = state.doc.toString().indexOf('youtube.com') + 1;

    expect(collectLinkAtPosition(state, rawUrlPosition)?.url).toBe('https://www.youtube.com/results?search_query=SVD');
  });

  it('finds clickable bare http URLs', () => {
    const state = markdownState('参考：https://example.com/path');
    const textPosition = state.doc.toString().indexOf('example.com') + 1;

    expect(collectLinkAtPosition(state, textPosition)?.url).toBe('https://example.com/path');
  });
});
