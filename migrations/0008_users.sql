-- Friends' accounts. The owner (PASSWORD_HASH) is not a row here and keeps their data in this database;
-- each friend's data lives in their own Durable Object database (src/userdb.js).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,      -- stored lowercase
  password_hash TEXT NOT NULL,             -- pbkdf2-sha256$<iterations>$<salt>$<hash>
  name          TEXT NOT NULL DEFAULT '',
  timezone      TEXT NOT NULL DEFAULT 'America/New_York',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One-time sign-up codes made by the owner in Settings.
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);
