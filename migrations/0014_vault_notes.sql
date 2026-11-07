-- A read-only mirror of the owner's notes vault (e.g. Obsidian), pushed by the notes bridge
-- (PUT /api/ingest/vault) and searched by the MCP server (/mcp) and the assistant. Friends get the table in their
-- own database too (src/userdb.js), where the assistant builds it from what they tell it.
CREATE TABLE IF NOT EXISTS vault_notes (
  path       TEXT PRIMARY KEY,          -- 'Folder/Sub/Note.md', relative to the vault root
  title      TEXT NOT NULL,
  folder     TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',  -- space-separated
  updated_at TEXT,                      -- local wall-clock 'YYYY-MM-DDTHH:MM'
  hash       TEXT,
  body       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS vault_notes_updated ON vault_notes (updated_at);
