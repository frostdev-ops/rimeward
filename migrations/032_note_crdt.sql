-- Collaborative notepads (lib/note-room.ts): the Yjs state of a document as last
-- persisted, valid only while crdt_rev equals rev — any write outside the room
-- bumps rev and the room rebuilds from html on its next open. Never replicated by
-- Rime sync (note-sync.ts names its columns): html stays the shared truth.
ALTER TABLE notes ADD COLUMN crdt BLOB;
ALTER TABLE notes ADD COLUMN crdt_rev INTEGER;
