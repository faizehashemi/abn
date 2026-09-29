-- ABN Teacher Portal — initial schema

CREATE TABLE sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  its                      TEXT NOT NULL UNIQUE,            -- 8-digit ITS number, used as login ID
  password_hash            TEXT NOT NULL,
  using_default_password   INTEGER NOT NULL DEFAULT 1,      -- 1 while password is still "first name"
  role                     TEXT NOT NULL DEFAULT 'teacher'
                             CHECK (role IN ('coordinator', 'head', 'teacher')),
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
  full_name                TEXT NOT NULL,
  section_id               INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  -- Attendance marking rights: coordinator always has them; a section head can be
  -- granted 'section' (own section only) or 'all' (every teacher).
  attendance_scope         TEXT NOT NULL DEFAULT 'none'
                             CHECK (attendance_scope IN ('none', 'section', 'all')),
  consent_at               TEXT,
  profile_complete         INTEGER NOT NULL DEFAULT 0,
  phone                    TEXT,
  email                    TEXT,
  photo_key                TEXT,
  date_of_joining          TEXT,
  qualification            TEXT,
  designation              TEXT,
  subjects                 TEXT,
  address                  TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at              TEXT,
  approved_by              INTEGER REFERENCES users(id)
);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_section ON users(section_id);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,                              -- unix seconds
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Merit / demerit entries. Section-head entries start 'pending' and need
-- coordinator approval; only 'approved' rows count toward the score.
CREATE TABLE points (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('merit', 'demerit')),
  points        INTEGER NOT NULL CHECK (points > 0),
  reason        TEXT NOT NULL,
  event_date    TEXT NOT NULL,                               -- YYYY-MM-DD
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  review_note   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_points_teacher ON points(teacher_id, status);
CREATE INDEX idx_points_status ON points(status);

CREATE TABLE attendance (
  teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,                                 -- YYYY-MM-DD
  status      TEXT NOT NULL CHECK (status IN ('present', 'absent', 'leave')),
  note        TEXT,
  marked_by   INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, date)
);
CREATE INDEX idx_attendance_date ON attendance(date);

CREATE TABLE announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  important    INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  email_sent   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE announcement_reads (
  announcement_id  INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,                                 -- sent | logged | failed
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('policies',
'1. Code of Conduct
Every teacher is expected to uphold the values, discipline and dignity of Ammar Baughe Nounehaal Higher Secondary School in and outside the classroom.

2. Punctuality & Attendance
Teachers must report on time. Daily attendance is recorded on this portal and forms part of your service record. Leave must be applied for in advance through your Section Head.

3. Merit & Demerit System
Section Heads may recommend merit or demerit points for conduct, performance and punctuality. All points are reviewed and approved by the Main Coordinator before they appear on your record. Scores are visible on the staff leaderboard.

4. Official Communication
Important announcements are published on this portal and sent to your registered email. It is your responsibility to check the portal regularly.

5. Data & Privacy
The information you provide (name, ITS number, photo, contact details, qualifications, address) is stored securely and used only for school administration. It is visible to the Main Coordinator and your Section Head. Other teachers can only see your name, section and leaderboard score.

6. Account Security
Do not share your login. Change your default password from Settings after your first login.

By clicking "I Agree & Give Consent" you confirm that you have read and accept these policies.');
