-- User-created observations are separate from infrastructure health monitors.
CREATE TABLE agent_monitors (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  runtime TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  filter TEXT NOT NULL,
  semantic TEXT,
  status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','paused','blocked','offline')),
  cursor TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  observed_at INTEGER,
  matched_at INTEGER
);
CREATE INDEX agent_monitors_owner ON agent_monitors(user_id,ward,conversation_id);
CREATE TABLE agent_monitor_events (
  id INTEGER PRIMARY KEY,
  monitor TEXT NOT NULL REFERENCES agent_monitors(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered')),
  observed_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE(monitor,revision,event_key)
);
CREATE INDEX agent_monitor_pending ON agent_monitor_events(state,monitor);
