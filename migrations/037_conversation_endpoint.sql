-- The BACKEND a compat thread actually ran against, captured at run start beside the model. An
-- endpoint NAME is a per-runtime alias: repointing it, or removing and re-adding it, must not
-- rewrite what an older conversation says it ran on, and a history read must never have to unseal
-- today's key to answer the question. NULL = not recorded (a thread from before this column, or one
-- that never ran) — never backfilled from the endpoint's current URL.
ALTER TABLE agent_conversations ADD COLUMN endpoint_url TEXT;
