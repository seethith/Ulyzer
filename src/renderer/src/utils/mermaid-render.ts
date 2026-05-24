const ERROR_ROLE_RE = /aria-roledescription=(["'])error\1/i;
const VISIBLE_ERROR_TEXT_RE = /(?:syntax|parse|lexical)\s+error/i;

export function hasMermaidRenderError(svg: string): boolean {
  return ERROR_ROLE_RE.test(svg) || VISIBLE_ERROR_TEXT_RE.test(svg);
}
