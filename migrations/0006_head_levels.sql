-- Two levels of section head: first in charge (awwal) and second in charge (saani).
-- In the Tahfeez wing they are called Mas'ool Awwal / Mas'ool Saani; titles are set per wing.
ALTER TABLE users ADD COLUMN head_level TEXT CHECK (head_level IN ('awwal', 'saani'));
UPDATE users SET head_level = 'awwal' WHERE role = 'head';

ALTER TABLE wings ADD COLUMN head_title TEXT NOT NULL DEFAULT 'Section Head';
ALTER TABLE wings ADD COLUMN deputy_title TEXT NOT NULL DEFAULT 'Deputy Section Head';
UPDATE wings SET head_title = 'Mas''ool Awwal', deputy_title = 'Mas''ool Saani' WHERE name = 'Tahfeez';
