import { describe, expect, it } from 'vitest';
import type { ToolDef } from '../llm/adapter';
import { buildDagToolDefs } from '../agent-tools/dag-tools';
import { buildChatToolRegistry } from '../agent-tools/chat-tools/registry';
import { buildTutorToolRegistry } from '../agent-tools/tutor-tools/registry';

const CJK_PATTERN = /[\u3400-\u9fff]/;

function collectDescriptions(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectDescriptions(item, output);
    return output;
  }
  if (typeof value !== 'object' || value === null) return output;

  for (const [key, item] of Object.entries(value)) {
    if (key === 'description' && typeof item === 'string') {
      output.push(item);
    } else {
      collectDescriptions(item, output);
    }
  }
  return output;
}

function allToolDefs(language?: string): ToolDef[] {
  return [
    ...buildDagToolDefs(language),
    ...buildTutorToolRegistry().buildToolDefs(language),
    ...buildChatToolRegistry().buildToolDefs(language),
  ];
}

describe('localized tool definitions', () => {
  it('keeps tool names and field keys stable while localizing English descriptions', () => {
    const defs = allToolDefs('en-US');
    expect(defs.length).toBeGreaterThan(0);

    for (const tool of defs) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      const descriptions = collectDescriptions(tool);
      expect(descriptions.length).toBeGreaterThan(0);
      for (const description of descriptions) {
        expect(description).not.toMatch(CJK_PATTERN);
      }
    }
  });

  it('keeps Chinese descriptions available for localized tool definitions', () => {
    const saveFile = buildTutorToolRegistry()
      .buildToolDefs('zh-CN')
      .find((tool) => tool.name === 'save_file');

    expect(saveFile?.description).toContain('保存');
    expect(saveFile?.inputSchema).toMatchObject({
      properties: {
        folderName: {
          description: expect.stringContaining('原理资料'),
        },
      },
    });
  });
});
