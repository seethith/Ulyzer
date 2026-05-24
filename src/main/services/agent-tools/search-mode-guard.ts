import type { SearchMode } from '@shared/types';
import { localMsg } from '../agent-i18n/messages';
import { createAgentToolRegistry } from './registry';
import type { AgentToolRegistry } from './types';

// ── Tool-set trimming by search mode ────────────────────────────────────────────
//
// Search mode is enforced primarily by removing the disallowed retrieval tools
// from the model's tool set (so it never wastes a turn calling a blocked tool);
// the block* messages below remain a backstop for workflow/RAG paths that don't
// go through the chat tool loop. Generation tools (generate_theory/practice/…) are
// NOT trimmed — they keep working and respect the search mode internally.

const WEB_SEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'search_videos', 'generate_external_reference_index']);
const LIBRARY_SEARCH_TOOLS = new Set(['search_library', 'read_source', 'search_knowledge']);

/** Remove retrieval tools the active search mode forbids. `auto` keeps everything. */
export function filterRegistryBySearchMode<TContext>(
  registry: AgentToolRegistry<TContext>,
  mode: SearchMode | undefined,
): AgentToolRegistry<TContext> {
  if (!mode || mode === 'auto') return registry;
  const blocked = new Set<string>();
  if (mode === 'off' || mode === 'web') LIBRARY_SEARCH_TOOLS.forEach((name) => blocked.add(name));
  if (mode === 'off' || mode === 'library') WEB_SEARCH_TOOLS.forEach((name) => blocked.add(name));
  if (blocked.size === 0) return registry;
  return createAgentToolRegistry(registry.list().filter((tool) => !blocked.has(tool.name)));
}

export function blockWebMessage(mode: SearchMode | undefined, language?: string): string | null {
  if (mode === 'library') {
    return localMsg(language, '当前搜索模式为「严格参考库」，本轮禁止联网搜索。', 'Search mode is Strict Library; web search is blocked for this turn.');
  }
  if (mode === 'off') {
    return localMsg(language, '当前搜索模式为「关闭」，本轮禁止联网搜索和参考库检索。', 'Search mode is Off; both web search and library retrieval are blocked for this turn.');
  }
  return null;
}

export function blockLibraryMessage(mode: SearchMode | undefined, language?: string): string | null {
  if (mode === 'web') {
    return localMsg(language, '当前搜索模式为「联网」，本轮只使用网络搜索，不读取参考库。', 'Search mode is Web; this turn uses web search only and will not read the source library.');
  }
  if (mode === 'off') {
    return localMsg(language, '当前搜索模式为「关闭」，本轮禁止联网搜索和参考库检索。', 'Search mode is Off; both web search and library retrieval are blocked for this turn.');
  }
  return null;
}
