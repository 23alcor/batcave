-- Eating out moves to this (install-wide) database so people can share one list.
-- A "space" is one list: 'u<uid>' is a person's own; joining with a code points eat_members at someone else's.
ALTER TABLE places ADD COLUMN space TEXT NOT NULL DEFAULT 'u0';
CREATE INDEX idx_places_space ON places(space);
CREATE TABLE eat_members (
  uid    INTEGER PRIMARY KEY,   -- 0 is the owner
  space  TEXT NOT NULL
);
CREATE TABLE eat_codes (
  code       TEXT PRIMARY KEY,
  space      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
