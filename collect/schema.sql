-- Metric Glance collection schema (Cloudflare D1 / SQLite).
-- Apply with:
--   wrangler d1 execute metric-glance --remote --file=./schema.sql
-- (drop --remote to seed a local dev copy first)

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key   TEXT UNIQUE,          -- SHA-256 over stable fields; makes retries idempotent
  install_id  TEXT NOT NULL,        -- random per-install id (not PII), used for throttling
  label       TEXT,
  tier        TEXT,                 -- corrected | seen | auto
  span        TEXT,
  num         REAL,
  unit        TEXT,
  unit_id     TEXT,
  before_ctx  TEXT,                 -- "before" in the client schema (reserved word here)
  after_ctx   TEXT,                 -- "after"  in the client schema
  sentence    TEXT,
  heading     TEXT,
  tag         TEXT,
  page_units  TEXT,                 -- JSON array, stored as text
  span_start  INTEGER,
  span_end    INTEGER,
  interacted  INTEGER,
  seen        INTEGER,
  url         TEXT,                 -- hostname only; server rejects anything with a slash
  lang        TEXT,
  title       TEXT,
  locale      TEXT,
  client_ts   INTEGER,              -- record timestamp from the device
  received_at INTEGER               -- server receive time (epoch seconds)
);

CREATE INDEX IF NOT EXISTS idx_install_received ON submissions (install_id, received_at);
CREATE INDEX IF NOT EXISTS idx_received        ON submissions (received_at);
