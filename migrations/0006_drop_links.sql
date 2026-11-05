-- Job apps was removed; its table goes too (the index is dropped with it).
-- Deploy the Worker without job apps before applying this, or the old Worker's dashboard query fails.
DROP TABLE IF EXISTS links;
