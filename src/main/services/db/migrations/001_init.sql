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

-- 课程
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

-- DAG 节点
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
  source_ids TEXT DEFAULT '[]',
  rationale TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- DAG 边
CREATE TABLE IF NOT EXISTS dag_edges (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES dag_nodes(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 学习会话
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

-- 对话消息
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

-- 文件（AI 生成 + 用户上传）
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

-- Token 消耗记录
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_dag_nodes_course ON dag_nodes(course_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_course ON dag_edges(course_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id);
CREATE INDEX IF NOT EXISTS idx_token_logs_course ON token_logs(course_id);

-- Source library (web pages, user uploads, generated sources)
CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES dag_nodes(id) ON DELETE SET NULL,
  thread_id TEXT,
  session_id TEXT,
  scope TEXT NOT NULL DEFAULT 'main_private',
  usage TEXT NOT NULL DEFAULT 'planning_only',
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
CREATE INDEX IF NOT EXISTS idx_source_records_course ON source_records(course_id, enabled);
CREATE INDEX IF NOT EXISTS idx_source_records_node ON source_records(node_id, enabled);
CREATE INDEX IF NOT EXISTS idx_source_records_thread ON source_records(thread_id);
CREATE INDEX IF NOT EXISTS idx_source_records_scope ON source_records(course_id, scope, enabled);

CREATE TABLE IF NOT EXISTS source_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  node_id TEXT,
  chunk_index INTEGER NOT NULL,
  locator TEXT,
  heading_path TEXT,
  page INTEGER,
  document_unit_id TEXT,
  document_unit_index INTEGER,
  char_start INTEGER,
  char_end INTEGER,
  token_count INTEGER,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_course ON source_chunks(course_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_document_unit ON source_chunks(source_id, document_unit_index);
CREATE INDEX IF NOT EXISTS idx_source_chunks_page ON source_chunks(source_id, page);
CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  source_id UNINDEXED,
  course_id UNINDEXED,
  node_id UNINDEXED,
  tokenize="unicode61 remove_diacritics 1"
);

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
