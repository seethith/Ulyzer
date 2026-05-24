/**
 * User-facing chat tool registry.
 *
 * These tools are exposed to the node tutor's conversational tool loop. Tools
 * that are only needed while writing material files live in `tutor-tools/`.
 */
import type { TutorTool } from '../tutor-tools/index';
import type { ToolContext } from '../tutor-tools/index';
import type { AgentTool, AgentToolRegistry } from '../types';
import { createAgentToolRegistry } from '../registry';
import { createToolCatalogFromModules } from '../tool-catalog';
import {
  generateTheoryTool, generatePracticeTool,
} from './generate.tools';
import {
  generateFeynmanChecklistTool, generateMindmapTool,
} from './review.tools';
import {
  readMaterialsTool, recordMistakeTool, appendToNotesTool,
  readFileTool, getNodeProgressTool, readSourceTool, searchKnowledgeTool, searchLibraryTool,
} from './content.tools';
import {
  copyNodeItemTool,
  deleteNodeItemTool,
  editMarkdownFileTool,
  listMarkdownHeadingsTool,
  listNodeFilesTool,
  moveNodeItemTool,
  patchMarkdownFileTool,
  readMarkdownSectionTool,
  renameNodeItemTool,
  searchNodeFilesTool,
  updateFileTool,
} from './node-file.tools';
import { createFileTool } from '../tutor-tools/create-file.tool';
import { webSearchChatTool } from './web-search.tool';
import { webFetchChatTool } from './web-fetch.tool';
import { generateTopicTool } from './generate-topic.tool';
import { generateOutlineTool } from './generate-outline.tool';
import { searchVideosTool } from './search-videos.tool';
import { generateExternalReferenceIndexTool } from './external-reference-index.tool';
import { writeTodosTool } from './todo.tools';
import { spawnSubtaskTool } from './spawn.tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAT_TOOLS = new Map<string, TutorTool<any, any>>([
  [generateTheoryTool.name,           generateTheoryTool],
  [generatePracticeTool.name,         generatePracticeTool],
  [generateFeynmanChecklistTool.name,  generateFeynmanChecklistTool],
  [generateMindmapTool.name,           generateMindmapTool],
  [generateExternalReferenceIndexTool.name, generateExternalReferenceIndexTool],
  [readMaterialsTool.name,            readMaterialsTool],
  [searchKnowledgeTool.name,          searchKnowledgeTool],
  [searchLibraryTool.name,            searchLibraryTool],
  [readSourceTool.name,               readSourceTool],
  [readFileTool.name,                 readFileTool],
  [listNodeFilesTool.name,            listNodeFilesTool],
  [searchNodeFilesTool.name,          searchNodeFilesTool],
  [listMarkdownHeadingsTool.name,     listMarkdownHeadingsTool],
  [readMarkdownSectionTool.name,      readMarkdownSectionTool],
  [getNodeProgressTool.name,          getNodeProgressTool],
  [recordMistakeTool.name,            recordMistakeTool],
  [appendToNotesTool.name,            appendToNotesTool],
  [updateFileTool.name,               updateFileTool],
  [editMarkdownFileTool.name,          editMarkdownFileTool],
  [patchMarkdownFileTool.name,         patchMarkdownFileTool],
  [deleteNodeItemTool.name,           deleteNodeItemTool],
  [renameNodeItemTool.name,           renameNodeItemTool],
  [moveNodeItemTool.name,             moveNodeItemTool],
  [copyNodeItemTool.name,             copyNodeItemTool],
  [createFileTool.name,               createFileTool],
  [webSearchChatTool.name,            webSearchChatTool],
  [webFetchChatTool.name,             webFetchChatTool],
  [generateTopicTool.name,            generateTopicTool],
  [generateOutlineTool.name,          generateOutlineTool],
  [searchVideosTool.name,             searchVideosTool],
  [writeTodosTool.name,               writeTodosTool],
  [spawnSubtaskTool.name,             spawnSubtaskTool],
]);

export function buildChatToolRegistry() {
  return createToolCatalogFromModules<ToolContext>('chat', [...CHAT_TOOLS.values()]).toRegistry();
}

/**
 * Safe default toolset a spawned sub-agent gets when the caller doesn't specify
 * one: read/search tools plus light writes and write_todos. Excludes heavy
 * generation tools and always excludes spawn_subtask (no recursion).
 */
const DEFAULT_SUBTASK_TOOLS: readonly string[] = [
  'read_materials', 'search_knowledge', 'search_library', 'read_source', 'read_file',
  'list_node_files', 'search_node_files', 'list_markdown_headings', 'read_markdown_section',
  'get_node_progress', 'web_search', 'web_fetch', 'record_mistake', 'append_to_notes',
  'update_file', 'edit_markdown_file', 'patch_markdown_file', 'create_file', 'write_todos',
];

/**
 * Build the (filtered) registry a sub-agent runs with. `requested` narrows to an
 * explicit toolset; otherwise the safe default set is used. `spawn_subtask` is
 * always removed so sub-agents cannot recurse.
 */
export function buildSubAgentToolRegistry(requested?: string[]): AgentToolRegistry<ToolContext> {
  const available = new Map(buildChatToolRegistry().list().map((tool) => [tool.name, tool]));
  const wanted = requested && requested.length > 0 ? requested : DEFAULT_SUBTASK_TOOLS;
  const selected: AgentTool<ToolContext>[] = [];
  const seen = new Set<string>();
  for (const name of wanted) {
    if (name === 'spawn_subtask' || seen.has(name)) continue;
    const tool = available.get(name);
    if (tool) { selected.push(tool); seen.add(name); }
  }
  // Always keep write_todos so the sub-agent can self-plan and hit its completion gate.
  if (!seen.has('write_todos') && available.has('write_todos')) {
    selected.push(available.get('write_todos')!);
  }
  return createAgentToolRegistry(selected);
}
