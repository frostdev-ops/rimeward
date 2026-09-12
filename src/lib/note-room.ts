// Collaborative notepads: one Yjs document per open note, shared by every editor
// on it (the owner's, a collaborator's through a share) over the socket in
// note-live.ts. The room speaks y-websocket's wire protocol (y-protocols sync +
// awareness), so the stock client provider talks to it unchanged.
//
// The notes table stays the truth every other surface reads: 800 ms after the
// last change (and when the last editor leaves) the room serializes the shared
// document back to HTML through the same schema and sanitizer as the editor
// (note-pm.ts) and writes it with writeNote — FTS, excerpt, note links, the
// notebook leylines and the `note` broadcast all keep working — then stores the
// Yjs state beside it (`crdt`, valid while `crdt_rev` = `rev`). A write from
// anywhere else (Rime's write_note, a legacy PUT, a sync install) reaches the
// room through noteWriteHooks and is reconciled into the live document; with no
// room open, the rev moves past crdt_rev and the next open rebuilds from HTML.
// Structured pages (spreadsheet, slides…) keep their own editors: refused here.
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { getDb } from './db.ts';
import { broadcast } from './logic-engine.ts';
import { noteWriteHooks, readNote, writeNote } from './note.ts';
import { docToHtml, htmlToDoc } from './note-pm.ts';
import { noteSchema } from './note-schema.ts';
import { readPageDocument } from './notebook-pages.ts';

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;
export const PERSIST_MS = 800;

/** One editor's connection as the room sees it (note-live.ts wraps a socket; tests fake one). */
export interface NoteConn {
  /** A share's viewer: sees everything, changes nothing. */
  readOnly: boolean;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  /** The awareness client ids this connection announced — cleared when it leaves. */
  ids: Set<number>;
}
export interface Room {
  owner: number;
  id: string;
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  ink: Y.Array<unknown>;
  awareness: awarenessProtocol.Awareness;
  conns: Set<NoteConn>;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
  /** The room's own write in flight: the store hook must not echo it back. */
  persisting: boolean;
  closing: boolean;
  /** The stored rev the room last saw, in step with `crdt_rev`. */
  rev: number;
}

const g = globalThis as typeof globalThis & { __fdNoteRooms?: Map<string, Room> };
const rooms = (g.__fdNoteRooms ??= new Map<string, Room>());
const key = (owner: number, id: string) => `${owner}:${id}`;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const strokesOf = (ink: string): unknown[] => {
  try { const v = JSON.parse(ink); return Array.isArray(v) ? v : []; } catch { return []; }
};
const replaceInk = (arr: Y.Array<unknown>, ink: string) => {
  const next = strokesOf(ink);
  if (JSON.stringify(arr.toJSON()) === JSON.stringify(next)) return;
  if (arr.length) arr.delete(0, arr.length);
  if (next.length) arr.push(next);
};

/** The document as HTML, exactly what the room would persist. */
export const roomHtml = (room: Room): string => docToHtml(yXmlFragmentToProseMirrorRootNode(room.fragment, noteSchema));
export const peekRoom = (owner: number, id: string): Room | undefined => rooms.get(key(owner, id));
/** Every open room (tests close them; the stop handler persists them). */
export const openRooms = (): Room[] => [...rooms.values()];

/** The room for a document, opened from the stored Yjs state when it is current,
 *  else built from the HTML. Throws 426 for a structured page. */
export function openRoom(owner: number, id: string): Room {
  const k = key(owner, id);
  const have = rooms.get(k);
  if (have && !have.closing) return have;
  const note = readNote(owner, id);
  if (readPageDocument(note.html)) throw fail(426, 'a structured page has its own editor');
  const doc = new Y.Doc({ gc: true });
  const fragment = doc.getXmlFragment('prosemirror');
  const ink = doc.getArray<unknown>('ink');
  const stored = getDb().prepare('SELECT crdt, crdt_rev FROM notes WHERE user_id = ? AND ward = ?').get(owner, id) as { crdt: Buffer | null; crdt_rev: number | null } | undefined;
  if (stored?.crdt && stored.crdt_rev === note.rev) Y.applyUpdate(doc, new Uint8Array(stored.crdt), 'store');
  else doc.transact(() => { prosemirrorToYXmlFragment(htmlToDoc(note.html), fragment); replaceInk(ink, note.ink); }, 'store');
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const room: Room = { owner, id, doc, fragment, ink, awareness, conns: new Set(), dirty: false, persisting: false, closing: false, rev: note.rev };
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const buf = encoding.toUint8Array(enc);
    for (const c of room.conns) if (c !== origin) c.send(buf);
    if (origin !== 'store') schedulePersist(room);
  });
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const conn = origin as NoteConn | null;
    if (conn && typeof conn === 'object' && 'ids' in conn) { for (const i of added) conn.ids.add(i); for (const i of removed) conn.ids.delete(i); }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
    const buf = encoding.toUint8Array(enc);
    for (const c of room.conns) c.send(buf);
  });
  rooms.set(k, room);
  return room;
}

