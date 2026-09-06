-- Tool executions are local to the runtime that started them; never replay them on restart.
CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',
  background INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  output_offset INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_jobs_owner ON agent_jobs(user_id, ward, started_at);
