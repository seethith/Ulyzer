import { repairMermaidFlowchartSafeSubset } from '@shared/mermaid-sanitize';

export interface TheoryMarkdownSanitizationResult {
  content: string;
  mermaidBlocks: number;
  repairedBlocks: number;
  warnings: string[];
}

export interface TheoryMarkdownMermaidIssue {
  block: number;
  line: number;
  message: string;
  snippet: string;
}

export interface TheoryMarkdownMermaidVerificationResult {
  passed: boolean;
  mermaidBlocks: number;
  issues: TheoryMarkdownMermaidIssue[];
}

const FENCE_RE = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
const FLOWCHART_START_RE = /^\s*(graph|flowchart)\b/i;
const SAFE_FLOWCHART_START_RE = /^\s*(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\s*;?\s*$/i;
const SIMPLE_NODE_ID_RE = '[A-Za-z][A-Za-z0-9_-]*';
const SHAPE_START_RE = /[[({]/;

function escapeMermaidLabel(label: string): string {
  return label
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim();
}

function quoteMermaidLabel(label: string): string {
  const trimmed = label.trim();
  if (/^"/.test(trimmed) && /"$/.test(trimmed)) return trimmed;
  if (/^['`]/.test(trimmed) && /['`]$/.test(trimmed)) {
    return `"${escapeMermaidLabel(trimmed.slice(1, -1))}"`;
  }

  const clean = escapeMermaidLabel(trimmed);
  if (!clean) return '""';
  return `"${clean}"`;
}

function sanitizeSubgraph(line: string, index: number): { line: string; nextIndex: number; changed: boolean } {
  const match = line.match(/^(\s*)subgraph\s+(.+?)\s*$/i);
  if (!match) return { line, nextIndex: index, changed: false };

  const [, indent, rawTitle] = match;
  const title = rawTitle.trim();
  if (!title || /\[[\s\S]+\]/.test(title)) return { line, nextIndex: index, changed: false };

  return {
    line: `${indent}subgraph sg_${index}[${quoteMermaidLabel(title)}]`,
    nextIndex: index + 1,
    changed: true,
  };
}

function sanitizeFlowchartNodeLabels(line: string): string {
  const id = SIMPLE_NODE_ID_RE;
  const quotedSegments: string[] = [];
  const protectedLine = line.replace(/"[^"\n]*"/g, (match) => {
    const token = `__ULYZER_MMD_QUOTE_${quotedSegments.length}__`;
    quotedSegments.push(match);
    return `"${token}"`;
  });

  const sanitized = protectedLine
    .replace(new RegExp(`\\b(${id})\\s*\\[\\[([^\\]\\n]+?)\\]\\]`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\[\\(([^\\]\\n]+?)\\)\\]`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\[\\{([^\\]\\n]+?)\\}\\]`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\[([^\\]\\n]+?)\\]`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\(\\(([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*)\\)\\)`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\(\\[([^\\]\\n]+?)\\]\\)`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\(([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*)\\)`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`)
    .replace(new RegExp(`\\b(${id})\\s*\\{([^{}\\n]+?)\\}`, 'g'), (_m, nodeId: string, label: string) =>
      `${nodeId}[${quoteMermaidLabel(label)}]`);

  return sanitized.replace(/"__ULYZER_MMD_QUOTE_(\d+)__"/g, (_match, index: string) =>
    quotedSegments[Number(index)] ?? '""');
}

function sanitizeMermaidDiagram(code: string): { code: string; changed: boolean } {
  if (!FLOWCHART_START_RE.test(code)) return { code, changed: false };

  const preRepaired = repairMermaidFlowchartSafeSubset(code);
  let changed = preRepaired.changed;
  let subgraphIndex = 1;
  const lines = preRepaired.code.split('\n').map((line) => {
    const subgraph = sanitizeSubgraph(line, subgraphIndex);
    subgraphIndex = subgraph.nextIndex;
    const next = sanitizeFlowchartNodeLabels(subgraph.line);
    if (next !== line || subgraph.changed) changed = true;
    return next;
  });

  return { code: lines.join('\n'), changed };
}

export function sanitizeTheoryMarkdown(content: string): TheoryMarkdownSanitizationResult {
  const warnings: string[] = [];
  let mermaidBlocks = 0;
  let repairedBlocks = 0;

  const nextContent = content.replace(FENCE_RE, (match, prefix: string, fence: string, info: string, body: string) => {
    const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (lang !== 'mermaid') return match;

    mermaidBlocks++;
    const sanitized = sanitizeMermaidDiagram(body);
    if (!sanitized.changed) return match;

    repairedBlocks++;
    warnings.push('Sanitized Mermaid flowchart labels for safer rendering.');
    return `${prefix}${fence}${info}\n${sanitized.code}\n${fence}`;
  });

  return {
    content: nextContent,
    mermaidBlocks,
    repairedBlocks,
    warnings: [...new Set(warnings)],
  };
}

function eachMermaidBlock(
  content: string,
  visitor: (block: { index: number; body: string; info: string }) => void,
): number {
  let mermaidBlocks = 0;
  content.replace(FENCE_RE, (_match, _prefix: string, _fence: string, info: string, body: string) => {
    const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (lang !== 'mermaid') return _match;
    mermaidBlocks++;
    visitor({ index: mermaidBlocks, body, info });
    return _match;
  });
  return mermaidBlocks;
}

function firstContentLine(lines: string[]): { line: string; number: number } | null {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line && !line.startsWith('%%')) return { line, number: index + 1 };
  }
  return null;
}

function stripEdgeLabels(line: string): string {
  return line.replace(/\|[^|\n]*\|/g, '||');
}

function stripQuotedSegments(line: string): string {
  return line.replace(/"[^"\n]*"/g, '""');
}

function hasUnsafeNodeId(line: string): boolean {
  const withoutEdges = stripQuotedSegments(stripEdgeLabels(line));
  const match = withoutEdges.match(/(^|[\s;])([^\sA-Za-z0-9_[\]().{}"'|:-][^\s[\]().{}|:-]*)\s*[[({]/u);
  return Boolean(match);
}

function hasUnquotedShapeLabel(line: string): boolean {
  const id = SIMPLE_NODE_ID_RE;
  const withoutEdges = stripQuotedSegments(stripEdgeLabels(line));
  const patterns = [
    new RegExp(`\\b${id}\\s*\\[\\s*[^"\\]\\n]`),
    new RegExp(`\\b${id}\\s*\\(\\s*[^"\\)\\n]`),
    new RegExp(`\\b${id}\\s*\\{\\s*[^"\\}\\n]`),
  ];
  return patterns.some((pattern) => pattern.test(withoutEdges));
}

function hasNestedQuotedBracketLabel(line: string): boolean {
  return new RegExp(`\\b${SIMPLE_NODE_ID_RE}\\s*\\["[^"\\n]*\\["[^"\\]\\n]+"\\]`, 'u').test(line);
}

function hasComplexShapeSyntax(line: string): boolean {
  const withoutEdges = stripQuotedSegments(stripEdgeLabels(line));
  return /\)\s*\)|\[\s*\(|\(\s*\[|\[\s*\{|\{\s*\[/.test(withoutEdges);
}

function hasUnsafeSubgraph(line: string): boolean {
  const trimmed = line.trim();
  if (!/^subgraph\b/i.test(trimmed)) return false;
  return !/^subgraph\s+[A-Za-z][A-Za-z0-9_-]*(?:\s*\[\s*"[^"\n]+"\s*\])?\s*$/i.test(trimmed);
}

export function verifyTheoryMarkdownMermaid(content: string): TheoryMarkdownMermaidVerificationResult {
  const issues: TheoryMarkdownMermaidIssue[] = [];
  const mermaidBlocks = eachMermaidBlock(content, ({ index, body }) => {
    const lines = body.split('\n');
    const first = firstContentLine(lines);
    if (!first) {
      issues.push({ block: index, line: 1, message: 'Mermaid 代码块为空。', snippet: '' });
      return;
    }
    if (!FLOWCHART_START_RE.test(first.line)) {
      issues.push({
        block: index,
        line: first.number,
        message: '原理资料中的 Mermaid 只允许使用 flowchart/graph 流程图安全子集。',
        snippet: first.line,
      });
      return;
    }
    if (!SAFE_FLOWCHART_START_RE.test(first.line)) {
      issues.push({
        block: index,
        line: first.number,
        message: '流程图第一行必须写成 flowchart TD、flowchart LR、graph TD 或 graph LR 等明确方向。',
        snippet: first.line,
      });
    }

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('%%') || trimmed === 'end' || lineIndex + 1 === first.number) return;
      if (!SHAPE_START_RE.test(trimmed) && !/^subgraph\b/i.test(trimmed)) return;

      if (hasUnsafeSubgraph(line)) {
        issues.push({
          block: index,
          line: lineIndex + 1,
          message: 'subgraph 必须使用 ASCII id 和双引号标题，例如 subgraph sg1["标题"]。',
          snippet: trimmed,
        });
      }
      if (hasUnsafeNodeId(line)) {
        issues.push({
          block: index,
          line: lineIndex + 1,
          message: 'Mermaid 节点 ID 必须使用 ASCII 字母数字，中文和公式应放入双引号标签。',
          snippet: trimmed,
        });
      }
      if (hasUnquotedShapeLabel(line)) {
        issues.push({
          block: index,
          line: lineIndex + 1,
          message: 'Mermaid 节点文本必须放进双引号，例如 A["概念说明"]。',
          snippet: trimmed,
        });
      }
      if (hasNestedQuotedBracketLabel(line)) {
        issues.push({
          block: index,
          line: lineIndex + 1,
          message: 'Mermaid 节点标签里不能再嵌套 ["..."]，维度/公式请写成括号或纯文本，例如 A["矩阵 A(m×n)"]。',
          snippet: trimmed,
        });
      }
      if (hasComplexShapeSyntax(line)) {
        issues.push({
          block: index,
          line: lineIndex + 1,
          message: '请避免圆形/胶囊/嵌套括号等复杂节点形状，统一使用矩形节点 A["文本"]。',
          snippet: trimmed,
        });
      }
    });
  });

  return { passed: issues.length === 0, mermaidBlocks, issues };
}

export function formatTheoryMermaidIssues(result: TheoryMarkdownMermaidVerificationResult, language?: string): string {
  const details = result.issues
    .slice(0, 6)
    .map((issue) => `- block ${issue.block}, line ${issue.line}: ${issue.message} (${issue.snippet})`)
    .join('\n');

  if (language?.toLowerCase().startsWith('en')) {
    return `Mermaid validation failed before saving theory material. Rewrite only the Mermaid code blocks using this safe subset:\n` +
      `- First line: flowchart TD or flowchart LR\n` +
      `- Node ids: ASCII only, such as A, B1, concept_1\n` +
      `- Node labels: always double-quoted, such as A["Concept"]\n` +
      `- Do not put extra double quotes or ["..."] inside node labels; write A["Matrix A(m×n)"], not A["Matrix A["m×n"]"]\n` +
      `- Edges: A --> B or A -->|"relation"| B\n` +
      `- Subgraphs: subgraph sg1["Title"] ... end\n` +
      `- Do not use round/circle/nested bracket node shapes.\n\nIssues:\n${details}`;
  }

  return `原理资料保存前 Mermaid 校验未通过。请只重写 Mermaid 代码块，并严格使用以下安全子集：\n` +
    `- 第一行：flowchart TD 或 flowchart LR\n` +
    `- 节点 ID：只用 ASCII，例如 A、B1、concept_1\n` +
    `- 节点文本：必须双引号，例如 A["概念说明"]\n` +
    `- 节点文本内部不要再写双引号或 ["..."]，维度写成 A["矩阵 A(m×n)"]，不要写 A["矩阵 A["m×n"]"]\n` +
    `- 连线：A --> B 或 A -->|"关系"| B\n` +
    `- 子图：subgraph sg1["标题"] ... end\n` +
    `- 不要使用圆形、胶囊、嵌套括号等复杂节点形状。\n\n问题：\n${details}`;
}
