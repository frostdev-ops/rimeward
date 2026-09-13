CREATE TABLE terminal_placements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, ward, session_id)
);
CREATE INDEX terminal_placements_ward ON terminal_placements(user_id, ward);

CREATE TABLE terminal_placement_views (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ward)
);
