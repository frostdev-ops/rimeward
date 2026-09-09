-- Model routes. A thread pins the wire DIALECT its items are written in (the
-- old provider column, renamed — its CHECK still guards it) and, separately,
-- the provider/endpoint it runs on. foreign_keys is on, so rebuilding
-- agent_conversations would cascade-delete every thread: these are additive.
ALTER TABLE agent_conversations RENAME COLUMN provider TO dialect;
ALTER TABLE agent_conversations ADD COLUMN provider TEXT NOT NULL DEFAULT '';
UPDATE agent_conversations SET provider = dialect;
ALTER TABLE agent_conversations ADD COLUMN endpoint TEXT;
-- Child traffic is routed to the parent's ORIGINATING thread, never whichever is active.
ALTER TABLE agent_inbox ADD COLUMN conversation_id INTEGER REFERENCES agent_conversations(id) ON DELETE SET NULL;
-- What a child run was started with, for the Tasks drawer.
ALTER TABLE agent_jobs ADD COLUMN provider TEXT;
ALTER TABLE agent_jobs ADD COLUMN model TEXT;
ALTER TABLE agent_jobs ADD COLUMN endpoint TEXT;
-- 'openai' (an API key) and 'compat:<name>' rows (an OpenAI-compatible endpoint:
-- its url in meta_json, its key sealed like every other credential). Nothing
-- references this table, so the 007/008 rebuild is safe here.
CREATE TABLE agent_accounts_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider <> ''),
  label TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL,
  access_token TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);
INSERT INTO agent_accounts_new (user_id, provider, label, token_enc, access_token, meta_json, created_at)
SELECT user_id, provider, label, token_enc, access_token, meta_json, created_at FROM agent_accounts;
DROP TABLE agent_accounts;
ALTER TABLE agent_accounts_new RENAME TO agent_accounts;
