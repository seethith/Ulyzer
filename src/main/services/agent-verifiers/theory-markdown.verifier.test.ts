import { describe, expect, it } from 'vitest';
import { sanitizeTheoryMarkdown, verifyTheoryMarkdownMermaid } from './theory-markdown.verifier';

describe('sanitizeTheoryMarkdown', () => {
  it('quotes Mermaid flowchart labels that commonly break parsing', () => {
    const input = [
      '# Theory',
      '',
      '```mermaid',
      'graph LR',
      '    subgraph 二元线性方程组',
      '        A[方程1: a₁x + b₁y = c₁] -->|对应| L1[直线 L1]',
      '        B[方程2: a₂x + b₂y = c₂] -->|对应| L2[直线 L2]',
      '    end',
      '    L1 -->|交点| S((解 (x,y)))',
      '    L2 -->|交点| S',
      '```',
    ].join('\n');

    const result = sanitizeTheoryMarkdown(input);

    expect(result.mermaidBlocks).toBe(1);
    expect(result.repairedBlocks).toBe(1);
    expect(result.content).toContain('subgraph sg_1["二元线性方程组"]');
    expect(result.content).toContain('A["方程1: a₁x + b₁y = c₁"]');
    expect(result.content).toContain('L1["直线 L1"]');
    expect(result.content).toContain('S["解 (x,y)"]');
    expect(verifyTheoryMarkdownMermaid(result.content).passed).toBe(true);
  });

  it('repairs nested quoted labels in Mermaid nodes', () => {
    const input = [
      '# Theory',
      '',
      '```mermaid',
      'flowchart LR',
      '    A["矩阵 A["m×n"]"] -->|"对应元素相加"| SUM["A + B["m×n"]"]',
      '    B["矩阵 B["m×n"]"] -->|"对应元素相加"| SUM',
      '```',
    ].join('\n');

    const result = sanitizeTheoryMarkdown(input);

    expect(result.repairedBlocks).toBe(1);
    expect(result.content).toContain('A["矩阵 A(m×n)"]');
    expect(result.content).toContain('SUM["A + B(m×n)"]');
    expect(verifyTheoryMarkdownMermaid(result.content).passed).toBe(true);
  });

  it('leaves non-Mermaid code blocks untouched', () => {
    const input = [
      '```ts',
      'const A = [1, 2, 3];',
      '```',
    ].join('\n');

    const result = sanitizeTheoryMarkdown(input);

    expect(result.content).toBe(input);
    expect(result.mermaidBlocks).toBe(0);
    expect(result.repairedBlocks).toBe(0);
  });

  it('rejects unsupported Mermaid types in theory material', () => {
    const input = [
      '```mermaid',
      'mindmap',
      '  root((A))',
      '```',
    ].join('\n');

    const result = verifyTheoryMarkdownMermaid(input);

    expect(result.passed).toBe(false);
    expect(result.issues[0]?.message).toContain('flowchart/graph');
  });

  it('rejects unsafe unquoted flowchart labels', () => {
    const input = [
      '```mermaid',
      'flowchart LR',
      '  A[未加引号] --> B["安全"]',
      '```',
    ].join('\n');

    const result = verifyTheoryMarkdownMermaid(input);

    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('双引号'))).toBe(true);
  });

  it('rejects nested quoted labels if sanitization is bypassed', () => {
    const input = [
      '```mermaid',
      'flowchart LR',
      '  A["矩阵 A["m×n"]"] --> B["安全"]',
      '```',
    ].join('\n');

    const result = verifyTheoryMarkdownMermaid(input);

    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('不能再嵌套'))).toBe(true);
  });
});
