-- Child runs (spawn_agent, and a turn moved to the background with Ctrl+B): an
-- independent thread under the parent ward, never that ward's active thread,
-- linked to its agent_jobs row. Kept out of shared history (sync-store).
ALTER TABLE agent_conversations ADD COLUMN task_id TEXT;
