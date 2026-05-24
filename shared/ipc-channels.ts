export const IPC = {
  // LLM
  LLM_STREAM_CHUNK:   'llm:stream:chunk',
  LLM_STREAM_END:     'llm:stream:end',
  LLM_STREAM_ERROR:   'llm:stream:error',
  LLM_TOOL_CALL:      'llm:tool:call',
  LLM_TOOL_RESULT:    'llm:tool:result',
  LLM_ABORT:          'llm:abort',

  // Agent
  AGENT_CHAT:               'agent:chat',
  CHAT_RUN_EVENT:           'chat-run:event',
  AGENT_CONTEXT_STATUS:     'agent:context-status',
  CHAT_ATTACHMENT_PREPARE:  'chat-attachment:prepare',
  CHAT_ATTACHMENT_STATUS:   'chat-attachment:status',
  CHAT_ATTACHMENT_REMOVE:   'chat-attachment:remove',

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

  // DB — Node
  DB_NODE_GET:        'db:node:get',
  DB_NODE_COMPLETE:   'db:node:complete',

  // DB — Messages
  DB_MESSAGES_GET:    'db:messages:get',
  DB_MESSAGE_CREATE:  'db:message:create',
  DB_MESSAGE_UPDATE:  'db:message:update',
  DB_MESSAGE_DELETE:  'db:message:delete',
  DB_MESSAGE_EDIT_AND_TRUNCATE: 'db:message:edit-and-truncate',

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
  DB_MODEL_UPDATE:    'db:model:update',
  DB_MODEL_CLEAR_PROVIDER: 'db:model:clear-provider',
  MODEL_CAPABILITY_GET: 'model:capability:get',

  // Window controls (macOS frameless)
  WINDOW_MINIMIZE:    'window:minimize',
  WINDOW_MAXIMIZE:    'window:maximize',
  WINDOW_CLOSE:       'window:close',

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
  FS_COPY_TO_CLIPBOARD:'fs:copy-to-clipboard',
  FS_PASTE_CLIPBOARD: 'fs:paste-clipboard',
  FS_MOVE:            'fs:move',
  FS_IMPORT_PATHS:    'fs:import-paths',
  FS_START_DRAG_OUT:  'fs:start-drag-out',
  FS_OPEN_PATH:       'fs:open-path',
  FS_PICK_FILES:      'fs:pick-files',
  FS_READ_FILE_BINARY:'fs:read-file-binary',
  SHELL_OPEN_URL:     'shell:open-url',

  // App updates (semi-automatic: check version → notify → open download page)
  UPDATE_CHECK:       'update:check',

  // Source library
  SOURCE_LIST:        'source:list',
  SOURCE_IMPORT_URL:  'source:import-url',
  SOURCE_IMPORT_TEXT: 'source:import-text',
  SOURCE_IMPORT_FILE: 'source:import-file',
  SOURCE_RESOLVE:     'source:resolve',
  SOURCE_UPDATE:      'source:update',
  SOURCE_DELETE:      'source:delete',
  SOURCE_SEARCH:      'source:search',
  SOURCE_STATS:       'source:stats',
  SOURCE_REINDEX:     'source:reindex',
  SOURCE_EXERCISES:   'source:exercises',
  SOURCE_EXERCISE_REEXTRACT: 'source:exercise:reextract',
  SOURCE_EXERCISE_UPDATE:    'source:exercise:update',
  SOURCE_SEMANTIC_PROFILE_REBUILD: 'source:semantic-profile:rebuild',
  SOURCE_LINK_CANDIDATES: 'source-link:candidates',
  SOURCE_LINK_ADD:        'source-link:add',
  SOURCE_LINK_UPDATE:     'source-link:update',
  SOURCE_LINK_REMOVE:     'source-link:remove',

  // Storage management
  STORAGE_STATS:              'storage:stats',
  STORAGE_CLEANUP_ORPHANS:    'storage:cleanup-orphans',
  STORAGE_CLEAR_OCR_CACHE:    'storage:clear-ocr-cache',
  STORAGE_CLEAR_RUNTIME_CACHE:'storage:clear-runtime-cache',
  YTDLP_STATUS:              'ytdlp:status',
  YTDLP_INSTALL:             'ytdlp:install',
  WHISPER_STATUS:            'whisper:status',
  WHISPER_INSTALL:           'whisper:install',
  FFMPEG_STATUS:             'ffmpeg:status',

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

  // Provider model auto-fetch
  PROVIDER_FETCH_MODELS: 'provider:fetch-models',

  // DAG events (main → renderer push)
  DAG_GENERATED:         'dag:generated',

  // File events (main → renderer push)
  FILE_GENERATED:     'file:generated',
  FS_CHANGED:         'fs:changed',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
