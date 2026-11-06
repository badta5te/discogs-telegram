-- What the user asked to watch: one release, or a master expanded into its versions.
CREATE TABLE wants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('release', 'master')),
  discogs_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  format_filter TEXT,
  max_price REAL,
  added_at TEXT NOT NULL,
  versions_synced_at TEXT,
  UNIQUE (kind, discogs_id)
);

-- Concrete releases polled for marketplace stats. NULL checked_at means never checked:
-- the first check only records the market silently.
CREATE TABLE targets (
  want_id INTEGER NOT NULL REFERENCES wants (id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  thumb TEXT,
  num_for_sale INTEGER,
  lowest_price REAL,
  -- 1 while the lowest price is at or under max_price, so we alert on entering the range, not on every check.
  under_max INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  PRIMARY KEY (want_id, release_id)
);

CREATE INDEX targets_checked_at ON targets (checked_at);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
