-- Optional Jev decision gate on a monitor, beside the embedding gate (`semantic`, whose stored
-- values keep their meaning). NULL = none; the pipeline never reads one unless the owning
-- agent ward's decision switch allows it.
ALTER TABLE agent_monitors ADD COLUMN decision TEXT;
