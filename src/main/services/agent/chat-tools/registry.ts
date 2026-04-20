/**
 * Chat tool registry — separate from the generation-loop tool registry in tutor-tools/.
 * These tools are used by SubTutor.handleChat (streamWithTools loop).
 */
import type { TutorTool } from '../tutor-tools/index';
import type { ToolDef } from '../../llm/adapter';
import {
  generateTheoryTool, generatePracticeTool,
  generateFeynmanChecklistTool, generateMindmapTool, generateChapterSummaryTool,
} from './generate.tools';
import {
  readMaterialsTool, recordMistakeTool, appendToNotesTool,
  readFileTool, getNodeProgressTool, searchKnowledgeTool,
} from './content.tools';
import { createFileTool } from '../tutor-tools/create-file.tool';
import { webSearchChatTool } from './web-search.tool';
import { generateTopicTool } from './generate-topic.tool';
import { generateOutlineTool } from './generate-outline.tool';
import { searchVideosTool } from './search-videos.tool';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAT_TOOLS = new Map<string, TutorTool<any, any>>([
  [generateTheoryTool.name,           generateTheoryTool],
  [generatePracticeTool.name,         generatePracticeTool],
  [generateFeynmanChecklistTool.name,  generateFeynmanChecklistTool],
  [generateMindmapTool.name,           generateMindmapTool],
  [generateChapterSummaryTool.name,    generateChapterSummaryTool],
  [readMaterialsTool.name,            readMaterialsTool],
  [searchKnowledgeTool.name,          searchKnowledgeTool],
  [readFileTool.name,                 readFileTool],
  [getNodeProgressTool.name,          getNodeProgressTool],
  [recordMistakeTool.name,            recordMistakeTool],
  [appendToNotesTool.name,            appendToNotesTool],
  [createFileTool.name,               createFileTool],
  [webSearchChatTool.name,            webSearchChatTool],
  [generateTopicTool.name,            generateTopicTool],
  [generateOutlineTool.name,          generateOutlineTool],
  [searchVideosTool.name,             searchVideosTool],
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getChatTool(name: string): TutorTool<any, any> | undefined {
  return CHAT_TOOLS.get(name);
}

export function buildChatToolDefs(): ToolDef[] {
  return [...CHAT_TOOLS.values()].map((t) => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputJsonSchema,
  }));
}
