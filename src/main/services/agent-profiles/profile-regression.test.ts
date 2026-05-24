import { describe, expect, it } from 'vitest';
import { mainTutorProfile } from './main-tutor.profile';
import { nodeTutorProfile } from './node-tutor.profile';

describe('agent profile regression boundaries', () => {
  it('keeps the main tutor scoped to roadmap planning and DAG mutation', () => {
    expect(mainTutorProfile.agentChannel).toBe('main_tutor');
    expect(mainTutorProfile.scope).toBe('course');
    expect(mainTutorProfile.allowedWorkflows).toEqual(['chat', 'route.generate']);

    expect(mainTutorProfile.defaultTools).toEqual(expect.arrayContaining([
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

    expect(mainTutorProfile.defaultTools).not.toEqual(expect.arrayContaining([
      'generate_theory',
      'generate_practice',
      'generate_outline',
      'create_file',
      'append_to_notes',
    ]));
    expect(mainTutorProfile.policyLayers).toEqual(expect.arrayContaining([
      'role',
      'modelIdentity',
      'language',
    ]));
    expect(mainTutorProfile.loopConfig).toEqual({ maxTurns: 20, hardMaxTurns: 40, maxTokens: 16_000 });
  });

  it('keeps the node tutor scoped to learning support and material workflows', () => {
    expect(nodeTutorProfile.agentChannel).toBe('sub_tutor');
    expect(nodeTutorProfile.scope).toBe('node');
    expect(nodeTutorProfile.allowedWorkflows).toEqual(expect.arrayContaining([
      'chat',
      'outline.generateNext',
      'material.generate',
      'topic.generate',
    ]));

    expect(nodeTutorProfile.defaultTools).toEqual(expect.arrayContaining([
      'generate_outline',
      'generate_theory',
      'generate_practice',
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
      'generate_topic',
      'search_videos',
    ]));

    expect(nodeTutorProfile.defaultTools).not.toEqual(expect.arrayContaining([
      'generate_dag',
      'add_node',
      'remove_node',
      'connect_nodes',
      'update_node',
    ]));
    expect(nodeTutorProfile.contextPacks).toEqual(expect.arrayContaining([
      'currentNode',
      'nodeHandoff',
      'studentMemory',
      'searchMode',
    ]));
    expect(nodeTutorProfile.policyLayers).toEqual(expect.arrayContaining([
      'role',
      'guidance',
      'toolRouting',
      'folderPolicy',
      'workflowRouting',
      'searchPolicy',
      'modelIdentity',
      'language',
    ]));
    expect(nodeTutorProfile.loopConfig).toEqual({
      maxTurns: 20,
      hardMaxTurns: 80,
      maxTokens: 16_000,
    });
  });
});
