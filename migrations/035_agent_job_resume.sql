-- Resume of finished child runs (B11): a resume is a NEW agent_jobs row linked to the attempt it
-- continues; the original row is never edited. `lineage` is the root attempt id on every resumed
-- row (a root keeps NULL), so "one live attempt per lineage" is one indexed lookup.
-- `stopped_by` is structured stop provenance — who stopped a cancelled/interrupted job — kept
-- beside the human-readable error, never parsed back out of it.
ALTER TABLE agent_jobs ADD COLUMN resumed_from TEXT;
ALTER TABLE agent_jobs ADD COLUMN lineage TEXT;
ALTER TABLE agent_jobs ADD COLUMN stopped_by TEXT;
-- `ran` is execution provenance: 0 = the row was reserved but refused before anything could run
-- (a failed identity check; its record is an audit line, never a resumable source and never a block
-- on its lineage), 1 = the run started. Rows from before this migration ran.
ALTER TABLE agent_jobs ADD COLUMN ran INTEGER NOT NULL DEFAULT 1;
-- Who asked for a resumed attempt: 'user' (the Tasks drawer, server-verified) or 'agent' (task_resume).
ALTER TABLE agent_jobs ADD COLUMN resume_actor TEXT;
CREATE INDEX agent_jobs_lineage ON agent_jobs(user_id, lineage);
CREATE INDEX agent_jobs_resumed_from ON agent_jobs(resumed_from);
