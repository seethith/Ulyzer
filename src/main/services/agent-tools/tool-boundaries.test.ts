import { describe, expect, it } from 'vitest';
import { buildChatToolRegistry } from './chat-tools/registry';
import { buildDagToolRegistry } from './dag-tools/index';
import { buildTutorToolRegistry } from './tutor-tools/registry';
import { hasDeclaredToolPermission } from './tool-permissions';

describe('agent tool registry boundaries', () => {
  it('exposes user-facing node tutor tools without DAG mutation tools', () => {
    const registry = buildChatToolRegistry();

    expect(registry.names()).toEqual(expect.arrayContaining([
      'generate_theory',
      'generate_practice',
      'generate_outline',
      'generate_topic',
      'generate_feynman_checklist',
      'generate_mindmap',
      'generate_external_reference_index',
      'read_materials',
      'search_knowledge',
      'search_library',
      'read_source',
      'read_file',
      'list_node_files',
      'search_node_files',
      'list_markdown_headings',
      'read_markdown_section',
      'get_node_progress',
      'record_mistake',
      'append_to_notes',
      'update_file',
      'edit_markdown_file',
      'patch_markdown_file',
      'delete_node_item',
      'rename_node_item',
      'move_node_item',
      'copy_node_item',
      'create_file',
      'web_search',
      'search_videos',
    ]));

    expect(registry.names()).not.toEqual(expect.arrayContaining([
      'generate_dag',
      'add_node',
      'remove_node',
      'connect_nodes',
      'update_node',
    ]));
  });

  it('keeps material-writing helper tools internal to the material workflow', () => {
    const registry = buildTutorToolRegistry({
      targetFolder: 'practice',
      allowWebSearch: true,
      allowRagRetrieve: true,
      allowReadNodeMaterials: true,
    });

    expect(registry.names()).toEqual(expect.arrayContaining([
      'rag_retrieve',
      'web_search',
      'generate_quiz',
      'read_node_materials',
      'save_file',
    ]));

    expect(registry.names()).not.toEqual(expect.arrayContaining([
      'generate_theory',
      'generate_practice',
      'generate_dag',
      'add_node',
    ]));
  });

  it('trims material tools by folder and retrieval policy', () => {
    const theoryRegistry = buildTutorToolRegistry({
      targetFolder: 'theory',
      allowWebSearch: false,
      allowRagRetrieve: false,
      allowReadNodeMaterials: false,
    });
    expect(theoryRegistry.names()).toEqual(['save_file']);

    const answerRegistry = buildTutorToolRegistry({ targetFolder: 'answer' });
    expect(answerRegistry.names()).toEqual(['save_file']);

    const practiceRegistry = buildTutorToolRegistry({
      targetFolder: 'practice',
      allowWebSearch: true,
      allowRagRetrieve: false,
      allowReadNodeMaterials: false,
    });
    expect(practiceRegistry.names()).toEqual(expect.arrayContaining(['web_search', 'generate_quiz', 'save_file']));
    expect(practiceRegistry.names()).not.toContain('read_node_materials');

    const notesRegistry = buildTutorToolRegistry({ targetFolder: 'notes' });
    expect(notesRegistry.names()).toEqual(expect.arrayContaining(['create_file', 'save_file']));
  });

  it('exposes roadmap tools to the main tutor DAG loop', () => {
    const registry = buildDagToolRegistry();
    const toolNames = registry.names();

    expect(toolNames).toEqual(expect.arrayContaining([
      'read_roadmap',
      'generate_dag',
      'add_node',
      'batch_add_nodes',
      'remove_node',
      'connect_nodes',
      'update_node',
      'update_profile',
      'analyze_dag',
      'web_search',
      'search_library',
      'read_source',
    ]));

    expect(toolNames).not.toEqual(expect.arrayContaining([
      'generate_theory',
      'generate_practice',
      'save_file',
      'append_to_notes',
    ]));
  });

  it('applies centralized permissions for tool capabilities', () => {
    const chatRegistry = buildChatToolRegistry();
    const dagRegistry = buildDagToolRegistry();
    const tutorRegistry = buildTutorToolRegistry();

    expect(chatRegistry.get('read_file')?.permissions).toMatchObject({
      readOnly: true,
      canWriteFile: false,
    });
    expect(chatRegistry.get('list_node_files')?.permissions).toMatchObject({
      readOnly: true,
      canWriteFile: false,
    });
    expect(chatRegistry.get('search_node_files')?.permissions).toMatchObject({
      readOnly: true,
      canWriteFile: false,
    });
    expect(chatRegistry.get('read_markdown_section')?.permissions).toMatchObject({
      readOnly: true,
      canWriteFile: false,
    });
    expect(chatRegistry.get('append_to_notes')?.permissions).toMatchObject({
      readOnly: false,
      canWriteFile: true,
      canMutateDag: false,
    });
    expect(chatRegistry.get('update_file')?.permissions).toMatchObject({
      readOnly: false,
      canWriteFile: true,
      canMutateDag: false,
    });
    expect(chatRegistry.get('edit_markdown_file')?.permissions).toMatchObject({
      readOnly: false,
      canWriteFile: true,
      canMutateDag: false,
    });
    expect(chatRegistry.get('patch_markdown_file')?.permissions).toMatchObject({
      readOnly: false,
      canWriteFile: true,
      canMutateDag: false,
    });
    expect(chatRegistry.get('web_search')?.permissions).toMatchObject({
      readOnly: true,
      canUseWeb: true,
    });
    expect(dagRegistry.get('add_node')?.permissions).toMatchObject({
      readOnly: false,
      canMutateDag: true,
    });
    expect(dagRegistry.get('read_roadmap')?.permissions).toMatchObject({
      readOnly: true,
      canMutateDag: false,
    });
    expect(dagRegistry.get('batch_add_nodes')?.permissions).toMatchObject({
      readOnly: false,
      canMutateDag: true,
    });
    expect(tutorRegistry.get('save_file')?.permissions).toMatchObject({
      readOnly: false,
      canWriteFile: true,
      canMutateDag: false,
    });
  });

  it('declares permissions for every registered tool namespace entry', () => {
    const entries = [
      ...buildChatToolRegistry().list(),
      ...buildDagToolRegistry().list(),
      ...buildTutorToolRegistry().list(),
    ];

    for (const tool of entries) {
      expect(hasDeclaredToolPermission(tool.namespace, tool.name)).toBe(true);
    }
  });
});
