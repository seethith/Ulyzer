/**
 * Tool registry — registers all built-in tools once at startup.
 *
 * New tools only need a `registerTool()` call here;
 * the loop dispatch requires no code changes.
 */
import { registerTool, getAllTools } from './index';
import type { ToolDef } from '../../llm/adapter';
import { ragRetrieveTool } from './rag-retrieve.tool';
import { webSearchTool } from './web-search.tool';
import { generateQuizTool } from './generate-quiz.tool';
import { saveFileTool } from './save-file.tool';
import { createFileTool } from './create-file.tool';
import { readNodeMaterialsTool } from './read-node-materials.tool';

// Register all tools (isReadOnly marks tools safe for parallel execution)
registerTool({ ...ragRetrieveTool,       isReadOnly: true  });
registerTool({ ...webSearchTool,         isReadOnly: true  });
registerTool({ ...generateQuizTool,      isReadOnly: true  });
registerTool({ ...readNodeMaterialsTool, isReadOnly: true  });
registerTool({ ...saveFileTool,          isReadOnly: false });
registerTool({ ...createFileTool,        isReadOnly: false });

/** Build the provider-neutral tool definitions for LLMAdapter.streamWithTools(). */
export function buildToolDefs(): ToolDef[] {
  return getAllTools().map((t) => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputJsonSchema,
  }));
}
