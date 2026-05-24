import { describe, expect, it } from 'vitest';
import { hasMermaidRenderError } from './mermaid-render';

describe('hasMermaidRenderError', () => {
  it('does not treat Mermaid v11 built-in error styles as a render failure', () => {
    const normalSvg = [
      '<svg class="flowchart" role="graphics-document document">',
      '<style>.error-icon{fill:#552222}.error-text{fill:#552222}</style>',
      '<g class="node"><text>正常图表</text></g>',
      '</svg>',
    ].join('');

    expect(hasMermaidRenderError(normalSvg)).toBe(false);
  });

  it('detects explicit Mermaid error SVGs and visible error text', () => {
    expect(hasMermaidRenderError('<svg aria-roledescription="error"></svg>')).toBe(true);
    expect(hasMermaidRenderError('<svg><text>Syntax error in text</text></svg>')).toBe(true);
  });
});
