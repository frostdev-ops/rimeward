ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','suspended'));
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
CREATE TABLE login_identities (
  connector TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(connector,issuer,subject)
);
CREATE TABLE account_actions (
  digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset','invite')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_audit (
  id INTEGER PRIMARY KEY, actor INTEGER, event TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE oauth_attempts (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, destination TEXT NOT NULL, session_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL,
  private_enc TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX oauth_attempt_owner ON oauth_attempts(user_id,provider,created_at);

CREATE TABLE legacy_google_users (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
INSERT INTO legacy_google_users SELECT id FROM users;
