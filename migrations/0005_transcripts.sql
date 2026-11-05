-- Sessions: transcripts of work or study sessions sent in by a script, a phone shortcut or an AI tool.
-- The assistant's model turns each one into a short session note; a notes bridge (for example a script on
-- your computer that writes into an Obsidian vault) picks the ready ones up and marks them filed.
CREATE TABLE IF NOT EXISTS transcripts (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  received_on TEXT NOT NULL,              -- local 'YYYY-MM-DDTHH:MM' when it arrived
  source      TEXT,                       -- who sent it: codex, claude, shortcut, batcave…
  hint_title  TEXT,                       -- optional suggestions from the sender
  hint_target TEXT,
  hint_kind   TEXT,
  started_at  TEXT,                       -- optional local 'YYYY-MM-DDTHH:MM'
  ended_at    TEXT,
  transcript  TEXT NOT NULL,
  chars       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'new', -- new | summarizing | ready | filed | error | dismissed
  claimed_at  TEXT,                       -- ISO time a summary started (stale ones are retried)
  title       TEXT,
  kind        TEXT,                       -- work | study
  target      TEXT,                       -- name of the note it belongs to (from the bridge's list)
  summary     TEXT,                       -- JSON from the model
  error       TEXT,
  filed_path  TEXT,
  filed_at    TEXT
);
CREATE INDEX IF NOT EXISTS transcripts_status ON transcripts (status, created_at);
