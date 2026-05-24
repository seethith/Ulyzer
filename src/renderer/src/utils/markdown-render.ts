import { Marked, type Tokens } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import i18n from '../i18n';

const markdownRenderer = new Marked();

markdownRenderer.setOptions({
  breaks: true,
  gfm: true,
});

// Icon-only copy control (locale-neutral, so the sync renderer needs no i18n).
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

function escapeHtmlAttr(input: string): string {
  return input.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

// Syntax-highlighted code blocks. highlight.js is synchronous, so it slots into
// the existing string-based pipeline without the streaming flicker an async
// highlighter (e.g. Shiki) would cause. A header carries the language label and
// a copy button (wired via event delegation in MarkdownPreview).
markdownRenderer.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const requested = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      let highlighted: string;
      let resolvedLang = requested;
      try {
        if (requested && hljs.getLanguage(requested)) {
          highlighted = hljs.highlight(text, { language: requested, ignoreIllegals: true }).value;
        } else {
          const auto = hljs.highlightAuto(text);
          highlighted = auto.value;
          resolvedLang = auto.language ?? '';
        }
      } catch {
        highlighted = escapeHtmlAttr(text);
      }
      const langLabel = resolvedLang
        ? `<span class="md-code-lang">${escapeHtmlAttr(resolvedLang)}</span>`
        : '<span class="md-code-lang"></span>';
      const copyBtn = `<button class="md-code-copy" type="button" aria-label="copy">${COPY_ICON}</button>`;
      const langClass = resolvedLang ? ` language-${escapeHtmlAttr(resolvedLang)}` : '';
      return `<pre class="hljs-pre"><div class="md-code-head">${langLabel}${copyBtn}</div>`
        + `<code class="hljs${langClass}">${highlighted}</code></pre>`;
    },
  },
});

const FENCE_RE = /(^|\n)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g;
const LATEX_ENV_RE = /\\begin\{(bmatrix|pmatrix|matrix|array|cases|aligned|align)\}([\s\S]*?)\\end\{\1\}/g;
const DISPLAY_MATH_RE = /\$\$([\s\S]*?)\$\$/g;
const INLINE_MATH_RE = /(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g;

interface MathRenderToken {
  placeholder: string;
  html: string;
}

function mapOutsideCodeFences(input: string, mapper: (segment: string) => string): string {
  let output = '';
  let cursor = 0;
  input.replace(FENCE_RE, (match, _prefix: string, _fence: string, _info: string, offset: number) => {
    output += mapper(input.slice(cursor, offset));
    output += match;
    cursor = offset + match.length;
    return match;
  });
  output += mapper(input.slice(cursor));
  return output;
}

function repairSingleBackslashRowBreaks(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const prev = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '\\' && prev !== '\\' && next !== '\\' && !/[A-Za-z]/.test(next)) {
      output += '\\\\';
    } else {
      output += char;
    }
  }
  return output;
}

function repairLatexEnvironmentRows(text: string): string {
  return text.replace(LATEX_ENV_RE, (match, env: string, body: string) =>
    match.replace(`\\begin{${env}}${body}\\end{${env}}`, `\\begin{${env}}${repairSingleBackslashRowBreaks(body)}\\end{${env}}`),
  );
}

function looksLikeLatexBlock(body: string): boolean {
  return /\\(?:begin|left|right|frac|sum|int|prod|lim|sqrt|cdot|times|mathbb|mathbf|vec|vdots|ddots|quad)/.test(body);
}

function normalizeMathSegment(segment: string): string {
  return segment
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, body: string) =>
      `\n$$\n${repairLatexEnvironmentRows(body.trim())}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) =>
      `$${repairLatexEnvironmentRows(body.trim())}$`)
    .replace(/(^|\n)\[\s*([\s\S]*?)\s*\](?=\n{2,}|$)/g, (match, prefix: string, body: string) => {
      if (!looksLikeLatexBlock(body)) return match;
      return `${prefix}$$\n${repairLatexEnvironmentRows(body.trim())}\n$$`;
    })
    .replace(/(^|\n)\$\$\s*([\s\S]*?)\s*\$\$(?=\n|$)/g, (_match, prefix: string, body: string) =>
      `${prefix}$$\n${repairLatexEnvironmentRows(body.trim())}\n$$`);
}

export function normalizeMarkdownMath(content: string): string {
  return mapOutsideCodeFences(content, normalizeMathSegment);
}

export function renderMarkdownMath(formula: string, displayMode: boolean): string {
  const trimmed = repairLatexEnvironmentRows(formula.trim());
  if (!trimmed) return '';

  try {
    return katex.renderToString(trimmed, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    });
  } catch {
    const escaped = escapeHtml(trimmed);
    const kind = displayMode ? i18n.t('markdown.block_formula') : i18n.t('markdown.inline_formula');
    return `<code class="katex-error" title="${i18n.t('markdown.formula_render_failed', { kind })}">${escaped}</code>`;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractMathFromSegment(segment: string, tokens: MathRenderToken[]): string {
  const withoutDisplay = segment.replace(DISPLAY_MATH_RE, (_match, body: string) => {
    const placeholder = `@@ULYZERMATH${tokens.length}@@`;
    tokens.push({ placeholder, html: renderMarkdownMath(body, true) });
    return placeholder;
  });

  return withoutDisplay.replace(INLINE_MATH_RE, (_match, prefix: string, body: string) => {
    const placeholder = `@@ULYZERMATH${tokens.length}@@`;
    tokens.push({ placeholder, html: renderMarkdownMath(body, false) });
    return `${prefix}${placeholder}`;
  });
}

function extractMath(content: string): { markdown: string; tokens: MathRenderToken[] } {
  const tokens: MathRenderToken[] = [];
  const markdown = mapOutsideCodeFences(content, (segment) => extractMathFromSegment(segment, tokens));
  return { markdown, tokens };
}

// marked passes raw HTML through unchanged, so the final markup — which is then
// injected via dangerouslySetInnerHTML / innerHTML — must be sanitized before it
// reaches the DOM. The profiles keep KaTeX (MathML), highlight.js, and SVG output
// intact while stripping <script>, event handlers, and other injection vectors.
function sanitizeRenderedHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  });
}

export function renderMarkdownToHtml(content: string): string {
  const normalized = normalizeMarkdownMath(content);
  const { markdown, tokens } = extractMath(normalized);
  let html = markdownRenderer.parse(markdown) as string;
  for (const token of tokens) {
    html = html.split(token.placeholder).join(token.html);
  }
  return sanitizeRenderedHtml(html);
}

export function renderMarkdownInlineToHtml(content: string): string {
  const normalized = normalizeMarkdownMath(content);
  const { markdown, tokens } = extractMath(normalized);
  let html = markdownRenderer.parseInline(markdown) as string;
  for (const token of tokens) {
    html = html.split(token.placeholder).join(token.html);
  }
  return sanitizeRenderedHtml(html);
}
