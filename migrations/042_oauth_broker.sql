CREATE TABLE oauth_broker_grants (
 id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, user_code TEXT NOT NULL UNIQUE,
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
 options_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL,
 delivery_enc TEXT NOT NULL DEFAULT '', refresh_hash TEXT NOT NULL DEFAULT '',
 previous_refresh_hash TEXT NOT NULL DEFAULT '',
 last_poll INTEGER NOT NULL DEFAULT 0
);
