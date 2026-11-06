CREATE TABLE recipes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  time         TEXT NOT NULL DEFAULT '',
  servings     TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  ingredients  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
