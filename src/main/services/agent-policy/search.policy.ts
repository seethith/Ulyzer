import type { SearchMode } from '@shared/types';
import { localMsg } from '../prompt/prompt-builder';
import type { PromptPolicyLayer, SearchPolicyAudience } from './types';

export function getSearchModeInstruction(
  mode: SearchMode,
  audience: SearchPolicyAudience,
  language?: string,
): string {
  if (audience === 'main_tutor') {
    if (mode === 'web') {
      return localMsg(language, '\n\n[搜索模式] 本轮用户要求只联网，不读取参考库。若用户要求生成全新路线图，直接调用 generate_dag，不要先调用 web_search；generate_dag 内部会按本模式检索网络证据。若只是回答路线/事实问题，再调用 web_search。不要调用 search_library/read_source。', '\n\n[Search mode] The user requested web-only search this turn. Do not read the source library. For a brand-new roadmap request, call generate_dag directly and do not call web_search first; generate_dag will retrieve web evidence internally under this mode. For ordinary factual answers, call web_search. Do not call search_library/read_source.');
    }
    if (mode === 'library') {
      return localMsg(language, '\n\n[搜索模式] 本轮为严格参考库模式：只能依据已启用参考库资料，不联网，不用外部通用知识补齐参考库未覆盖内容。若用户要求生成全新路线图，直接调用 generate_dag，不要先调用 search_library/read_source；generate_dag 内部会按严格参考库模式读取目录、章节和证据片段。普通问答才优先调用 search_library，必要时 read_source。资料不足时明确说明不足，不要调用 web_search。', '\n\n[Search mode] Strict library mode: use only enabled source-library material. Do not use web or outside general knowledge to fill gaps not covered by the library. For a brand-new roadmap request, call generate_dag directly and do not call search_library/read_source first; generate_dag will read outlines, chapters, and evidence snippets internally under strict library mode. For ordinary Q&A, prefer search_library and then read_source when needed. State insufficiency when sources are lacking. Do not call web_search.');
    }
    if (mode === 'off') {
      return localMsg(language, '\n\n[搜索模式] 本轮关闭搜索；不要调用 web_search、search_library 或 read_source，也不要读取参考库。信息不确定时请说明。', '\n\n[Search mode] Search is off this turn. Do not call web_search, search_library, or read_source, and do not read the source library. State uncertainty when needed.');
    }
    return '';
  }

  if (mode === 'web') {
    return localMsg(language, '\n\n[搜索模式] 本轮用户要求只联网，不读取参考库。若回答依赖外部事实、最新参考资料或生成学习资料，请先调用 web_search。不要调用 search_library/read_source。', '\n\n[Search mode] The user requested web-only search this turn. Do not read the source library. If the answer depends on external facts, current information, or generated learning material, call web_search first. Do not call search_library/read_source.');
  }
  if (mode === 'library') {
    return localMsg(language, '\n\n[搜索模式] 本轮为严格参考库模式：只能依据当前可见参考库资料，不联网，不用外部通用知识补齐。优先调用 search_library；若需要具体页/段落，必须调用 read_source 展开。资料不足时直接说明不足，不要调用 web_search。', '\n\n[Search mode] Strict library mode: use only currently visible source-library material. Do not use web or outside general knowledge to fill gaps. Prefer search_library; call read_source when exact pages/paragraphs are needed. State insufficiency when sources are lacking. Do not call web_search.');
  }
  if (mode === 'off') {
    return localMsg(language, '\n\n[搜索模式] 本轮关闭搜索。不要调用 web_search、search_library 或 read_source；信息不确定时请说明。', '\n\n[Search mode] Search is off this turn. Do not call web_search, search_library, or read_source; state uncertainty when needed.');
  }
  return '';
}

export function searchPolicyLayer(
  mode: SearchMode,
  audience: SearchPolicyAudience,
  language?: string,
): PromptPolicyLayer {
  return () => getSearchModeInstruction(mode, audience, language).trim();
}
