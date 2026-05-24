import katex from 'katex';

export interface MarkdownMathSanitizationResult {
  content: string;
  mathBlocks: number;
  repairedBlocks: number;
  warnings: string[];
}

export interface MarkdownMathIssue {
  index: number;
  displayMode: boolean;
  message: string;
  snippet: string;
}

export interface MarkdownMathVerificationResult {
  passed: boolean;
  mathBlocks: number;
  issues: MarkdownMathIssue[];
}

const FENCE_RE = /(^|\n)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g;
const LATEX_ENV_RE = /\\begin\{(bmatrix|pmatrix|matrix|array|cases|aligned|align)\}([\s\S]*?)\\end\{\1\}/g;
const BLOCK_MATH_RE = /\$\$([\s\S]*?)\$\$/g;
const INLINE_MATH_RE = /(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g;

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

function normalizeMathSegment(segment: string, state: { repairedBlocks: number; warnings: Set<string> }): string {
  return segment
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, body: string) => {
      state.repairedBlocks++;
      state.warnings.add('Converted \\[...\\] display math to $$...$$ for Markdown rendering.');
      return `\n$$\n${repairLatexEnvironmentRows(body.trim())}\n$$\n`;
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => {
      state.repairedBlocks++;
      state.warnings.add('Converted \\(...\\) inline math to $...$ for Markdown rendering.');
      return `$${repairLatexEnvironmentRows(body.trim())}$`;
    })
    .replace(/(^|\n)\[\s*([\s\S]*?)\s*\](?=\n{2,}|$)/g, (match, prefix: string, body: string) => {
      if (!looksLikeLatexBlock(body)) return match;
      state.repairedBlocks++;
      state.warnings.add('Converted bare [ ... ] LaTeX block to $$...$$.');
      return `${prefix}$$\n${repairLatexEnvironmentRows(body.trim())}\n$$`;
    })
    .replace(/(^|\n)\$\$\s*([\s\S]*?)\s*\$\$(?=\n|$)/g, (_match, prefix: string, body: string) => {
      const repaired = repairLatexEnvironmentRows(body.trim());
      if (repaired !== body.trim()) {
        state.repairedBlocks++;
        state.warnings.add('Repaired single-backslash row breaks inside LaTeX matrix/cases environments.');
      }
      return `${prefix}$$\n${repaired}\n$$`;
    });
}

export function sanitizeMarkdownMath(content: string): MarkdownMathSanitizationResult {
  const state = { repairedBlocks: 0, warnings: new Set<string>() };
  const nextContent = mapOutsideCodeFences(content, (segment) => normalizeMathSegment(segment, state));
  const mathBlocks = countMathBlocks(nextContent);
  return {
    content: nextContent,
    mathBlocks,
    repairedBlocks: state.repairedBlocks,
    warnings: [...state.warnings],
  };
}

function countMathBlocks(content: string): number {
  let count = 0;
  mapOutsideCodeFences(content, (segment) => {
    segment.replace(BLOCK_MATH_RE, (match) => {
      count++;
      return match;
    });
    segment.replace(BLOCK_MATH_RE, '').replace(INLINE_MATH_RE, (match) => {
      count++;
      return match;
    });
    return segment;
  });
  return count;
}

export function verifyMarkdownMath(content: string): MarkdownMathVerificationResult {
  const issues: MarkdownMathIssue[] = [];
  let index = 0;

  mapOutsideCodeFences(content, (segment) => {
    const withoutBlocks = segment.replace(BLOCK_MATH_RE, (match, body: string) => {
      index++;
      validateMath(body, true, index, issues);
      return ' '.repeat(match.length);
    });

    withoutBlocks.replace(INLINE_MATH_RE, (match, _prefix: string, body: string) => {
      index++;
      validateMath(body, false, index, issues);
      return match;
    });

    return segment;
  });

  return { passed: issues.length === 0, mathBlocks: index, issues };
}

function validateMath(
  body: string,
  displayMode: boolean,
  index: number,
  issues: MarkdownMathIssue[],
): void {
  const formula = body.trim();
  if (!formula) return;
  try {
    katex.renderToString(formula, {
      throwOnError: true,
      displayMode,
      strict: false,
      trust: false,
    });
  } catch (error) {
    issues.push({
      index,
      displayMode,
      message: error instanceof Error ? error.message : String(error),
      snippet: formula.slice(0, 120),
    });
  }
}

export function formatMarkdownMathIssues(result: MarkdownMathVerificationResult, language?: string): string {
  const details = result.issues
    .slice(0, 6)
    .map((issue) => `- formula ${issue.index}: ${issue.message} (${issue.snippet})`)
    .join('\n');

  if (language?.toLowerCase().startsWith('en')) {
    return `LaTeX math validation failed before saving. Rewrite the formulas using standard Markdown math delimiters:\n` +
      `- Inline math: $a+b$\n` +
      `- Display math: $$ on its own line, formula body, then $$ on its own line\n` +
      `- Matrix/cases row breaks must use \\\\, not a single \\\n\n${details}`;
  }

  return `保存前 LaTeX 公式校验未通过。请用标准 Markdown 数学公式格式重写：\n` +
    `- 行内公式：$a+b$\n` +
    `- 块级公式：$$ 单独一行，公式正文，$$ 单独一行\n` +
    `- 矩阵/cases 的行换行必须使用 \\\\，不能只写单个 \\\n\n${details}`;
}
