-- Monitor traffic is its own transcript source. Only the server ever wrote user-role rows
-- with source 'automation', so these literal prefixes identify a monitor's own rows exactly:
-- the client folds them into collapsed activity instead of drawing them as the user's words.
UPDATE agent_messages SET source = 'monitor'
WHERE role = 'user' AND source = 'automation'
  AND (text LIKE '[Monitor observation — %'
    OR text LIKE '[Stopped monitors]%'
    OR text = 'Scheduled: Read the matching monitor observations and report relevant findings.');
