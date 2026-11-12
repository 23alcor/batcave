-- Owner-only MCP activity and managed project/task handoffs. No note bodies in activity.
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  agent TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  ref TEXT,
  at TEXT NOT NULL
);
CREATE TABLE agent_contexts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL,
  entry_note TEXT NOT NULL,
  content TEXT NOT NULL,
  next_action TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  filed_revision INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  session_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project, task)
);
