import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';

// Inline migration so it works in both dev and production builds
const MIGRATION_001 = `
-- 用户设置（单行）
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  default_provider TEXT DEFAULT '',
  default_model TEXT DEFAULT '',
  monthly_budget_cny REAL DEFAULT 50.0,
  guidance_mode TEXT DEFAULT 'strict',
  force_review INTEGER DEFAULT 1,
  spaced_repetition INTEGER DEFAULT 1,
  font_size INTEGER DEFAULT 13,
  remember_layout INTEGER DEFAULT 1,
  background_image_enabled INTEGER DEFAULT 0,
  background_image_path TEXT DEFAULT '',
  background_image_opacity REAL DEFAULT 0.72,
  background_overlay_opacity REAL DEFAULT 0.38,
  background_image_fit TEXT DEFAULT 'cover',
  ocr_worker_count INTEGER DEFAULT 2,
  learning_search_depth TEXT DEFAULT 'standard',
  learning_search_max_queries INTEGER DEFAULT 4,
  learning_search_max_pages INTEGER DEFAULT 4,
  learning_search_auto_ingest INTEGER DEFAULT 1,
  learning_search_allow_community INTEGER DEFAULT 0,
  learning_search_use_exa INTEGER DEFAULT 1,
  learning_search_tavily_advanced INTEGER DEFAULT 0,
  youtube_proxy_url TEXT DEFAULT '',
  youtube_cookies_mode TEXT DEFAULT 'none',
  youtube_cookies_path TEXT DEFAULT '',
  youtube_cookies_profile TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'new',
  total_nodes INTEGER DEFAULT 0,
  done_nodes INTEGER DEFAULT 0,
  total_hours_est REAL DEFAULT 0,
  hours_spent REAL DEFAULT 0,
  total_token_used INTEGER DEFAULT 0,
  total_cost_cny REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dag_nodes (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chapter TEXT NOT NULL,
  chapter_order INTEGER DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT,
  node_type TEXT DEFAULT 'main',
  status TEXT DEFAULT 'locked',
  hours_est REAL DEFAULT 1.0,
  difficulty TEXT DEFAULT 'beginner',
  prerequisites TEXT DEFAULT '[]',
  required_tools TEXT DEFAULT '[]',
  required_cost TEXT DEFAULT '{}',
  position_x REAL DEFAULT 0,
  position_y REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dag_edges (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  phase INTEGER DEFAULT 2,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_seconds INTEGER DEFAULT 0,
  token_used INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  mastery_score REAL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  progress TEXT,
  attachments_json TEXT,
  agent TEXT,
  token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  file_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  is_locked INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  course_id TEXT REFERENCES courses(id),
  provider TEXT,
  model TEXT,
  source TEXT DEFAULT 'unknown',
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  input_cache_hit_tokens INTEGER DEFAULT 0,
  input_cache_miss_tokens INTEGER DEFAULT 0,
  usage_estimated INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dag_nodes_course ON dag_nodes(course_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_course ON dag_edges(course_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id);
CREATE INDEX IF NOT EXISTS idx_token_logs_course ON token_logs(course_id);
`;

let db: Database.Database | null = null;

