-- Private to each user's database. Records are archived, never hard-deleted.
CREATE TABLE budget_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category','limit','transaction','subscription')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX budget_category_name ON budget_records(lower(json_extract(data,'$.name'))) WHERE kind='category' AND archived=0;
CREATE UNIQUE INDEX budget_category_limit ON budget_records(json_extract(data,'$.category_id'),json_extract(data,'$.period'),json_extract(data,'$.start_date')) WHERE kind='limit' AND archived=0;
CREATE UNIQUE INDEX budget_import_id ON budget_records(json_extract(data,'$.external_id')) WHERE kind='transaction' AND json_extract(data,'$.external_id') IS NOT NULL;
CREATE UNIQUE INDEX budget_subscription_payment ON budget_records(json_extract(data,'$.subscription_id'),json_extract(data,'$.billing_date')) WHERE kind='transaction' AND archived=0 AND json_extract(data,'$.status')='tracked' AND json_extract(data,'$.subscription_id') IS NOT NULL;
CREATE TABLE budget_changes (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','alfred')),
  action TEXT NOT NULL,
  before_record TEXT,
  after_record TEXT NOT NULL,
  after_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  request TEXT NOT NULL
);
CREATE INDEX budget_changes_record ON budget_changes(record_id, created_at);
CREATE TABLE budget_proposals (
  id TEXT PRIMARY KEY,
  change TEXT NOT NULL,
  before_record TEXT,
  after_record TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO budget_records(id,kind,data,updated_at) VALUES
 ('budget-housing','category','{"name":"Housing","color":"#006c67"}',datetime('now')),
 ('budget-groceries','category','{"name":"Groceries","color":"#23a9a1"}',datetime('now')),
 ('budget-dining','category','{"name":"Dining out","color":"#d5a500"}',datetime('now')),
 ('budget-transport','category','{"name":"Transport","color":"#ef6c4a"}',datetime('now')),
 ('budget-subscriptions','category','{"name":"Subscriptions","color":"#75a99e"}',datetime('now')),
 ('budget-other','category','{"name":"Other","color":"#8dafa9"}',datetime('now'));
