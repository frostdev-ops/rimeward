// Note events — what the note store and the notebook tell whoever listens
// (logic-engine.ts turns them into notebook leyline firings). A plain
// listener set, no db, no engine import: note.ts and notebook.ts emit,
// the engine subscribes, and neither module has to import the other.

export type NoteEventType = 'created' | 'saved' | 'tagged' | 'moved';
export interface NoteEvent {
  type: NoteEventType;
  userId: number;
  id: string;
  /** The note's home notebook at the time (null = standalone — no notebook ward fires for it). */
  notebook: string | null;
  title: string;
  /** `tagged`: the tags just added; `moved`: the new section id (null = unfiled). */
  tags?: string[];
  section?: string | null;
}

const listeners = new Set<(e: NoteEvent) => void>();
export function onNoteEvent(fn: (e: NoteEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitNoteEvent(e: NoteEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[note-events]', err);
    }
  }
}
