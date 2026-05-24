const FLOWCHART_START_RE = /^\s*(graph|flowchart)\b/i;
const SIMPLE_NODE_ID_RE = '[A-Za-z][A-Za-z0-9_-]*';

export interface MermaidRepairResult {
  code: string;
  changed: boolean;
}

function escapeMermaidLabel(label: string): string {
  return label
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\["([^"\]\n]+)"\]/g, '($1)')
    .replace(/"/g, "'")
    .trim();
}

function quoteMermaidLabel(label: string): string {
  const clean = escapeMermaidLabel(label);
  return `"${clean || ''}"`;
}

function repairNestedQuotedBracketLabels(line: string): string {
  let output = line;
  const nestedLabelPattern = new RegExp(
    `\\b(${SIMPLE_NODE_ID_RE})\\s*\\["([^"\\n]*?)\\["([^"\\]\\n]+)"\\]([^"\\n]*?)"\\]`,
    'g',
  );

  for (let pass = 0; pass < 6; pass++) {
    const next = output.replace(
      nestedLabelPattern,
      (_match, nodeId: string, before: string, inner: string, after: string) =>
        `${nodeId}[${quoteMermaidLabel(`${before}(${inner})${after}`)}]`,
    );
    if (next === output) break;
    output = next;
  }

  return output;
}

/**
 * Repairs common LLM-produced Mermaid flowchart syntax that is visually obvious
 * but invalid to Mermaid, especially nested node labels like:
 *   A["矩阵 A["m×n"]"]
 * which should be rendered as:
 *   A["矩阵 A(m×n)"]
 */
export function repairMermaidFlowchartSafeSubset(code: string): MermaidRepairResult {
  if (!FLOWCHART_START_RE.test(code)) return { code, changed: false };

  let changed = false;
  const lines = code.split('\n').map((line) => {
    const repaired = repairNestedQuotedBracketLabels(line);
    if (repaired !== line) changed = true;
    return repaired;
  });

  return { code: lines.join('\n'), changed };
}
