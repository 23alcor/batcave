-- Google Calendar connection (one account) and which of its calendars show on the week view.
CREATE TABLE IF NOT EXISTS google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  refresh_enc TEXT NOT NULL,          -- AES-GCM, key derived from SESSION_SECRET
  access_enc TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'ok',  -- ok | reauth
  connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS google_calendars (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  color TEXT,
  access_role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  shown INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
