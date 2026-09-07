-- Owner policy is account data, never a dashboard setting or OS permission.
CREATE TABLE remote_desktop_policies (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  boot_id TEXT,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- No media, clipboard, input, credentials or file paths belong in this audit.
CREATE TABLE remote_desktop_audit (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  capabilities TEXT NOT NULL,
  transport TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  termination_reason TEXT
);
CREATE INDEX remote_desktop_audit_retention ON remote_desktop_audit(started_at);
