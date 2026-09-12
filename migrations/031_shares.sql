-- Ward and page sharing (lib/shares.ts). One row per grant: a user (grantee_id) or
-- an anyone-with-the-link token (token_hash, always view-only). The target is a ward
-- id or a page id in the OWNER's layout; the owner's layout stays the registry.
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
  CHECK ((grantee_id IS NULL) = (token_hash IS NOT NULL)),
  CHECK (grantee_id IS NOT NULL OR role = 'view')
);
CREATE UNIQUE INDEX shares_grant ON shares (owner_id, kind, target, grantee_id) WHERE grantee_id IS NOT NULL;
CREATE INDEX shares_grantee ON shares (grantee_id);
