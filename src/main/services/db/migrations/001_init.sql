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

-- 笔记
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

-- Token 消耗记录
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_dag_nodes_course ON dag_nodes(course_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_course ON dag_edges(course_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id);
CREATE INDEX IF NOT EXISTS idx_notebooks_node ON notebooks(node_id);
CREATE INDEX IF NOT EXISTS idx_token_logs_course ON token_logs(course_id);
