CREATE TABLE IF NOT EXISTS lab_reports (
  id          TEXT PRIMARY KEY,
  audit_time  TEXT NOT NULL,
  project     TEXT NOT NULL,
  reviewer    TEXT,
  items_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS us_reports (
  uid         TEXT PRIMARY KEY,
  report_time TEXT NOT NULL,
  dept        TEXT,
  doctor      TEXT,
  findings    TEXT,
  conclusion  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
