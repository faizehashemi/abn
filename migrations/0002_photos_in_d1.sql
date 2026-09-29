-- Store profile photos in D1 instead of R2 (R2 is not enabled on the account).
-- Photos are resized in the browser to ~480px JPEG (~50 KB) before upload.
-- users.photo_key stays as a version tag so browsers refetch after a change.
CREATE TABLE photos (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL,
  data          BLOB NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