const NODE_SOURCE_LINKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node_source_links (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  enabled INTEGER DEFAULT 1,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(node_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_node_source_links_node ON node_source_links(course_id, node_id);
CREATE INDEX IF NOT EXISTS idx_node_source_links_source ON node_source_links(source_id);
`;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function ensureNodeSourceLinksSchema(database: Database.Database = getDb()): void {
  database.exec(NODE_SOURCE_LINKS_SCHEMA_SQL);
  const columns = database.prepare('PRAGMA table_info(node_source_links)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'enabled')) {
    database.exec('ALTER TABLE node_source_links ADD COLUMN enabled INTEGER DEFAULT 1;');
  }
}

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'ulyzer.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  ensureNodeSourceLinksSchema(db);
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      ran_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const hasColumn = (table: string, column: string): boolean => {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  };

  const addColumnIfMissing = (table: string, column: string, definition: string): string => (
    hasColumn(table, column) ? '' : `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`
  );

  const MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS file_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_file_chunks_node ON file_chunks(node_id);
CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  node_id UNINDEXED,
  tokenize="unicode61 remove_diacritics 1"
);
`;

  const MIGRATION_003 = `
ALTER TABLE messages ADD COLUMN node_id TEXT REFERENCES dag_nodes(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_messages_node ON messages(node_id);
`;

  // Recreate file_chunks without FK constraint on file_id + add source_name column.
  // SQLite cannot DROP CONSTRAINT, so we rename → copy → drop → rename back.
  const MIGRATION_004 = `
PRAGMA foreign_keys = OFF;
CREATE TABLE file_chunks_new (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  source_name TEXT DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO file_chunks_new (id, file_id, node_id, course_id, chunk_index, content, created_at)
  SELECT id, file_id, node_id, course_id, chunk_index, content, created_at FROM file_chunks;
DROP TABLE file_chunks;
ALTER TABLE file_chunks_new RENAME TO file_chunks;
CREATE INDEX IF NOT EXISTS idx_file_chunks_node ON file_chunks(node_id);
PRAGMA foreign_keys = ON;
`;

  const MIGRATION_005 = `
CREATE TABLE IF NOT EXISTS mastery_checklist (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  concept TEXT NOT NULL,
  verification_question TEXT NOT NULL,
  required INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mastery_checklist_node ON mastery_checklist(node_id);
`;

  const MIGRATION_006 = `
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  title TEXT DEFAULT 'New Chat',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_lookup ON chat_threads(course_id, agent, deleted);
ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
INSERT OR IGNORE INTO chat_threads (id, course_id, node_id, agent, title, created_at, updated_at)
  SELECT
    course_id || '::' || COALESCE(agent, 'main_tutor') || '::' || COALESCE(node_id, ''),
    course_id,
    node_id,
    COALESCE(agent, 'main_tutor'),
    '历史对话',
    MIN(created_at),
    MAX(created_at)
  FROM messages
  WHERE course_id IS NOT NULL
  GROUP BY course_id, node_id, COALESCE(agent, 'main_tutor');
UPDATE messages
  SET thread_id = course_id || '::' || COALESCE(agent, 'main_tutor') || '::' || COALESCE(node_id, '')
  WHERE thread_id IS NULL AND course_id IS NOT NULL;
`;

  const MIGRATION_007 = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT,
  api_key_name TEXT,
  is_builtin INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  tag TEXT DEFAULT '',
  is_builtin INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO providers (id, name, type, base_url, api_key_name, is_builtin) VALUES
  ('anthropic',  'Anthropic (Claude)',   'anthropic',    NULL,                                                           'anthropic',  1),
  ('openai',     'OpenAI (GPT)',         'openai_compat', NULL,                                                          'openai',     1),
  ('gemini',     'Google (Gemini)',      'openai_compat', 'https://generativelanguage.googleapis.com/v1beta/openai',     'gemini',     1),
  ('grok',       'xAI (Grok)',           'openai_compat', 'https://api.x.ai/v1',                                         'grok',       1),
  ('openrouter', 'OpenRouter',           'openai_compat', 'https://openrouter.ai/api/v1',                                'openrouter', 1),
  ('deepseek',   'DeepSeek',             'openai_compat', 'https://api.deepseek.com',                                    'deepseek',   1),
  ('qwen',       'Alibaba (Qwen)',       'openai_compat', 'https://dashscope.aliyuncs.com/compatible-mode/v1',           'qwen',       1),
  ('minimax',    'MiniMax',              'openai_compat', 'https://api.minimax.chat/v1',                                 'minimax',    1),
  ('ollama',     'Ollama (本地)',         'ollama',        'http://localhost:11434',                                      NULL,         1);
`;

  const migrations: Array<{ name: string; sql: string | (() => string) }> = [
    { name: '001_init',               sql: MIGRATION_001 },
    { name: '002_rag',                sql: MIGRATION_002 },
    { name: '003_msg_node',           sql: MIGRATION_003 },
    { name: '004_rag_fix',            sql: MIGRATION_004 },
    { name: '005_mastery_checklist',  sql: MIGRATION_005 },
    { name: '006_chat_threads',       sql: MIGRATION_006 },
    { name: '007_providers',          sql: MIGRATION_007 },
    { name: '008_theme',              sql: `ALTER TABLE settings ADD COLUMN theme TEXT DEFAULT 'warm'` },
    { name: '009_course_profile',     sql: `
ALTER TABLE courses ADD COLUMN goal_text TEXT;
ALTER TABLE courses ADD COLUMN current_level TEXT;
ALTER TABLE courses ADD COLUMN time_budget TEXT;
ALTER TABLE courses ADD COLUMN background TEXT;
ALTER TABLE courses ADD COLUMN profile_updated_at TEXT;
` },
    { name: '010_bloom_fields', sql: `
ALTER TABLE dag_nodes ADD COLUMN bloom_target TEXT;
ALTER TABLE dag_nodes ADD COLUMN learning_type TEXT;
ALTER TABLE dag_nodes ADD COLUMN priority TEXT;
` },
    { name: '011_profile_v2', sql: `
ALTER TABLE courses ADD COLUMN known_topics TEXT;
ALTER TABLE courses ADD COLUMN depth_preference TEXT;
` },
    { name: '012_more_providers', sql: `
INSERT OR IGNORE INTO providers (id, name, type, base_url, api_key_name, is_builtin) VALUES
  ('mistral',    'Mistral AI',          'openai_compat', 'https://api.mistral.ai/v1',                          'mistral',    1),
  ('groq',       'Groq',                'openai_compat', 'https://api.groq.com/openai/v1',                     'groq',       1),
  ('together',   'Together AI',         'openai_compat', 'https://api.together.xyz/v1',                        'together',   1),
  ('moonshot',   'Moonshot (Kimi)',      'openai_compat', 'https://api.moonshot.cn/v1',                         'moonshot',   1),
  ('zhipu',      'Zhipu AI (GLM)',       'openai_compat', 'https://open.bigmodel.cn/api/paas/v4',               'zhipu',      1),
  ('doubao',     'ByteDance (Doubao)',   'openai_compat', 'https://ark.volcengine.com/api/v3',                  'doubao',     1),
  ('perplexity', 'Perplexity',          'openai_compat', 'https://api.perplexity.ai',                          'perplexity', 1),
  ('cohere',     'Cohere',              'openai_compat', 'https://api.cohere.com/compatibility/v1',            'cohere',     1);

SELECT 1;
` },
    { name: '013_source_library', sql: `
CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  thread_id TEXT,
  session_id TEXT,
  scope TEXT NOT NULL DEFAULT 'course_shared',
  usage TEXT NOT NULL DEFAULT 'handoff_selected',
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  remark TEXT,
  url TEXT,
  original_path TEXT,
  file_path TEXT,
  media_type TEXT,
  host TEXT,
  trust_score REAL DEFAULT 0.5,
  enabled INTEGER DEFAULT 1,
  hit_count INTEGER DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_records_course ON source_records(course_id, enabled);
CREATE INDEX IF NOT EXISTS idx_source_records_node ON source_records(node_id, enabled);
CREATE INDEX IF NOT EXISTS idx_source_records_thread ON source_records(thread_id);
CREATE INDEX IF NOT EXISTS idx_source_records_scope ON source_records(course_id, scope, enabled);

CREATE TABLE IF NOT EXISTS source_distribution (
  id TEXT PRIMARY KEY,
  distribution_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE CASCADE,
  distribution_type TEXT NOT NULL,
  distribution_reason TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_distribution_source ON source_distribution(source_id, distribution_type);
CREATE INDEX IF NOT EXISTS idx_source_distribution_course ON source_distribution(course_id, distribution_type);

CREATE TABLE IF NOT EXISTS source_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  node_id TEXT,
  chunk_index INTEGER NOT NULL,
  locator TEXT,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_course ON source_chunks(course_id);
CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  source_id UNINDEXED,
  course_id UNINDEXED,
  node_id UNINDEXED,
  tokenize="unicode61 remove_diacritics 1"
);
` },
    { name: '014_dag_node_sources', sql: `
ALTER TABLE dag_nodes ADD COLUMN source_ids TEXT DEFAULT '[]';
ALTER TABLE dag_nodes ADD COLUMN rationale TEXT;
` },
    { name: '015_source_semantic_index', sql: `
CREATE TABLE IF NOT EXISTS source_document_meta (
  source_id TEXT PRIMARY KEY REFERENCES source_records(id) ON DELETE CASCADE,
  language TEXT,
  parser_version TEXT DEFAULT 'v2',
  content_hash TEXT,
  chunk_count INTEGER DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending',
  processing_state TEXT DEFAULT 'ready',
  last_indexed_at TEXT,
  processing_error TEXT,
  error TEXT
);
ALTER TABLE source_chunks ADD COLUMN heading_path TEXT;
ALTER TABLE source_chunks ADD COLUMN page INTEGER;
ALTER TABLE source_chunks ADD COLUMN char_start INTEGER;
ALTER TABLE source_chunks ADD COLUMN char_end INTEGER;
ALTER TABLE source_chunks ADD COLUMN token_count INTEGER;
CREATE TABLE IF NOT EXISTS source_chunk_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES source_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_chunk_embeddings_model ON source_chunk_embeddings(model);

CREATE TABLE IF NOT EXISTS node_handoffs (
  node_id TEXT PRIMARY KEY REFERENCES dag_nodes(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  task_definition TEXT,
  scope_boundary TEXT,
  rationale TEXT,
  recommended_source_ids TEXT DEFAULT '[]',
  suggested_queries TEXT DEFAULT '[]',
  generation_constraints TEXT DEFAULT '[]',
  coverage_requirements TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_handoffs_course ON node_handoffs(course_id);
` },
    { name: '016_library_scopes_handoffs', sql: () => `
${addColumnIfMissing('source_records', 'scope', "TEXT NOT NULL DEFAULT 'course_shared'")}
${addColumnIfMissing('source_records', 'usage', "TEXT NOT NULL DEFAULT 'handoff_selected'")}
CREATE INDEX IF NOT EXISTS idx_source_records_scope ON source_records(course_id, scope, enabled);
CREATE TABLE IF NOT EXISTS node_handoffs (
  node_id TEXT PRIMARY KEY REFERENCES dag_nodes(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  task_definition TEXT,
  scope_boundary TEXT,
  rationale TEXT,
  recommended_source_ids TEXT DEFAULT '[]',
  suggested_queries TEXT DEFAULT '[]',
  generation_constraints TEXT DEFAULT '[]',
  coverage_requirements TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_handoffs_course ON node_handoffs(course_id);
UPDATE source_records
SET scope = CASE
  WHEN node_id IS NOT NULL THEN 'node_private'
  ELSE 'course_shared'
END
WHERE scope IS NULL OR scope = '';
UPDATE source_records
SET usage = CASE
  WHEN kind = 'generated' AND node_id IS NOT NULL THEN 'node_local'
  WHEN node_id IS NOT NULL THEN 'node_local'
  ELSE 'handoff_selected'
END
WHERE usage IS NULL OR usage = '';
` },
    { name: '017_library_assets_usage', sql: () => `
${addColumnIfMissing('source_records', 'media_type', 'TEXT')}
${addColumnIfMissing('source_records', 'hit_count', 'INTEGER DEFAULT 0')}
${addColumnIfMissing('source_records', 'last_hit_at', 'TEXT')}
` },
    { name: '018_source_distribution', sql: `
CREATE TABLE IF NOT EXISTS source_distribution (
  id TEXT PRIMARY KEY,
  distribution_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE CASCADE,
  distribution_type TEXT NOT NULL,
  distribution_reason TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_distribution_source ON source_distribution(source_id, distribution_type);
CREATE INDEX IF NOT EXISTS idx_source_distribution_course ON source_distribution(course_id, distribution_type);
` },
    { name: '019_gemini_model_expansion', sql: `
SELECT 1;
` },
    { name: '020_source_processing_error', sql: () => `
${addColumnIfMissing('source_document_meta', 'processing_error', 'TEXT')}
` },
    { name: '021_source_processing_state', sql: () => `
${addColumnIfMissing('source_document_meta', 'processing_state', "TEXT DEFAULT 'ready'")}
UPDATE source_document_meta SET processing_state = 'ready' WHERE processing_state IS NULL;
` },
    { name: '022_source_remark', sql: () => `
${addColumnIfMissing('source_records', 'remark', 'TEXT')}
` },
    { name: '023_source_original_path', sql: () => `
${addColumnIfMissing('source_records', 'original_path', 'TEXT')}
` },
    { name: '024_source_scope_transfer_only', sql: `
UPDATE source_records
SET
  scope = 'course_shared',
  usage = 'handoff_selected'
WHERE id IN (
  SELECT source_id
  FROM source_distribution
  WHERE distribution_type = 'course_shared'
)
AND scope = 'main_private';

DELETE FROM source_distribution
WHERE distribution_type = 'course_shared';
` },
    { name: '025_model_metadata', sql: () => `
${addColumnIfMissing('provider_models', 'source', "TEXT DEFAULT 'builtin'")}
${addColumnIfMissing('provider_models', 'context_window', 'INTEGER')}
${addColumnIfMissing('provider_models', 'max_output_tokens', 'INTEGER')}
${addColumnIfMissing('provider_models', 'input_price', 'REAL')}
${addColumnIfMissing('provider_models', 'output_price', 'REAL')}
${addColumnIfMissing('provider_models', 'supports_vision', 'INTEGER')}
${addColumnIfMissing('provider_models', 'supports_pdf', 'INTEGER')}
${addColumnIfMissing('provider_models', 'supports_tools', 'INTEGER')}
${addColumnIfMissing('provider_models', 'supports_reasoning', 'INTEGER')}
${addColumnIfMissing('provider_models', 'raw_metadata_json', 'TEXT')}
${addColumnIfMissing('provider_models', 'capability_overrides_json', 'TEXT')}
${addColumnIfMissing('provider_models', 'last_seen_at', 'TEXT')}
UPDATE provider_models
SET source = CASE WHEN is_builtin = 1 THEN 'builtin' ELSE 'user' END
WHERE source IS NULL OR source = '';
` },
    { name: '026_remove_builtin_models', sql: `
DELETE FROM provider_models WHERE is_builtin = 1 OR source = 'builtin';
UPDATE settings
SET default_provider = '', default_model = '', updated_at = datetime('now')
WHERE default_model <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM provider_models
    WHERE provider_id = settings.default_provider
      AND model_id = settings.default_model
  );
` },
    { name: '027_message_progress', sql: () => `
${addColumnIfMissing('messages', 'progress', 'TEXT')}
` },
    { name: '028_model_capability_cache', sql: `
CREATE TABLE IF NOT EXISTS model_capability_cache (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'models.dev',
  source_provider_id TEXT,
  raw_json TEXT NOT NULL,
  input_modalities TEXT DEFAULT '[]',
  output_modalities TEXT DEFAULT '[]',
  context_window INTEGER,
  max_output_tokens INTEGER,
  input_price REAL,
  output_price REAL,
  supports_tools INTEGER,
  supports_json INTEGER,
  supports_reasoning INTEGER,
  fetched_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (provider_id, model_id, source)
);
CREATE INDEX IF NOT EXISTS idx_model_capability_cache_fetched ON model_capability_cache(source, fetched_at);
` },
    { name: '029_document_assets', sql: `
CREATE TABLE IF NOT EXISTS source_document_units (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  unit_index INTEGER NOT NULL,
  unit_type TEXT NOT NULL,
  locator TEXT NOT NULL,
  title TEXT,
  page_number INTEGER,
  text TEXT,
  char_count INTEGER DEFAULT 0,
  ocr_state TEXT DEFAULT 'not_required',
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_document_units_source ON source_document_units(source_id, unit_index);
CREATE INDEX IF NOT EXISTS idx_source_document_units_course ON source_document_units(course_id, unit_type);
CREATE INDEX IF NOT EXISTS idx_source_document_units_page ON source_document_units(source_id, page_number);

CREATE TABLE IF NOT EXISTS source_document_blocks (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES source_document_units(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  block_index INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  locator TEXT NOT NULL,
  heading_path TEXT,
  page_number INTEGER,
  text TEXT NOT NULL,
  metadata_json TEXT DEFAULT '{}',
  char_start INTEGER,
  char_end INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_document_blocks_source ON source_document_blocks(source_id, page_number, block_index);
CREATE INDEX IF NOT EXISTS idx_source_document_blocks_unit ON source_document_blocks(unit_id, block_index);
CREATE INDEX IF NOT EXISTS idx_source_document_blocks_course ON source_document_blocks(course_id, block_type);

CREATE TABLE IF NOT EXISTS source_processing_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  progress_current INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  error TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_processing_jobs_source ON source_processing_jobs(source_id, job_type, state);
CREATE INDEX IF NOT EXISTS idx_source_processing_jobs_course ON source_processing_jobs(course_id, state, created_at);
` },
    { name: '030_source_chunk_document_links', sql: () => `
${addColumnIfMissing('source_chunks', 'document_unit_id', 'TEXT')}
${addColumnIfMissing('source_chunks', 'document_unit_index', 'INTEGER')}
CREATE INDEX IF NOT EXISTS idx_source_chunks_document_unit ON source_chunks(source_id, document_unit_index);
CREATE INDEX IF NOT EXISTS idx_source_chunks_page ON source_chunks(source_id, page);
` },
    { name: '031_document_page_assets', sql: `
CREATE TABLE IF NOT EXISTS source_document_page_assets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  unit_id TEXT REFERENCES source_document_units(id) ON DELETE SET NULL,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  page_number INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, page_number, asset_type)
);
  CREATE INDEX IF NOT EXISTS idx_source_document_page_assets_source ON source_document_page_assets(source_id, page_number);
  CREATE INDEX IF NOT EXISTS idx_source_document_page_assets_course ON source_document_page_assets(course_id, asset_type);
  ` },
    { name: '032_ocr_worker_count', sql: () => `
  ${addColumnIfMissing('settings', 'ocr_worker_count', 'INTEGER DEFAULT 2')}
  UPDATE settings
  SET ocr_worker_count = 2
  WHERE ocr_worker_count IS NULL OR ocr_worker_count < 1 OR ocr_worker_count > 4;
  ` },
    { name: '033_source_thread_ownership', sql: () => `
  ${addColumnIfMissing('source_records', 'thread_id', 'TEXT')}
  ${addColumnIfMissing('source_records', 'session_id', 'TEXT')}
  CREATE INDEX IF NOT EXISTS idx_source_records_thread ON source_records(thread_id);
  ` },
    { name: '034_message_attachments', sql: () => `
  ${addColumnIfMissing('messages', 'attachments_json', 'TEXT')}
  ` },
    { name: '035_storage_cleanup_queue', sql: `
CREATE TABLE IF NOT EXISTS storage_cleanup_queue (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_type TEXT,
  owner_id TEXT,
  reason TEXT,
  attempts INTEGER DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_queue_state ON storage_cleanup_queue(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_queue_path ON storage_cleanup_queue(path);
` },
	    { name: '036_node_source_links', sql: `
	${NODE_SOURCE_LINKS_SCHEMA_SQL}

UPDATE source_records
SET scope = 'main_private',
    usage = CASE WHEN usage = 'handoff_selected' THEN 'planning_only' ELSE usage END,
    node_id = NULL
WHERE scope = 'course_shared';

	DELETE FROM source_distribution
	WHERE distribution_type = 'course_shared';
	` },
	    { name: '037_source_origin_contextual_retrieval', sql: () => `
	${addColumnIfMissing('source_records', 'origin', "TEXT DEFAULT 'user_import'")}
	UPDATE source_records
	SET origin = CASE
	  WHEN kind = 'generated' THEN 'ai_generated'
	  WHEN kind = 'web' THEN 'web_collected'
	  WHEN remark = '对话附件' OR thread_id IS NOT NULL OR session_id IS NOT NULL THEN 'chat_attachment'
	  ELSE 'user_import'
	END
	WHERE origin IS NULL OR origin = '';
	CREATE INDEX IF NOT EXISTS idx_source_records_origin ON source_records(course_id, origin, enabled);

	${addColumnIfMissing('source_chunks', 'indexed_content', 'TEXT')}
	UPDATE source_chunks
	SET indexed_content = content
	WHERE indexed_content IS NULL OR indexed_content = '';
	DELETE FROM source_chunks_fts;
	INSERT INTO source_chunks_fts (content, chunk_id, source_id, course_id, node_id)
	  SELECT COALESCE(indexed_content, content), id, source_id, course_id, node_id
	  FROM source_chunks;

	CREATE TABLE IF NOT EXISTS source_rerank_cache (
	  id TEXT PRIMARY KEY,
	  query_hash TEXT NOT NULL,
	  chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE CASCADE,
	  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
	  task_type TEXT NOT NULL,
	  provider TEXT,
	  model TEXT,
	  relevance REAL NOT NULL,
	  reason TEXT,
	  created_at TEXT DEFAULT (datetime('now')),
	  UNIQUE(query_hash, chunk_id, task_type, provider, model)
	);
	CREATE INDEX IF NOT EXISTS idx_source_rerank_cache_lookup ON source_rerank_cache(query_hash, task_type, provider, model);

	CREATE TABLE IF NOT EXISTS source_document_summaries (
	  source_id TEXT PRIMARY KEY REFERENCES source_records(id) ON DELETE CASCADE,
	  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
	  content_hash TEXT,
	  overview TEXT,
	  outline_json TEXT DEFAULT '[]',
	  key_concepts_json TEXT DEFAULT '[]',
	  practice_index_json TEXT DEFAULT '[]',
	  route_hints_json TEXT DEFAULT '[]',
	  summary_json TEXT DEFAULT '{}',
	  created_at TEXT DEFAULT (datetime('now')),
	  updated_at TEXT DEFAULT (datetime('now'))
	);
		CREATE INDEX IF NOT EXISTS idx_source_document_summaries_course ON source_document_summaries(course_id, updated_at);
		` },
	    { name: '038_youtube_proxy_url', sql: () => `
	  ${addColumnIfMissing('settings', 'youtube_proxy_url', "TEXT DEFAULT ''")}
	  ` },
    { name: '039_youtube_cookies_settings', sql: () => `
  ${addColumnIfMissing('settings', 'youtube_cookies_mode', "TEXT DEFAULT 'none'")}
  ${addColumnIfMissing('settings', 'youtube_cookies_path', "TEXT DEFAULT ''")}
  UPDATE settings
  SET youtube_cookies_mode = 'none'
  WHERE youtube_cookies_mode IS NULL OR youtube_cookies_mode NOT IN ('none', 'safari', 'chrome', 'firefox', 'edge', 'brave', 'cookies_file');
  ` },
	    { name: '040_youtube_cookies_profile', sql: () => `
	  ${addColumnIfMissing('settings', 'youtube_cookies_profile', "TEXT DEFAULT ''")}
	  ` },
    { name: '041_source_semantic_profiles', sql: `
CREATE TABLE IF NOT EXISTS source_semantic_profiles (
  source_id TEXT PRIMARY KEY REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  concepts_json TEXT DEFAULT '[]',
  suitable_for_json TEXT DEFAULT '[]',
  difficulty TEXT,
  content_types_json TEXT DEFAULT '[]',
  quality_notes TEXT,
  node_hints_json TEXT DEFAULT '[]',
  model TEXT,
  content_hash TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_semantic_profiles_course ON source_semantic_profiles(course_id, status, updated_at);
` },
    { name: '042_learning_source_search', sql: `
CREATE TABLE IF NOT EXISTS learning_source_plans (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT,
  task_type TEXT NOT NULL,
  user_goal TEXT NOT NULL,
  learning_shape TEXT NOT NULL,
  planning_rationale TEXT,
  slots_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_learning_source_plans_course ON learning_source_plans(course_id, created_at);

CREATE TABLE IF NOT EXISTS source_learning_metadata (
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  slot_name TEXT,
  source_type TEXT DEFAULT 'unknown',
  quality_score REAL DEFAULT 0,
  why_useful TEXT,
  limitations TEXT,
  main_evidence INTEGER DEFAULT 0,
  ingest_policy TEXT,
  plan_id TEXT REFERENCES learning_source_plans(id) ON DELETE SET NULL,
  query TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_source_learning_metadata_course ON source_learning_metadata(course_id, slot_id, quality_score);
` },
    { name: '043_learning_search_settings', sql: () => `
  ${addColumnIfMissing('settings', 'learning_search_depth', "TEXT DEFAULT 'standard'")}
  ${addColumnIfMissing('settings', 'learning_search_max_queries', 'INTEGER DEFAULT 4')}
  ${addColumnIfMissing('settings', 'learning_search_max_pages', 'INTEGER DEFAULT 4')}
  ${addColumnIfMissing('settings', 'learning_search_auto_ingest', 'INTEGER DEFAULT 1')}
  ${addColumnIfMissing('settings', 'learning_search_allow_community', 'INTEGER DEFAULT 0')}
  ${addColumnIfMissing('settings', 'learning_search_use_exa', 'INTEGER DEFAULT 1')}
  ${addColumnIfMissing('settings', 'learning_search_tavily_advanced', 'INTEGER DEFAULT 0')}
  UPDATE settings
  SET learning_search_depth = 'standard'
  WHERE learning_search_depth IS NULL OR learning_search_depth NOT IN ('economy', 'standard', 'deep');
  UPDATE settings
  SET learning_search_max_queries = 4
  WHERE learning_search_max_queries IS NULL OR learning_search_max_queries < 1 OR learning_search_max_queries > 8;
  UPDATE settings
  SET learning_search_max_pages = 4
  WHERE learning_search_max_pages IS NULL OR learning_search_max_pages < 1 OR learning_search_max_pages > 8;
  UPDATE settings
  SET learning_search_auto_ingest = CASE WHEN learning_search_auto_ingest = 0 THEN 0 ELSE 1 END,
      learning_search_allow_community = CASE WHEN learning_search_allow_community = 1 THEN 1 ELSE 0 END,
      learning_search_use_exa = CASE WHEN learning_search_use_exa = 0 THEN 0 ELSE 1 END,
      learning_search_tavily_advanced = CASE WHEN learning_search_tavily_advanced = 1 THEN 1 ELSE 0 END;
  ` },
    { name: '044_drop_legacy_source_distribution', sql: `
UPDATE source_records
SET scope = 'main_private',
    usage = CASE WHEN usage = 'handoff_selected' THEN 'planning_only' ELSE usage END,
    node_id = NULL
WHERE scope = 'course_shared';

DROP TABLE IF EXISTS source_distribution;
` },
    { name: '045_thread_contexts_usage_indexes', sql: () => `
CREATE TABLE IF NOT EXISTS chat_thread_contexts (
  thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  covered_message_id TEXT,
  covered_message_created_at TEXT,
  important_facts_json TEXT NOT NULL DEFAULT '[]',
  user_preferences_json TEXT NOT NULL DEFAULT '[]',
  open_loops_json TEXT NOT NULL DEFAULT '[]',
  artifact_history_json TEXT NOT NULL DEFAULT '[]',
  summary_token_count INTEGER DEFAULT 0,
  raw_message_count INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_thread_contexts_course ON chat_thread_contexts(course_id, agent, updated_at);
CREATE INDEX IF NOT EXISTS idx_token_logs_session ON token_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_logs_course_created ON token_logs(course_id, created_at);
${addColumnIfMissing('messages', 'token_count', 'INTEGER DEFAULT 0')}
` },
    { name: '046_context_projection_collapse', sql: () => `
CREATE TABLE IF NOT EXISTS chat_context_collapses (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_message_id TEXT,
  to_message_id TEXT,
  replacement_text TEXT NOT NULL,
  source_entry_ids_json TEXT NOT NULL DEFAULT '[]',
  instruction TEXT,
  token_before INTEGER DEFAULT 0,
  token_after INTEGER DEFAULT 0,
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_context_collapses_thread ON chat_context_collapses(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_context_collapses_kind ON chat_context_collapses(thread_id, kind, created_at);

CREATE TABLE IF NOT EXISTS chat_context_snapshots (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  agent TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  context_window INTEGER DEFAULT 0,
  max_output_tokens INTEGER DEFAULT 0,
  input_budget INTEGER DEFAULT 0,
  estimated_input_tokens INTEGER DEFAULT 0,
  estimated_total_tokens INTEGER DEFAULT 0,
  raw_transcript_tokens INTEGER DEFAULT 0,
  projected_tokens INTEGER DEFAULT 0,
  token_before_projection INTEGER DEFAULT 0,
  token_after_projection INTEGER DEFAULT 0,
  collapse_savings INTEGER DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'low',
  live_message_count INTEGER DEFAULT 0,
  checkpoint_count INTEGER DEFAULT 0,
  summary_tokens INTEGER DEFAULT 0,
  micro_compacted_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_context_snapshots_thread ON chat_context_snapshots(thread_id, created_at);

CREATE TABLE IF NOT EXISTS llm_usage_estimates (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  course_id TEXT,
  thread_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  estimated_input_tokens INTEGER DEFAULT 0,
  actual_input_tokens INTEGER,
  estimated_output_tokens INTEGER DEFAULT 0,
  actual_output_tokens INTEGER,
  estimate_ratio REAL,
  source TEXT NOT NULL DEFAULT 'context_projection',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_estimates_model ON llm_usage_estimates(provider, model, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_estimates_session ON llm_usage_estimates(session_id, created_at);
` },
    { name: '047_token_log_sources', sql: () => `
${addColumnIfMissing('token_logs', 'source', "TEXT DEFAULT 'unknown'")}
CREATE INDEX IF NOT EXISTS idx_token_logs_source ON token_logs(source, created_at);
` },
    { name: '048_agent_context_entries', sql: `
CREATE TABLE IF NOT EXISTS agent_context_entries (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_context_entries_scope
  ON agent_context_entries(course_id, agent, node_id, thread_id, active, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_context_entries_kind
  ON agent_context_entries(course_id, agent, kind, active, created_at);
` },
    { name: '049_token_log_cache_usage', sql: () => `
${addColumnIfMissing('token_logs', 'input_cache_hit_tokens', 'INTEGER DEFAULT 0')}
${addColumnIfMissing('token_logs', 'input_cache_miss_tokens', 'INTEGER DEFAULT 0')}
${addColumnIfMissing('token_logs', 'usage_estimated', 'INTEGER DEFAULT 0')}
UPDATE token_logs
   SET input_cache_hit_tokens = COALESCE(input_cache_hit_tokens, 0),
       input_cache_miss_tokens = COALESCE(input_cache_miss_tokens, 0),
       usage_estimated = COALESCE(usage_estimated, 0);
UPDATE token_logs
   SET input_cache_miss_tokens = COALESCE(input_tokens, 0)
 WHERE lower(COALESCE(provider, '')) = 'deepseek'
   AND model IN ('deepseek-v4-flash', 'deepseek-v4-pro')
   AND COALESCE(input_tokens, 0) > 0
   AND COALESCE(input_cache_hit_tokens, 0) = 0
   AND COALESCE(input_cache_miss_tokens, 0) = 0;
UPDATE token_logs
   SET cost_cny = CASE model
     WHEN 'deepseek-v4-flash' THEN
       (COALESCE(input_cache_miss_tokens, COALESCE(input_tokens, 0)) / 1000.0) * 0.001 +
       (COALESCE(input_cache_hit_tokens, 0) / 1000.0) * 0.00002 +
       (COALESCE(output_tokens, 0) / 1000.0) * 0.002
     WHEN 'deepseek-v4-pro' THEN
       (COALESCE(input_cache_miss_tokens, COALESCE(input_tokens, 0)) / 1000.0) * 0.003 +
       (COALESCE(input_cache_hit_tokens, 0) / 1000.0) * 0.000025 +
       (COALESCE(output_tokens, 0) / 1000.0) * 0.006
     ELSE cost_cny
   END
 WHERE lower(COALESCE(provider, '')) = 'deepseek'
   AND model IN ('deepseek-v4-flash', 'deepseek-v4-pro');
UPDATE courses
   SET total_token_used = COALESCE((
         SELECT SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))
           FROM token_logs
          WHERE token_logs.course_id = courses.id
       ), 0),
       total_cost_cny = COALESCE((
         SELECT SUM(COALESCE(cost_cny, 0))
           FROM token_logs
          WHERE token_logs.course_id = courses.id
       ), 0),
       updated_at = datetime('now')
 WHERE id IN (SELECT DISTINCT course_id FROM token_logs WHERE course_id IS NOT NULL);
` },
    { name: '050_agent_tool_events', sql: `
CREATE TABLE IF NOT EXISTS agent_tool_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
  agent TEXT,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_text TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  error_message TEXT,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_events_session ON agent_tool_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_events_thread ON agent_tool_events(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_events_course ON agent_tool_events(course_id, agent, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_events_tool ON agent_tool_events(tool_name, status, created_at);
` },
    { name: '051_app_background_settings', sql: () => `
${addColumnIfMissing('settings', 'background_image_enabled', 'INTEGER DEFAULT 0')}
${addColumnIfMissing('settings', 'background_image_path', "TEXT DEFAULT ''")}
${addColumnIfMissing('settings', 'background_image_opacity', 'REAL DEFAULT 0.72')}
${addColumnIfMissing('settings', 'background_overlay_opacity', 'REAL DEFAULT 0.38')}
${addColumnIfMissing('settings', 'background_image_fit', "TEXT DEFAULT 'cover'")}
UPDATE settings
SET background_image_opacity = 0.72
WHERE background_image_opacity IS NULL OR background_image_opacity < 0 OR background_image_opacity > 1;
UPDATE settings
SET background_overlay_opacity = 0.38
WHERE background_overlay_opacity IS NULL OR background_overlay_opacity < 0 OR background_overlay_opacity > 0.85;
UPDATE settings
SET background_image_fit = 'cover'
WHERE background_image_fit IS NULL OR background_image_fit NOT IN ('cover', 'contain', 'center');
` },
    { name: '052_source_exercise_assets', sql: `
CREATE TABLE IF NOT EXISTS source_exercises (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL DEFAULT 'short_answer',
  difficulty TEXT NOT NULL DEFAULT 'unknown',
  cognitive_action TEXT NOT NULL DEFAULT 'apply',
  stem_md TEXT NOT NULL,
  choices_json TEXT NOT NULL DEFAULT '[]',
  answer_md TEXT,
  solution_md TEXT,
  hints_json TEXT NOT NULL DEFAULT '[]',
  kc_tags_json TEXT NOT NULL DEFAULT '[]',
  source_locator TEXT,
  source_page INTEGER,
  license_status TEXT NOT NULL DEFAULT 'unknown',
  quality_score REAL NOT NULL DEFAULT 0,
  extraction_confidence REAL NOT NULL DEFAULT 0,
  duplicate_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, duplicate_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_exercises_source ON source_exercises(source_id, status, quality_score);
CREATE INDEX IF NOT EXISTS idx_source_exercises_course ON source_exercises(course_id, status, quality_score);
CREATE INDEX IF NOT EXISTS idx_source_exercises_node ON source_exercises(node_id, status, quality_score);
CREATE INDEX IF NOT EXISTS idx_source_exercises_type ON source_exercises(course_id, item_type, difficulty);
CREATE VIRTUAL TABLE IF NOT EXISTS source_exercises_fts USING fts5(
  stem,
  answer,
  solution,
  exercise_id UNINDEXED,
  source_id UNINDEXED,
  course_id UNINDEXED,
  node_id UNINDEXED,
  tokenize="unicode61 remove_diacritics 1"
);
` },
    { name: '053_background_overlay_opacity', sql: () => `
${addColumnIfMissing('settings', 'background_overlay_opacity', 'REAL DEFAULT 0.38')}
UPDATE settings
SET background_overlay_opacity = 0.38
WHERE background_overlay_opacity IS NULL OR background_overlay_opacity < 0 OR background_overlay_opacity > 0.85;
` },
    { name: '054_drop_notebooks', sql: `
DROP TABLE IF EXISTS notebooks;
` },
    { name: '055_agent_run_state', sql: `
CREATE TABLE IF NOT EXISTS agent_run_states (
  session_id TEXT PRIMARY KEY,
  thread_id TEXT,
  course_id TEXT,
  node_id TEXT,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  turn INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL DEFAULT '[]',
  task_list_json TEXT NOT NULL DEFAULT '{"items":[]}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_run_states_thread ON agent_run_states(thread_id, status, updated_at);
` },
    { name: '056_message_thinking', sql: () => addColumnIfMissing('messages', 'thinking', 'TEXT') },
    { name: '057_message_diagnostics', sql: () => addColumnIfMissing('messages', 'diagnostics', 'TEXT') },
    { name: '058_message_artifacts', sql: () => addColumnIfMissing('messages', 'artifacts', 'TEXT') },
	  ];

  const checkStmt = database.prepare<[string], { id: number }>(
    'SELECT id FROM _migrations WHERE name = ?'
  );
  const insertStmt = database.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const migration of migrations) {
    if (!checkStmt.get(migration.name)) {
      const sql = typeof migration.sql === 'function' ? migration.sql() : migration.sql;
      if (sql.trim()) {
        database.exec(sql);
      }
      insertStmt.run(migration.name);
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
