-- Per-monitor alert delivery rate limit (seconds between deliveries) and the last delivery time.
ALTER TABLE agent_monitors ADD COLUMN min_interval_seconds INTEGER NOT NULL DEFAULT 5;
ALTER TABLE agent_monitors ADD COLUMN delivered_at INTEGER;
