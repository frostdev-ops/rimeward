-- The lens observation contract's bookkeeping (src/lib/lens/store.ts), lifted from
-- BlackIce and keyed per (user, source): a source id is `<type>:<target>`
-- (`screen:local`, `terminal:<session>`), so one user watching two sources and two
-- users watching one never share a row. Consumer ids are `conv-<id>`, `cli-<session>`,
-- `mon-<id>`, `edge-<edgeId>` — unique only inside their own (user, source).
--
-- cursor/delivered_* is what that consumer has actually seen; baseline_* is the
-- keyframe it was last given. A stored event's epoch and ref appear nowhere but
-- inside the rendered text, which store.ts must never parse back.

CREATE TABLE lens_consumers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  delivered_id TEXT,
  delivered_v INTEGER,
  delivered_page INTEGER,
  delivered_truncated INTEGER NOT NULL DEFAULT 0,
  delivered_kind TEXT,
  delivered_pages INTEGER,
  delivered_pending_page INTEGER,
  baseline_v INTEGER,
  baseline_complete INTEGER NOT NULL DEFAULT 0,
  deltas INTEGER NOT NULL DEFAULT 0,
  min_interval_ms INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  seen_at INTEGER,
  next_delivery INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, source, id)
);

CREATE TABLE lens_watches (
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, id),
  FOREIGN KEY (user_id, source, consumer_id)
    REFERENCES lens_consumers (user_id, source, id) ON DELETE CASCADE
);

CREATE TABLE lens_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  v INTEGER NOT NULL,
  since INTEGER,
  key TEXT,
  page INTEGER NOT NULL DEFAULT 1,
  truncated INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  FOREIGN KEY (user_id, source, consumer_id)
    REFERENCES lens_consumers (user_id, source, id) ON DELETE CASCADE
);

CREATE INDEX lens_events_consumer ON lens_events (user_id, source, consumer_id, id);
