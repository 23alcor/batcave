CREATE TABLE places (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cuisine     TEXT,
  area        TEXT,
  status      TEXT NOT NULL DEFAULT 'want',  -- want | been
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE place_dishes (
  id          TEXT PRIMARY KEY,
  place_id    TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  notes       TEXT,
  day         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
