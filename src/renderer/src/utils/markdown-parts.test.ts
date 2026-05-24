import { describe, expect, it } from 'vitest';
import { splitMarkdownForMermaid } from './markdown-parts';

describe('splitMarkdownForMermaid', () => {
  it('extracts Mermaid fences while keeping other Markdown intact', () => {
    const parts = splitMarkdownForMermaid([
      '# Title',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      'A["a"] --> B["b"]',
      '```',
      '',
      'after',
    ].join('\n'));

    expect(parts).toEqual([
      {
        kind: 'markdown',
        content: [
          '# Title',
          '',
          '```ts',
          'const x = 1;',
          '```',
          '',
          '',
        ].join('\n'),
      },
      {
        kind: 'mermaid',
        content: 'flowchart LR\nA["a"] --> B["b"]',
      },
      {
        kind: 'markdown',
        content: '\n\nafter',
      },
    ]);
  });

  it('returns a single Markdown part when there are no Mermaid fences', () => {
    expect(splitMarkdownForMermaid('plain **text**')).toEqual([
      { kind: 'markdown', content: 'plain **text**' },
    ]);
  });

  it('treats mindmap fences as Mermaid diagrams', () => {
    expect(splitMarkdownForMermaid([
      '```mindmap',
      'mindmap',
      '  root((A))',
      '    B',
      '```',
    ].join('\n'))).toEqual([
      { kind: 'mermaid', content: 'mindmap\n  root((A))\n    B' },
    ]);
  });
});
