-- Biometric punching machines (eSSL / ZKTeco X990) pushing punches over ADMS (/iclock),
-- and selfie self check-in that unlocks once a teacher's punch for the day has arrived.

-- Teacher's user ID as enrolled on the punching machine (set by the Principal).
ALTER TABLE users ADD COLUMN device_pin TEXT;
CREATE UNIQUE INDEX idx_users_device_pin ON users(device_pin) WHERE device_pin IS NOT NULL;

-- Machines that have contacted the portal. Punches are only accepted from approved machines.
CREATE TABLE devices (
  serial       TEXT PRIMARY KEY,               -- SN the machine reports
  name         TEXT,
  approved     INTEGER NOT NULL DEFAULT 0,
  last_seen    TEXT,
  last_ip      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE punches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_sn    TEXT NOT NULL,
  device_pin   TEXT NOT NULL,                  -- machine user ID
  punch_time   TEXT NOT NULL,                  -- machine local time, "YYYY-MM-DD HH:MM:SS"
  punch_date   TEXT NOT NULL,                  -- YYYY-MM-DD
  status       TEXT,                           -- check-in/out code from the machine
  verify       TEXT,                           -- 1 = fingerprint, 15 = face, …
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_sn, device_pin, punch_time)
);
CREATE INDEX idx_punches_user_date ON punches(user_id, punch_date);
CREATE INDEX idx_punches_pin_date ON punches(device_pin, punch_date);

-- Selfie check-ins (one per teacher per day; retaking replaces it).
CREATE TABLE checkins (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,                  -- YYYY-MM-DD (school time zone)
  punch_id     INTEGER REFERENCES punches(id) ON DELETE SET NULL,
  photo        BLOB,                           -- small JPEG; cleared after 90 days, the record stays
  lat          REAL,
  lng          REAL,
  accuracy     REAL,
  source       TEXT,                           -- 'app' or 'browser'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_checkins_date ON checkins(date);
