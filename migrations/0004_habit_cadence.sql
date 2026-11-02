-- Habits can be daily (default) or weekly. A weekly habit counts as done when it has a check
-- on any day of the current Sunday–Saturday week.
ALTER TABLE habits ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily';
