export const IPC = {
  // LLM
  LLM_STREAM_START:   'llm:stream:start',
  LLM_STREAM_CHUNK:   'llm:stream:chunk',
  LLM_STREAM_END:     'llm:stream:end',
  LLM_STREAM_ERROR:   'llm:stream:error',
  LLM_ABORT:          'llm:abort',

  // Agent
  AGENT_PLAN:               'agent:plan',
  AGENT_CHAT:               'agent:chat',
  AGENT_GENERATE:           'agent:generate',
  AGENT_FEYNMAN_CHECKLIST:  'agent:feynman:checklist',
  AGENT_FEYNMAN_SUMMARY:    'agent:feynman:summary',

  // DAG
  DAG_GENERATE:       'dag:generate',
  DAG_UPDATE_NODE:    'dag:update-node',
  DAG_DELETE_NODE:    'dag:delete-node',
  DAG_ADD_NODE:       'dag:add-node',

  // DB — Course
  DB_COURSE_LIST:     'db:course:list',
  DB_COURSE_CREATE:   'db:course:create',
  DB_COURSE_UPDATE:   'db:course:update',
  DB_COURSE_DELETE:   'db:course:delete',

  // DB — DAG
  DB_DAG_GET:         'db:dag:get',
  DB_DAG_SAVE:        'db:dag:save',

  // DB — Session
  DB_SESSION_START:   'db:session:start',
  DB_SESSION_END:     'db:session:end',

  // DB — Files
  DB_FILES_GET:       'db:files:get',
  DB_FILE_CREATE:     'db:file:create',
  DB_FILE_UPDATE:     'db:file:update',

  // DB — Notebook
  DB_NOTEBOOK_GET:    'db:notebook:get',
  DB_NOTEBOOK_SAVE:   'db:notebook:save',

  // DB — Node
  DB_NODE_GET:        'db:node:get',
  DB_NODE_COMPLETE:   'db:node:complete',

  // DB — Messages
  DB_MESSAGES_GET:    'db:messages:get',
  DB_MESSAGE_CREATE:  'db:message:create',
  DB_MESSAGE_DELETE:  'db:message:delete',

  // DB — Chat threads
  DB_THREAD_LIST:     'db:thread:list',
  DB_THREAD_CREATE:   'db:thread:create',
  DB_THREAD_UPDATE:   'db:thread:update',
  DB_THREAD_DELETE:   'db:thread:delete',

  // DB — Providers
  DB_PROVIDER_LIST:   'db:provider:list',
  DB_PROVIDER_CREATE: 'db:provider:create',
  DB_PROVIDER_UPDATE: 'db:provider:update',
  DB_PROVIDER_DELETE: 'db:provider:delete',

  // DB — Provider models
  DB_MODEL_LIST:      'db:model:list',
  DB_MODEL_CREATE:    'db:model:create',
  DB_MODEL_DELETE:    'db:model:delete',

  // Window controls (macOS frameless)
  WINDOW_MINIMIZE:    'window:minimize',
  WINDOW_MAXIMIZE:    'window:maximize',
  WINDOW_CLOSE:       'window:close',

  // File System
  FILE_UPLOAD:        'file:upload',
  FILE_READ:          'file:read',
  FILE_INDEX_RAG:     'file:index-rag',

  // FS — content workspace
  FS_ENSURE_COURSE:   'fs:ensure-course',
  FS_ENSURE_NODE:     'fs:ensure-node',
  FS_LIST_NODE:       'fs:list-node',
  FS_READ_FILE:       'fs:read-file',
  FS_DELETE_FILE:     'fs:delete-file',
  FS_WRITE_FILE:      'fs:write-file',
  FS_CREATE_FILE:     'fs:create-file',
  FS_CREATE_FOLDER:   'fs:create-folder',
  FS_RENAME:          'fs:rename',
  FS_COPY_FILE:       'fs:copy-file',
  FS_OPEN_PATH:       'fs:open-path',
  FS_READ_FILE_BINARY:'fs:read-file-binary',
  SHELL_OPEN_URL:     'shell:open-url',

  // RAG
  RAG_INDEX:          'rag:index',
  RAG_RETRIEVE:       'rag:retrieve',

  // Settings
  SETTINGS_GET:        'settings:get',
  SETTINGS_SAVE:       'settings:save',
  SETTINGS_GET_KEY:    'settings:get-key',
  SETTINGS_SAVE_KEY:   'settings:save-key',
  SETTINGS_DELETE_KEY: 'settings:delete-key',

  // Web search
  WEB_SEARCH:         'web:search',
  WEB_SEARCH_VIDEO:   'web:search-video',

  // Agent Loop
  AGENT_CLARIFY:      'agent:clarify',

  // Outline version management
  OUTLINE_GET_STATUS:       'outline:get-status',
  OUTLINE_GENERATE_NEXT:    'outline:generate-next',

  // Topic (专题) generation
  TOPIC_GENERATE:           'topic:generate',

  // Provider model auto-fetch
  PROVIDER_FETCH_MODELS: 'provider:fetch-models',

  // DAG events (main → renderer push)
  DAG_GENERATED:      'dag:generated',

  // File events (main → renderer push)
  FILE_GENERATED:     'file:generated',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
