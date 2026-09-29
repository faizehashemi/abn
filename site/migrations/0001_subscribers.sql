-- Newsletter subscribers for raajsoftware.com
CREATE TABLE subscribers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
