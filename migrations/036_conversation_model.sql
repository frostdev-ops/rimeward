-- The model a thread actually ran on: stamped at every run start and every set_model switch with the
-- VALIDATED selection the provider was called with. Continuing an ended thread reads it back; a NULL
-- (a thread from before this column, or one that never ran) is "not recorded" — never backfilled from
-- a ward's current default.
ALTER TABLE agent_conversations ADD COLUMN model TEXT;
