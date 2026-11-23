-- Correction from the voice note: Junior (Nursery–2nd), Middle (3rd–10th) and Senior (11th–12th)
-- are the SCHOOL ACADEMICS sections, not Tahfeez. Academics stays "in development" while
-- Tahfeez (Hifz) is the pilot.
UPDATE sections SET wing_id = (SELECT id FROM wings WHERE name = 'Academics')
 WHERE name IN ('Junior', 'Middle', 'Senior') AND grades IS NOT NULL;
