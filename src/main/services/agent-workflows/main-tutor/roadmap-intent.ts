import type { LLMMessage, SearchMode } from '@shared/types';

const ROUTE_CREATE_RE = /路线图|学习路线|学习路径|课程规划|学习规划|roadmap|learning path|curriculum plan/i;
const ROUTE_ACTION_RE = /生成|创建|规划|制定|做一份|来一份|设计|安排|create|generate|plan|build|make/i;

const WEB_RE = /联网|网络|网页|互联网|外网|web[_ -]?search|web|internet|online/i;
const LIBRARY_RE = /参考库|资料库|课程参考库|本地资料|上传资料|上传的资料|参考资料|该资料|这份资料|source library|local sources?|uploaded files?|references?/i;

const ONLY_RE = /只|仅|仅仅|单纯|完全|严格|唯一|一律|only|strictly|exclusively/i;
const BASED_ON_RE = /依据|基于|使用|参考|来自|按照|围绕|based on|according to|use|from/i;
const NO_WEB_RE = /(不要|不用|无需|不许|禁止|别|不能|不调用).{0,12}(联网|网络|网页|互联网|外网|web[_ -]?search|web|internet|online)|不\s*联网|without.{0,12}(web|internet|online)|no.{0,12}(web|internet|online)/i;
const NO_LIBRARY_RE = /(不要|不用|无需|不许|禁止|别|不能|不看|不读取|不调用).{0,12}(参考库|资料库|课程参考库|本地资料|上传资料|上传的资料|参考资料|source library|local sources?|uploaded files?|references?)|without.{0,12}(library|local sources?|uploaded files?|references?)|no.{0,12}(library|local sources?|uploaded files?|references?)/i;

export function isRoadmapCreationRequest(text: string | undefined): boolean {
  const normalized = (text ?? '').trim();
  if (!normalized) return false;
  return ROUTE_CREATE_RE.test(normalized) && ROUTE_ACTION_RE.test(normalized);
}

function recentUserText(messages: LLMMessage[] | undefined): string {
  return (messages ?? [])
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => message.content)
    .join('\n');
}

function hasLibraryOnlyConstraint(text: string): boolean {
  if (!LIBRARY_RE.test(text)) return false;
  const hasOnlyLibrary = ONLY_RE.test(text) && BASED_ON_RE.test(text);
  const noWeb = NO_WEB_RE.test(text);
  const libraryAsAuthority = /为准|唯一参考|唯一依据|sole source|single source/i.test(text);
  return hasOnlyLibrary || noWeb || libraryAsAuthority;
}

function hasWebOnlyConstraint(text: string): boolean {
  if (!WEB_RE.test(text)) return false;
  const noLibrary = NO_LIBRARY_RE.test(text);
  const onlyWeb = ONLY_RE.test(text) && BASED_ON_RE.test(text);
  return noLibrary || onlyWeb;
}

function hasNoSearchConstraint(text: string): boolean {
  return NO_WEB_RE.test(text) && NO_LIBRARY_RE.test(text);
}

export function resolveRoadmapSearchMode(input: {
  baseMode: SearchMode;
  userMessage?: string;
  messages?: LLMMessage[];
  topic?: string;
}): SearchMode {
  const primaryText = [input.userMessage, input.topic]
    .filter(Boolean)
    .join('\n');
  const text = primaryText.trim() ? primaryText : recentUserText(input.messages);
  if (!text.trim()) return input.baseMode;

  if (hasNoSearchConstraint(text)) return 'off';
  if (hasLibraryOnlyConstraint(text)) return 'library';
  if (hasWebOnlyConstraint(text)) return 'web';
  return input.baseMode;
}
