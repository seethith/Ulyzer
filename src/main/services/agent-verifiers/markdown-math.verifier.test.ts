import { describe, expect, it } from 'vitest';
import { sanitizeMarkdownMath, verifyMarkdownMath } from './markdown-math.verifier';

describe('markdown math verifier', () => {
  it('normalizes bracket display math for Markdown/KaTeX rendering', () => {
    const input = String.raw`
Before

\[
\begin{cases}
x + y = 1 \\
x - y = 3
\end{cases}
\]
`;

    const result = sanitizeMarkdownMath(input);

    expect(result.repairedBlocks).toBeGreaterThan(0);
    expect(result.content).toContain('$$');
    expect(result.content).not.toContain('\\[');
    expect(verifyMarkdownMath(result.content).passed).toBe(true);
  });

  it('repairs single-backslash row breaks inside matrix environments', () => {
    const input = String.raw`$$ A = \begin{bmatrix} 1 & 2 \ 3 & 4 \end{bmatrix} $$`;

    const result = sanitizeMarkdownMath(input);

    expect(result.content).toContain(String.raw`1 & 2 \\ 3 & 4`);
    expect(verifyMarkdownMath(result.content).passed).toBe(true);
  });

  it('flags invalid formulas before saving', () => {
    const result = verifyMarkdownMath(String.raw`$$\notacommand{1}$$`);

    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
