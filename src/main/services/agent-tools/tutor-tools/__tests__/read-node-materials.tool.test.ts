import { describe, expect, it, vi } from 'vitest';
import { FOLDER_KEYS } from '@shared/types';

vi.mock('../../../fs/content.service', () => ({
  getFolderPath: vi.fn(),
}));

import { readNodeMaterialsTool } from '../read-node-materials.tool';
import type { ToolContext } from '../index';

describe('read_node_materials folder input', () => {
  it('normalizes legacy localized folder names at the tool boundary', () => {
    expect(readNodeMaterialsTool.inputSchema.parse({ folderName: '原理资料' }).folderName).toBe('theory');
    expect(readNodeMaterialsTool.inputSchema.parse({ folderName: 'Theory' }).folderName).toBe('theory');
  });

  it('exposes only stable English folder keys in the LLM-facing schema', () => {
    const folderName = (readNodeMaterialsTool.inputJsonSchema.properties as Record<string, unknown>).folderName;
    expect(folderName).toMatchObject({ enum: [...FOLDER_KEYS] });
  });

  it('rejects arbitrary folder names instead of passing them to core file services', () => {
    expect(() => readNodeMaterialsTool.inputSchema.parse({ folderName: '随便的文件夹' })).toThrow();
  });

  it('does not read outline during material generation because the outline is already in context', async () => {
    const ctx = { courseId: 'course-1', nodeId: 'node-1' } as ToolContext;
    const result = await readNodeMaterialsTool.execute({ folderName: 'outline' }, ctx);
    expect(result.found).toBe(false);
    expect(result.content).toContain('纲要已在本轮资料生成上下文中提供');
  });
});
