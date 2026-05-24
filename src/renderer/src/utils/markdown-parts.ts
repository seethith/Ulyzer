export type MarkdownRenderPart =
  | { kind: 'markdown'; content: string }
  | { kind: 'mermaid'; content: string };

const FENCE_RE = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
const MERMAID_FENCE_LANGS = new Set(['mermaid', 'mindmap']);

function isMermaidInfo(info: string): boolean {
  const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase();
  return MERMAID_FENCE_LANGS.has(lang);
}

function pushMarkdownPart(parts: MarkdownRenderPart[], content: string): void {
  if (!content) return;
  const previous = parts.at(-1);
  if (previous?.kind === 'markdown') {
    previous.content += content;
    return;
  }
  parts.push({ kind: 'markdown', content });
}

export function splitMarkdownForMermaid(content: string): MarkdownRenderPart[] {
  const parts: MarkdownRenderPart[] = [];
  let cursor = 0;

  content.replace(FENCE_RE, (match, prefix: string, _fence: string, info: string, body: string, offset: number) => {
    if (!isMermaidInfo(info)) return match;

    pushMarkdownPart(parts, content.slice(cursor, offset) + prefix);
    parts.push({ kind: 'mermaid', content: body.trim() });
    cursor = offset + match.length;
    return match;
  });

  pushMarkdownPart(parts, content.slice(cursor));
  return parts.length > 0 ? parts : [{ kind: 'markdown', content }];
}
