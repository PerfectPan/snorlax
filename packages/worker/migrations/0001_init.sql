CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_push_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE buckets (
  device_id          TEXT    NOT NULL,
  hour               INTEGER NOT NULL,
  agent              TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  reasoning_tokens   INTEGER NOT NULL,
  requests           INTEGER NOT NULL,
  sessions_started   INTEGER NOT NULL,
  cost_usd           REAL    NOT NULL,
  unpriced_requests  INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  PRIMARY KEY (device_id, hour, agent, model)
);
CREATE INDEX buckets_by_seq ON buckets (seq);
