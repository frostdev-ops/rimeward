-- Anyone-with-the-link shares may now carry edit, not only view (lib/shares.ts bounds
-- the role by the ward's own share ceiling). Drop the row-level `role = 'view'` guard on
-- link shares; keep every other constraint. SQLite has no DROP CONSTRAINT, so rebuild.
ALTER TABLE shares RENAME TO shares_old;
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ward', 'page')),
  target TEXT NOT NULL,
  grantee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  token_hash TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((grantee_id IS NULL) = (token_hash IS NOT NULL))
);
INSERT INTO shares SELECT id, owner_id, kind, target, grantee_id, role, token_hash, expires_at, created_at FROM shares_old;
DROP TABLE shares_old;
CREATE UNIQUE INDEX shares_grant ON shares (owner_id, kind, target, grantee_id) WHERE grantee_id IS NOT NULL;
CREATE INDEX shares_grantee ON shares (grantee_id);
