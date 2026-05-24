import mermaid from 'mermaid';

export const MERMAID_RENDER_CONFIG: Parameters<typeof mermaid.initialize>[0] = {
  startOnLoad: false,
  theme: 'neutral',
  // 'strict' makes mermaid sanitize labels and disables HTML/click injection in
  // diagrams — required because we render LLM-generated diagram source.
  securityLevel: 'strict',
  themeVariables: {
    fontFamily: 'Noto Sans SC, system-ui, sans-serif',
  },
  mindmap: {
    useMaxWidth: true,
    padding: 18,
    maxNodeWidth: 150,
  },
};

export function isMindmapSource(source: string): boolean {
  return /^\s*mindmap\b/i.test(source);
}
