/**
 * Stabilize a half-streamed Markdown string for transient preview rendering.
 *
 * While tokens arrive mid-stream, an unclosed code fence makes everything after
 * it render as a code block, and an unclosed `**`/`` ` `` flashes the literal
 * markers before snapping to formatted text. This temporarily closes the most
 * jarring open constructs so the in-progress render stays calm. It is only for
 * the live preview — the committed message is rendered from the real, complete
 * text, so any over-eager closing here is harmless.
 */
export function closeDanglingMarkdown(input: string): string {
  let text = input;

  // 1) Close an unclosed fenced code block (``` or ~~~), toggling on each fence.
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/;
  let openFence: string | null = null;
  for (const line of text.split('\n')) {
    const m = fenceRe.exec(line);
    if (!m) continue;
    openFence = openFence === null ? m[1] : null;
  }
  if (openFence) {
    // Inside a code block: just close it; don't touch inline markers within.
    return text + (text.endsWith('\n') ? '' : '\n') + openFence;
  }

  // 2) Balance trailing inline markers so partial emphasis doesn't flash.
  const backticks = (text.match(/`/g) ?? []).length;
  if (backticks % 2 === 1) text += '`';
  const bold = (text.match(/\*\*/g) ?? []).length;
  if (bold % 2 === 1) text += '**';

  return text;
}
