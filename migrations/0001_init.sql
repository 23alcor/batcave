-- Batcave schema (Cloudflare D1 / SQLite)
-- All dates are local wall-clock (the TIMEZONE setting): 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT,
  status      TEXT,
  color       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  notion_id   TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'task',   -- task | inbox
  due_at        TEXT,                           -- 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'
  date_tbd      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | done | cancelled
  url           TEXT,
  notes         TEXT,
  done_at       TEXT,
  notion_id     TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE habits (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  sort    INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habit_checks (
  habit_id  TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  PRIMARY KEY (habit_id, day)
);

CREATE TABLE links (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  added_on      TEXT NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  needs_manual  INTEGER NOT NULL DEFAULT 0,
  notion_id     TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_links_added ON links(added_on);

CREATE TABLE vehicles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plate           TEXT,
  vin             TEXT,
  mileage         INTEGER,
  purchase_date   TEXT,
  purchase_price  REAL,
  insurance_until TEXT,
  notion_id       TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vehicle_logs (
  id          TEXT PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,     -- maintenance | ticket | insurance
  day         TEXT,
  title       TEXT NOT NULL,
  cost        REAL,
  notes       TEXT,
  notion_id   TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE wishlist (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT,
  status       TEXT NOT NULL DEFAULT 'Searching',
  priority     TEXT,
  price        REAL,
  link         TEXT,
  notes        TEXT,
  acquired_on  TEXT,
  notion_id    TEXT UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Calendar. Recurring rows use a small RRULE subset: FREQ=WEEKLY;BYDAY=MO,TU;UNTIL=YYYYMMDD
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  starts_at  TEXT NOT NULL,     -- first occurrence, wall clock
  ends_at    TEXT,
  all_day    INTEGER NOT NULL DEFAULT 0,
  rrule      TEXT,
  location   TEXT,
  color_key  TEXT,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