export function joinRoom(room: Room, conn: NoteConn): void {
  room.conns.add(conn);
  // Step 1: our state vector; the client answers with what we lack and asks for the rest.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  conn.send(encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size) {
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MSG_AWARENESS);
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    conn.send(encoding.toUint8Array(aw));
  }
}

export function leaveRoom(room: Room, conn: NoteConn): void {
  if (!room.conns.delete(conn)) return;
  awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.ids], null);
  conn.ids.clear();
  if (!room.conns.size) closeRoom(room);
}

/** One message from an editor: a sync step or update (a viewer's updates are
 *  dropped), an awareness update, or a request for everyone's awareness. */
export function handleMessage(room: Room, conn: NoteConn, data: Uint8Array): void {
  const dec = decoding.createDecoder(data);
  const type = decoding.readVarUint(dec);
  if (type === MSG_SYNC) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const step = decoding.readVarUint(dec);
    if (step === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(dec, enc, room.doc);
    else if (conn.readOnly) return;
    else if (step === syncProtocol.messageYjsSyncStep2) syncProtocol.readSyncStep2(dec, room.doc, conn);
    else if (step === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(dec, room.doc, conn);
    if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
  } else if (type === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), conn);
  } else if (type === MSG_QUERY_AWARENESS) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
    conn.send(encoding.toUint8Array(enc));
  }
}

function schedulePersist(room: Room): void {
  room.dirty = true;
  if (room.timer || room.closing) return;
  room.timer = setTimeout(() => { room.timer = undefined; persistRoom(room); }, PERSIST_MS);
}

/** Write the shared document back to the store: HTML and ink through the same
 *  path every save takes, then the Yjs state at that rev. True = the row changed. */
export function persistRoom(room: Room): boolean {
  if (room.timer) { clearTimeout(room.timer); room.timer = undefined; }
  room.dirty = false;
  const cur = readNote(room.owner, room.id);
  const html = roomHtml(room);
  const ink = JSON.stringify(room.ink.toJSON());
  const changed = html !== cur.html || ink !== cur.ink;
  room.persisting = true;
  try {
    let rev = cur.rev;
    if (changed) {
      rev = writeNote(room.owner, room.id, { html, ink, force: true }).rev;
      // Lists, other surfaces of this document and the owner's other tabs follow; editors on the room ignore it.
      broadcast(room.owner, 'note', { note: room.id, rev, room: true });
    }
    getDb().prepare('UPDATE notes SET crdt = ?, crdt_rev = ? WHERE user_id = ? AND ward = ?').run(Buffer.from(Y.encodeStateAsUpdate(room.doc)), rev, room.owner, room.id);
    room.rev = rev;
  } catch (err) {
    console.error('[note-room] persist failed:', err);
    room.dirty = true;
  } finally {
    room.persisting = false;
  }
  return changed;
}

export function closeRoom(room: Room, code = 1000, reason = 'closed'): void {
  if (room.closing) return;
  room.closing = true;
  if (room.dirty || room.timer) persistRoom(room);
  for (const c of room.conns) { try { c.close(code, reason); } catch {} }
  room.conns.clear();
  room.awareness.destroy();
  room.doc.destroy();
  if (rooms.get(key(room.owner, room.id)) === room) rooms.delete(key(room.owner, room.id));
}

/** A write from outside the room (Rime, a legacy PUT, a sync install) lands in
 *  the live document; a purge or a turn into a structured page ends the room. */
function onNoteWritten(owner: number, id: string, kind: 'write' | 'gone'): void {
  const room = rooms.get(key(owner, id));
  if (!room || room.persisting || room.closing) return;
  if (kind === 'gone') { closeRoom(room, 4404, 'deleted'); return; }
  const note = readNote(owner, id);
  if (readPageDocument(note.html)) { closeRoom(room, 4426, 'now a structured page'); return; }
  if (note.html === roomHtml(room) && note.ink === JSON.stringify(room.ink.toJSON())) { room.rev = note.rev; schedulePersist(room); return; }
  room.doc.transact(() => { prosemirrorToYXmlFragment(htmlToDoc(note.html), room.fragment); replaceInk(room.ink, note.ink); }, 'store');
  room.rev = note.rev;
  schedulePersist(room); // the row is already right; this stores the Yjs state at its rev
}

/** Once per process: the store's write hook, and a clean stop that persists every room. */
export function ensureNoteRooms(): void {
  const gg = globalThis as typeof globalThis & { __fdNoteRoomsHooked?: boolean };
  if (gg.__fdNoteRoomsHooked) return;
  gg.__fdNoteRoomsHooked = true;
  noteWriteHooks.add(onNoteWritten);
  const stop = () => { for (const room of [...rooms.values()]) closeRoom(room, 1001, 'server stopping'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
