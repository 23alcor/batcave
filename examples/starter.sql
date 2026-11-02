-- A few examples so a new dashboard isn't empty. `npm run setup` offers to load this;
-- or run: npx wrangler d1 execute batcave --remote --file examples/starter.sql
-- Rename, remove or replace anything here from the app (Daily → Edit) or by asking the assistant.

INSERT OR IGNORE INTO habits (id, name, sort, active, cadence) VALUES
  ('ex-make-bed', 'Make bed', 0, 1, 'daily'),
  ('ex-read', 'Read (20 min)', 1, 1, 'daily'),
  ('ex-move', 'Move (30 min)', 2, 1, 'daily'),
  ('ex-water', 'Drink water', 3, 1, 'daily'),
  ('ex-laundry', 'Laundry', 4, 1, 'weekly'),
  ('ex-plan', 'Plan the week', 5, 1, 'weekly');

INSERT OR IGNORE INTO projects (id, name, short_name, status, color, sort) VALUES
  ('ex-personal', 'Personal', 'Personal', 'In progress', '#4F46E5', 1),
  ('ex-learning', 'Learning', 'Learning', 'In progress', '#0F766E', 2);

INSERT OR IGNORE INTO tasks (id, title, project_id, kind, due_at, notes) VALUES
  ('ex-task-1', 'Try the assistant: ask it what to work on today', 'ex-personal', 'task', date('now', '+1 day') || 'T18:00', 'Press / to open the chat.'),
  ('ex-task-2', 'Connect Google Calendar (week view → Connect)', 'ex-personal', 'task', date('now', '+2 day'), 'See "Google Calendar" in the README.'),
  ('ex-inbox-1', 'Ideas go in the inbox until they have a date', NULL, 'inbox', NULL, NULL);

-- A sample weekly schedule for the week view until you connect Google Calendar (then Google's events show instead).
INSERT OR IGNORE INTO events (id, title, starts_at, ends_at, all_day, rrule, color_key) VALUES
  ('ex-gym', 'Gym', '2026-01-05T07:00', '2026-01-05T08:00', 0, 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'gym'),
  ('ex-work', 'Work', '2026-01-05T09:30', '2026-01-05T17:00', 0, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'work');
