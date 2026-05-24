/**
 * Material generation tool registry.
 *
 * These tools are available only inside `material/material-generation-loop.ts`.
 * User-facing chat tools live in `chat-tools/registry.ts`.
 */
import type { ToolContext, TutorTool } from './index';
import { createToolCatalogFromModules } from '../tool-catalog';
import { ragRetrieveTool } from './rag-retrieve.tool';
import { webSearchTool } from './web-search.tool';
import { generateQuizTool } from './generate-quiz.tool';
import { saveFileTool } from './save-file.tool';
import { createFileTool } from './create-file.tool';
import { readNodeMaterialsTool } from './read-node-materials.tool';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MATERIAL_GENERATION_TOOLS: Array<TutorTool<any, any>> = [
  { ...ragRetrieveTool,       isReadOnly: true  },
  { ...webSearchTool,         isReadOnly: true  },
  { ...generateQuizTool,      isReadOnly: true  },
  { ...readNodeMaterialsTool, isReadOnly: true  },
  { ...saveFileTool,          isReadOnly: false },
  { ...createFileTool,        isReadOnly: false },
];

export interface MaterialToolRegistryOptions {
  targetFolder?: 'theory' | 'practice' | 'answer' | 'notes';
  allowWebSearch?: boolean;
  allowRagRetrieve?: boolean;
  allowReadNodeMaterials?: boolean;
}

export function buildTutorToolRegistry(options: MaterialToolRegistryOptions = {}) {
  const tools = MATERIAL_GENERATION_TOOLS.filter((tool) => {
    if (tool.name === 'web_search') return options.allowWebSearch === true;
    if (tool.name === 'rag_retrieve') return options.allowRagRetrieve ?? options.targetFolder === undefined;
    if (tool.name === 'read_node_materials') return options.allowReadNodeMaterials ?? options.targetFolder === undefined;
    if (tool.name === 'generate_quiz') return options.targetFolder === 'practice';
    if (tool.name === 'create_file') return options.targetFolder === 'notes';
    return true;
  });
  return createToolCatalogFromModules<ToolContext>('tutor', tools).toRegistry();
}
