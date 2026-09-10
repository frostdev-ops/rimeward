-- Notebooks organize notepad documents. The notes table stays THE document
-- store and `ward` stays the document id (a legacy Notepad's document id IS
-- its ward id); these columns are the note's metadata inside a notebook — a
-- home notebook, a section, tags, a pin, a manual position, archive and
-- trash stamps, the first lines of its text for lists, and a revision counter every save bumps (stale-write guard).
ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN notebook TEXT;
ALTER TABLE notes ADD COLUMN section TEXT;
ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN ord INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN archived_at TEXT;
ALTER TABLE notes ADD COLUMN trashed_at TEXT;
ALTER TABLE notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
UPDATE notes SET created_at = updated_at WHERE created_at = '';
CREATE INDEX notes_notebook ON notes (user_id, notebook);

-- A notebook: a title plus its sections and saved views as small JSON lists
-- (lib/notebook.ts validates both). A Notebook ward's notebook id defaults to
-- its ward id, the way a Notepad's document does; a ward leaving the layout
-- keeps the row, like a note.
CREATE TABLE notebooks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  sections TEXT NOT NULL DEFAULT '[]',
  views TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

-- Full-text index over a note's title, plain text (what the HTML reads as —
-- transcribed handwriting included, ink itself never) and tags. Kept in step
-- by lib/note.ts on every save; db.ts backfills the rows from before, once.
CREATE VIRTUAL TABLE notes_fts USING fts5(user_id UNINDEXED, id UNINDEXED, title, body, tags, tokenize = 'unicode61 remove_diacritics 2');
