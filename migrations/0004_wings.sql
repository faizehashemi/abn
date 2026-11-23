-- Hierarchy: Principal → Wing → Section (with a Section Head) → Teachers.
-- Two wings: Tahfeez (the pilot, active now) and Academics (to be developed later).
CREATE TABLE wings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,      -- 0 = "in development": shown, but not offered in pickers
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO wings (name, active, sort) VALUES ('Tahfeez', 1, 1), ('Academics', 0, 2);

ALTER TABLE sections ADD COLUMN wing_id INTEGER REFERENCES wings(id) ON DELETE SET NULL;
ALTER TABLE sections ADD COLUMN grades TEXT;         -- e.g. "Nursery – 2nd"
ALTER TABLE sections ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

-- Existing sections belong to the Tahfeez pilot.
UPDATE sections SET wing_id = (SELECT id FROM wings WHERE name = 'Tahfeez');

-- The three Tahfeez sections, each to get its own Section Head.
INSERT OR IGNORE INTO sections (name, wing_id, grades, sort) VALUES
  ('Junior', (SELECT id FROM wings WHERE name = 'Tahfeez'), 'Nursery – 2nd', 1),
  ('Middle', (SELECT id FROM wings WHERE name = 'Tahfeez'), '3rd – 10th', 2),
  ('Senior', (SELECT id FROM wings WHERE name = 'Tahfeez'), '11th – 12th', 3);
