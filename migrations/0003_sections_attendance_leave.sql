-- 1) Teachers (and Section Heads) can belong to several sections.
--    users.section_id stays as the "primary" (first) section for compatibility;
--    user_sections is the source of truth.
CREATE TABLE user_sections (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, section_id)
);
CREATE INDEX idx_user_sections_section ON user_sections(section_id);
INSERT INTO user_sections (user_id, section_id)
  SELECT id, section_id FROM users WHERE section_id IS NOT NULL;

-- 2) Leave applications. Approved leave writes CL / EA into attendance.
CREATE TABLE leave_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('casual_leave', 'eval_absent')),
  start_date   TEXT NOT NULL,                          -- YYYY-MM-DD
  end_date     TEXT NOT NULL,                          -- YYYY-MM-DD, inclusive
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by  INTEGER REFERENCES users(id),
  reviewed_at  TEXT,
  review_note  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leave_teacher ON leave_requests(teacher_id, status);
CREATE INDEX idx_leave_dates ON leave_requests(status, start_date, end_date);

-- 3) Attendance codes: Present (P), Absent (A), Casual Leave (CL), Evaluation Absent (EA).
--    Existing 'leave' entries become Casual Leave. leave_id links rows written by an approved leave.
CREATE TABLE attendance_new (
  teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('present', 'absent', 'casual_leave', 'eval_absent')),
  note        TEXT,
  marked_by   INTEGER REFERENCES users(id),
  leave_id    INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, date)
);
INSERT INTO attendance_new (teacher_id, date, status, note, marked_by, updated_at)
  SELECT teacher_id, date, CASE status WHEN 'leave' THEN 'casual_leave' ELSE status END, note, marked_by, updated_at
    FROM attendance;
DROP TABLE attendance;
ALTER TABLE attendance_new RENAME TO attendance;
CREATE INDEX idx_attendance_date ON attendance(date);
