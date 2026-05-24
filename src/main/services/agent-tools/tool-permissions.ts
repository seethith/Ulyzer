import type { AgentToolNamespace, AgentToolPermissions } from './types';
import { DEFAULT_MAX_RESULT_CHARS } from './tool-policy';

type PermissionOverrides = Partial<Omit<AgentToolPermissions, 'maxResultChars'>> & {
  maxResultChars?: number;
};

const READ = {
  readOnly: true,
  canWriteFile: false,
  canMutateDag: false,
  canUseWeb: false,
} as const;

const WRITE_FILE = {
  readOnly: false,
  canWriteFile: true,
  canMutateDag: false,
  canUseWeb: false,
} as const;

const MUTATE_DAG = {
  readOnly: false,
  canWriteFile: false,
  canMutateDag: true,
  canUseWeb: false,
} as const;

const TOOL_PERMISSIONS: Record<AgentToolNamespace, Record<string, PermissionOverrides>> = {
  chat: {
    generate_theory:            WRITE_FILE,
    generate_practice:          WRITE_FILE,
    generate_outline:           { ...WRITE_FILE, maxResultChars: 3000 },
    generate_topic:             { ...WRITE_FILE, maxResultChars: 500 },
    generate_feynman_checklist: WRITE_FILE,
    generate_mindmap:           WRITE_FILE,
    generate_external_reference_index: { ...WRITE_FILE, canUseWeb: true, maxResultChars: 500 },
    read_materials:             { ...READ, maxResultChars: 6000 },
    search_knowledge:           READ,
    search_library:             READ,
    read_source:                { ...READ, maxResultChars: 8000 },
    read_file:                  READ,
    list_node_files:            { ...READ, maxResultChars: 6000 },
    search_node_files:          { ...READ, maxResultChars: 6000 },
    list_markdown_headings:     { ...READ, maxResultChars: 5000 },
    read_markdown_section:      { ...READ, maxResultChars: 20500 },
    get_node_progress:          READ,
    record_mistake:             WRITE_FILE,
    append_to_notes:            WRITE_FILE,
    update_file:                { ...WRITE_FILE, maxResultChars: 500 },
    edit_markdown_file:         { ...WRITE_FILE, maxResultChars: 700 },
    patch_markdown_file:        { ...WRITE_FILE, maxResultChars: 1000 },
    delete_node_item:           { ...WRITE_FILE, maxResultChars: 400 },
    rename_node_item:           { ...WRITE_FILE, maxResultChars: 400 },
    move_node_item:             { ...WRITE_FILE, maxResultChars: 400 },
    copy_node_item:             { ...WRITE_FILE, maxResultChars: 500 },
    create_file:                WRITE_FILE,
    web_search:                 { ...READ, canUseWeb: true, maxResultChars: 6000 },
    web_fetch:                  { ...READ, canUseWeb: true, maxResultChars: 8000 },
    search_videos:              { ...READ, canUseWeb: true, maxResultChars: 800 },
    write_todos:                { ...READ, maxResultChars: 400 },
    spawn_subtask:              { readOnly: false, canWriteFile: true, canMutateDag: false, canUseWeb: true, maxResultChars: 4000 },
  },
  dag: {
    read_roadmap:    { ...READ, maxResultChars: 12000 },
    write_todos:     { ...READ, maxResultChars: 400 },
    generate_dag:    MUTATE_DAG,
    add_node:        MUTATE_DAG,
    batch_add_nodes: MUTATE_DAG,
    remove_node:     MUTATE_DAG,
    connect_nodes:   MUTATE_DAG,
    update_node:     MUTATE_DAG,
    update_profile:  { ...MUTATE_DAG, canMutateDag: false },
    analyze_dag:     { ...READ, maxResultChars: 6000 },
    web_search:      { ...READ, canUseWeb: true, maxResultChars: 6000 },
    web_fetch:       { ...READ, canUseWeb: true, maxResultChars: 8000 },
    search_library:  READ,
    read_source:     { ...READ, maxResultChars: 8000 },
  },
  tutor: {
    rag_retrieve:        { ...READ, maxResultChars: 4000 },
    web_search:          { ...READ, canUseWeb: true, maxResultChars: 6000 },
    generate_quiz:       { ...READ, maxResultChars: 2600 },
    read_node_materials: { ...READ, maxResultChars: 4000 },
    save_file:           { ...WRITE_FILE, maxResultChars: 300 },
    create_file:         { ...WRITE_FILE, maxResultChars: 200 },
  },
};

export function resolveToolPermissions(
  namespace: AgentToolNamespace,
  name: string,
  fallback: PermissionOverrides = {},
): AgentToolPermissions {
  const declared = TOOL_PERMISSIONS[namespace][name];
  const readOnly = declared?.readOnly ?? fallback.readOnly ?? false;
  return {
    readOnly,
    canWriteFile: declared?.canWriteFile ?? fallback.canWriteFile ?? false,
    canMutateDag: declared?.canMutateDag ?? fallback.canMutateDag ?? false,
    canUseWeb: declared?.canUseWeb ?? fallback.canUseWeb ?? false,
    maxResultChars: declared?.maxResultChars ?? fallback.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  };
}

export function hasDeclaredToolPermission(namespace: AgentToolNamespace, name: string): boolean {
  return Object.hasOwn(TOOL_PERMISSIONS[namespace], name);
}
