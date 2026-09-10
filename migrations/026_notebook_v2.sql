-- Notebook v2: per-notebook typed properties (a schema on the notebook, values
-- on the note), template notes, and the note-to-note link table backlinks are
-- read from. Nothing here changes what a Notepad or the v1 notebook stored.
ALTER TABLE notes ADD COLUMN props TEXT NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notebooks ADD COLUMN props TEXT NOT NULL DEFAULT '[]';

-- Links a note's HTML makes to other notes (<a data-note="id">), rebuilt on
-- every save of the source; a backlink list is the rows whose dst is the note.
CREATE TABLE note_links (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (user_id, src, dst)
);
CREATE INDEX note_links_dst ON note_links (user_id, dst);
