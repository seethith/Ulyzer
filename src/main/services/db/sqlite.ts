import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';

// Inline migration so it works in both dev and production builds
const MIGRATION_001 = `
-- 用户设置（单行）
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  default_provider TEXT DEFAULT 'anthropic',
  default_model TEXT DEFAULT 'claude-sonnet-4-5-20251001',
  monthly_budget_cny REAL DEFAULT 50.0,
  guidance_mode TEXT DEFAULT 'strict',
  force_review INTEGER DEFAULT 1,
  spaced_repetition INTEGER DEFAULT 1,
  font_size INTEGER DEFAULT 13,
  remember_layout INTEGER DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT DEFAULT '学习笔记',
  content TEXT DEFAULT '',
  review_content TEXT DEFAULT '',
  review_submitted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  course_id TEXT REFERENCES courses(id),
  provider TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cny REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dag_nodes_course ON dag_nodes(course_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_course ON dag_edges(course_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id);
CREATE INDEX IF NOT EXISTS idx_notebooks_node ON notebooks(node_id);
CREATE INDEX IF NOT EXISTS idx_token_logs_course ON token_logs(course_id);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'ulyzer.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      ran_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
  title TEXT DEFAULT '新对话',
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

INSERT OR IGNORE INTO provider_models (id, provider_id, model_id, label, tag, is_builtin) VALUES
  ('bi:anthropic:claude-sonnet-4-6',       'anthropic',  'claude-sonnet-4-6',            'Claude Sonnet 4.6',  '推荐', 1),
  ('bi:anthropic:claude-opus-4-6',         'anthropic',  'claude-opus-4-6',              'Claude Opus 4.6',    '强力', 1),
  ('bi:anthropic:claude-haiku-4-5',        'anthropic',  'claude-haiku-4-5-20251001',    'Claude Haiku 4.5',   '轻量', 1),
  ('bi:openai:gpt-4o',                     'openai',     'gpt-4o',                       'GPT-4o',             '备用', 1),
  ('bi:openai:gpt-4o-mini',                'openai',     'gpt-4o-mini',                  'GPT-4o mini',        '轻量', 1),
  ('bi:gemini:gemini-2.5-pro',             'gemini',     'gemini-2.5-pro',               'Gemini 2.5 Pro',     '强力', 1),
  ('bi:gemini:gemini-2.0-flash',           'gemini',     'gemini-2.0-flash',             'Gemini 2.0 Flash',   '快速', 1),
  ('bi:grok:grok-3',                       'grok',       'grok-3',                       'Grok 3',             '强力', 1),
  ('bi:grok:grok-3-mini',                  'grok',       'grok-3-mini',                  'Grok 3 Mini',        '快速', 1),
  ('bi:openrouter:llama-4-maverick',       'openrouter', 'meta-llama/llama-4-maverick',  'Llama 4 Maverick',   '开源', 1),
  ('bi:deepseek:deepseek-chat',            'deepseek',   'deepseek-chat',                'DeepSeek Chat',      '经济', 1),
  ('bi:deepseek:deepseek-reasoner',        'deepseek',   'deepseek-reasoner',            'DeepSeek R1',        '推理', 1),
  ('bi:qwen:qwen-max',                     'qwen',       'qwen-max',                     'Qwen Max',           '强力', 1),
  ('bi:qwen:qwen-plus',                    'qwen',       'qwen-plus',                    'Qwen Plus',          '均衡', 1),
  ('bi:qwen:qwen-turbo',                   'qwen',       'qwen-turbo',                   'Qwen Turbo',         '经济', 1),
  ('bi:minimax:minimax-text-01',           'minimax',    'MiniMax-Text-01',              'MiniMax Text-01',    '国产', 1),
  ('bi:ollama:llama3',                     'ollama',     'llama3',                       'llama3',             '离线', 1);
`;

  const migrations: Array<{ name: string; sql: string }> = [
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

INSERT OR IGNORE INTO provider_models (id, provider_id, model_id, label, tag, is_builtin) VALUES
  ('bi:mistral:large',         'mistral',    'mistral-large-latest',                             'Mistral Large',        '强力', 1),
  ('bi:mistral:small',         'mistral',    'mistral-small-latest',                             'Mistral Small',        '轻量', 1),
  ('bi:mistral:codestral',     'mistral',    'codestral-latest',                                 'Codestral',            '代码', 1),
  ('bi:groq:llama70b',         'groq',       'llama-3.3-70b-versatile',                          'Llama 3.3 70B',        '快速', 1),
  ('bi:groq:llama8b',          'groq',       'llama-3.1-8b-instant',                             'Llama 3.1 8B',         '轻量', 1),
  ('bi:groq:mixtral',          'groq',       'mixtral-8x7b-32768',                               'Mixtral 8x7B',         '开源', 1),
  ('bi:together:llama4',       'together',   'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8','Llama 4 Maverick',     '开源', 1),
  ('bi:together:qwen72b',      'together',   'Qwen/Qwen2.5-72B-Instruct-Turbo',                  'Qwen 2.5 72B',         '均衡', 1),
  ('bi:moonshot:8k',           'moonshot',   'moonshot-v1-8k',                                   'Moonshot 8k',          '经济', 1),
  ('bi:moonshot:32k',          'moonshot',   'moonshot-v1-32k',                                  'Moonshot 32k',         '均衡', 1),
  ('bi:moonshot:128k',         'moonshot',   'moonshot-v1-128k',                                 'Moonshot 128k',        '长文', 1),
  ('bi:zhipu:glm4',            'zhipu',      'glm-4',                                            'GLM-4',                '强力', 1),
  ('bi:zhipu:glm4flash',       'zhipu',      'glm-4-flash',                                      'GLM-4 Flash',          '快速', 1),
  ('bi:zhipu:glm4air',         'zhipu',      'glm-4-air',                                        'GLM-4 Air',            '经济', 1),
  ('bi:doubao:pro32k',         'doubao',     'doubao-pro-32k',                                   'Doubao Pro 32k',       '强力', 1),
  ('bi:doubao:lite32k',        'doubao',     'doubao-lite-32k',                                  'Doubao Lite 32k',      '经济', 1),
  ('bi:perplexity:sonarpro',   'perplexity', 'sonar-pro',                                        'Sonar Pro',            '联网', 1),
  ('bi:perplexity:sonar',      'perplexity', 'sonar',                                            'Sonar',                '轻量', 1),
  ('bi:cohere:commandrplus',   'cohere',     'command-r-plus',                                   'Command R+',           '强力', 1),
  ('bi:cohere:commandr',       'cohere',     'command-r',                                        'Command R',            '均衡', 1);
` },
  ];

  const checkStmt = database.prepare<[string], { id: number }>(
    'SELECT id FROM _migrations WHERE name = ?'
  );
  const insertStmt = database.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const migration of migrations) {
    if (!checkStmt.get(migration.name)) {
      database.exec(migration.sql);
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
