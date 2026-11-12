-- Owner-only requests for the Mac to create new Obsidian notes. Existing files are never edited.
CREATE TABLE IF NOT EXISTS note_requests (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL COLLATE NOCASE UNIQUE,
  title TEXT NOT NULL,
  folder TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'saved', 'error')),
  error TEXT,
  created_at TEXT NOT NULL,
  saved_at TEXT
);
