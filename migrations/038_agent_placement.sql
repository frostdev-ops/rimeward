ALTER TABLE agent_conversations ADD COLUMN owner_runtime_id TEXT;

CREATE TABLE agent_placements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  transition_id TEXT,
  target_runtime_id TEXT,
  PRIMARY KEY (user_id, ward)
);

CREATE TABLE agent_placement_receipts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ward TEXT NOT NULL,
  source_runtime_id TEXT NOT NULL,
  target_runtime_id TEXT NOT NULL,
  source_conversation INTEGER,
  destination_conversation INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('retired', 'created', 'complete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
