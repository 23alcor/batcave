-- Example data for the public preview (/demo). The Worker re-runs this once a day against the demo's own
-- database, so the dates stay current. Dates are relative to today (UTC, close enough for a demo).
DELETE FROM habit_checks; DELETE FROM habits; DELETE FROM tasks; DELETE FROM projects; DELETE FROM events;
DELETE FROM vehicle_logs; DELETE FROM vehicles; DELETE FROM wishlist; DELETE FROM recipes;
DELETE FROM place_dishes; DELETE FROM places; DELETE FROM meta;

INSERT INTO habits (id, name, sort, active, cadence) VALUES
  ('ex-make-bed', 'Make bed', 0, 1, 'daily'),
  ('ex-read', 'Read (20 min)', 1, 1, 'daily'),
  ('ex-move', 'Move (30 min)', 2, 1, 'daily'),
  ('ex-water', 'Drink water', 3, 1, 'daily'),
  ('ex-laundry', 'Laundry', 4, 1, 'weekly'),
  ('ex-plan', 'Plan the week', 5, 1, 'weekly');

INSERT INTO habit_checks (habit_id, day) VALUES
  ('ex-make-bed', date('now')), ('ex-water', date('now')),
  ('ex-make-bed', date('now', '-1 day')), ('ex-read', date('now', '-1 day')), ('ex-move', date('now', '-1 day')), ('ex-water', date('now', '-1 day')),
  ('ex-make-bed', date('now', '-2 day')), ('ex-read', date('now', '-2 day')), ('ex-water', date('now', '-2 day')),
  ('ex-make-bed', date('now', '-3 day')), ('ex-move', date('now', '-3 day')), ('ex-water', date('now', '-3 day')),
  ('ex-read', date('now', '-4 day')), ('ex-move', date('now', '-4 day')),
  ('ex-plan', date('now', 'weekday 0', '-7 day'));

INSERT INTO projects (id, name, short_name, status, color, sort) VALUES
  ('ex-personal', 'Personal', 'Personal', 'In progress', '#4F46E5', 1),
  ('ex-learning', 'Learn Spanish', 'Spanish', 'In progress', '#0F766E', 2),
  ('ex-home', 'Apartment move', 'Move', 'Planning', '#B45309', 3);

INSERT INTO tasks (id, title, project_id, kind, due_at, status, notes) VALUES
  ('ex-t1', 'Renew passport', 'ex-personal', 'task', date('now') || 'T17:00', 'open', 'Photos are in the desk drawer.'),
  ('ex-t2', 'Call the dentist', 'ex-personal', 'task', date('now', '-1 day'), 'open', NULL),
  ('ex-t3', 'Finish lesson 12', 'ex-learning', 'task', date('now', '+1 day') || 'T20:00', 'open', NULL),
  ('ex-t4', 'Practice with a conversation partner', 'ex-learning', 'task', date('now', '+4 day'), 'open', NULL),
  ('ex-t5', 'Get quotes from three movers', 'ex-home', 'task', date('now', '+2 day'), 'open', NULL),
  ('ex-t6', 'Book the elevator for move day', 'ex-home', 'task', date('now', '+9 day'), 'open', NULL),
  ('ex-t7', 'Pack the bookshelf', 'ex-home', 'task', date('now', '-2 day'), 'done', NULL),
  ('ex-i1', 'Gift idea: a cookbook for Sam', NULL, 'inbox', NULL, 'open', NULL),
  ('ex-i2', 'Look into a library card', NULL, 'inbox', NULL, 'open', NULL);
UPDATE tasks SET done_at = date('now', '-2 day') WHERE status = 'done';

-- Weekly schedule for the week view (starts_at is the first occurrence, long ago, so every week shows it).
INSERT INTO events (id, title, starts_at, ends_at, all_day, rrule, color_key) VALUES
  ('ex-gym', 'Gym', '2026-01-05T07:00', '2026-01-05T08:00', 0, 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'gym'),
  ('ex-work', 'Work', '2026-01-05T09:30', '2026-01-05T17:00', 0, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'work'),
  ('ex-class', 'Spanish class', '2026-01-06T18:30', '2026-01-06T19:30', 0, 'FREQ=WEEKLY;BYDAY=TU,TH', NULL);
INSERT INTO events (id, title, starts_at, ends_at, all_day, location) VALUES
  ('ex-dinner', 'Dinner with Sam', date('now', '+1 day') || 'T19:00', date('now', '+1 day') || 'T21:00', 0, 'Luigi''s');

INSERT INTO meta (key, value) VALUES ('wake:default', '06:30'), ('wake:dow:0', '08:00'), ('wake:dow:6', '08:00');

INSERT INTO vehicles (id, name, plate, mileage, purchase_date, insurance_until) VALUES
  ('ex-car', 'Blue hatchback', 'DEMO-123', 48210, '2023-04-15', date('now', '+5 month'));
INSERT INTO vehicle_logs (id, vehicle_id, kind, day, title, cost, notes) VALUES
  ('ex-log1', 'ex-car', 'maintenance', date('now', '-20 day'), 'Oil change', 64.99, 'Next one at 53,000 mi'),
  ('ex-log2', 'ex-car', 'maintenance', date('now', '-3 month'), 'New wiper blades', 28.50, NULL),
  ('ex-log3', 'ex-car', 'insurance', date('now', '-7 month'), 'Yearly insurance', 1180, NULL);

INSERT INTO wishlist (id, name, category, status, priority, price, notes) VALUES
  ('ex-w1', 'Noise-cancelling headphones', 'Tech', 'Searching', 'High', 249, 'Wait for a sale'),
  ('ex-w2', 'Cast-iron skillet', 'Kitchen', 'Waiting for discount', 'Medium', 45, NULL),
  ('ex-w3', 'Rain jacket', 'Clothes', 'Bought', 'Medium', 120, NULL);
UPDATE wishlist SET acquired_on = date('now', '-10 day') WHERE status = 'Bought';

INSERT INTO recipes (id, name, time, servings, description, ingredients, instructions) VALUES
  ('ex-r1', 'Weeknight tomato pasta', '25 min', '2', 'Fast, cheap and better than it sounds.',
   '200 g spaghetti
1 can crushed tomatoes
2 cloves garlic
Olive oil, salt, basil',
   'Boil the pasta.
Soften the garlic in oil, add the tomatoes, simmer 10 minutes.
Toss with the pasta and basil.');

INSERT INTO places (id, name, cuisine, area, status) VALUES
  ('ex-p1', 'Luigi''s', 'Italian', 'Downtown', 'been'),
  ('ex-p2', 'Golden Noodle', 'Chinese', 'Eastside', 'want');
INSERT INTO place_dishes (id, place_id, name, notes, day) VALUES
  ('ex-d1', 'ex-p1', 'Cacio e pepe', 'Get it again', date('now', '-12 day'));
