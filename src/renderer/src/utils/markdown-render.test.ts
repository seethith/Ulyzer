// @vitest-environment jsdom
// jsdom gives DOMPurify a real `window` so renderMarkdownToHtml's sanitize step
// runs exactly as in the renderer — these tests then also confirm that
// sanitization preserves KaTeX/code output.
import { describe, expect, it } from 'vitest';
import { normalizeMarkdownMath, renderMarkdownToHtml } from './markdown-render';

describe('markdown renderer', () => {
  it('renders single-line display math without leaking delimiters', () => {
    const html = renderMarkdownToHtml(String.raw`$$A^T = \begin{bmatrix} 1 & 2 \\ 0 & 1 \end{bmatrix}$$`);

    expect(html).toContain('katex-display');
    expect(html).not.toContain('$$');
  });

  it('normalizes legacy bracket math and repairs row breaks', () => {
    const normalized = normalizeMarkdownMath(String.raw`
\[
\begin{bmatrix} 1 & 2 \ 0 & 1 \end{bmatrix}
\]
`);

    expect(normalized).toContain('$$');
    expect(normalized).not.toContain(String.raw`\[`);
    expect(normalized).toContain(String.raw`1 & 2 \\ 0 & 1`);
    expect(renderMarkdownToHtml(normalized)).toContain('katex-display');
  });

  it('does not render math inside fenced code blocks', () => {
    const html = renderMarkdownToHtml(['```md', '$$x$$', '```'].join('\n'));

    expect(html).toContain('$$x$$');
    expect(html).not.toContain('katex-display');
  });
});
