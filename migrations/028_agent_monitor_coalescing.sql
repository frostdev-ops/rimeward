-- Bound pending payload storage without losing the number of coalesced matches.
ALTER TABLE agent_monitor_events ADD COLUMN coalesced INTEGER NOT NULL DEFAULT 1;
