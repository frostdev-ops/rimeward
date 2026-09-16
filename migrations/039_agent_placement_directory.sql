ALTER TABLE agent_placements ADD COLUMN directory_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_placements ADD COLUMN last_transition_id TEXT;
ALTER TABLE agent_placement_receipts ADD COLUMN directory_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_placement_directory (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  transition_id TEXT,
  PRIMARY KEY (user_id, ward)
);
