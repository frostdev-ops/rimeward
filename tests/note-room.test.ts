import './_setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { createUser } from '../src/lib/users.ts';
import { getDb } from '../src/lib/db.ts';
import { noteExists, purgeNote, readNote, writeNote } from '../src/lib/note.ts';
import { pageDocument } from '../src/lib/notebook-pages.ts';
import { docToHtml } from '../src/lib/note-pm.ts';
import { noteSchema } from '../src/lib/note-schema.ts';
import { MSG_AWARENESS, MSG_STATUS, MSG_SYNC, closeRoom, ensureNoteRooms, handleMessage, joinRoom, leaveRoom, openRoom, openRooms, peekRoom, persistRoom, roomHtml, type NoteConn } from '../src/lib/note-room.ts';

ensureNoteRooms();
const user = createUser('room@example.com', 'pw-room-1');
// A room's awareness timer holds the event loop: a failed assertion must not hang the run.
after(() => { for (const r of openRooms()) closeRoom(r, 1000, 'closed', true); });

/** A client: its own Y.Doc, wired to the room through the wire protocol like the browser provider is. */
function client(readOnly = false) {
  const doc = new Y.Doc();
  const inbox: Uint8Array[] = [];
  const conn: NoteConn = { readOnly, ids: new Set(), send: (d) => inbox.push(d), close: () => {} };
  const outbox: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin === 'room') return; const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_SYNC); syncProtocol.writeUpdate(e, u); outbox.push(encoding.toUint8Array(e)); });
  const html = () => docToHtml(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), noteSchema));
  /** Deliver what the room sent us; answer its sync steps like the provider does. */
  const drain = (room: ReturnType<typeof openRoom>) => {
    for (const msg of inbox.splice(0)) {
      const dec = decoding.createDecoder(msg);
      const type = decoding.readVarUint(dec);
      if (type !== MSG_SYNC) { inbox.push(msg); continue; } // awareness and status frames stay for the test to read
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, e, doc, 'room');
      if (encoding.length(e) > 1) handleMessage(room, conn, encoding.toUint8Array(e));
    }
  };
  const flush = (room: ReturnType<typeof openRoom>) => { for (const m of outbox.splice(0)) handleMessage(room, conn, m); };
  /** Connect like the provider does: join, send our own step 1, then take the room's answers. */
  const join = (room: ReturnType<typeof openRoom>) => {
    joinRoom(room, conn);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, doc);
    handleMessage(room, conn, encoding.toUint8Array(e));
    drain(room);
  };
  const paragraph = (text: string) => { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText(text)]); return p; };
  return { doc, conn, inbox, html, drain, flush, join, paragraph };
}

test('a room builds the shared document from the stored HTML and persists what its editors change', () => {
  writeNote(user, 'doc1', { html: '<p>one</p><p>two</p>' });
  const room = openRoom(user, 'doc1');
  assert.equal(roomHtml(room), '<p>one</p><p>two</p>');
  const a = client(), b = client();
  a.join(room); b.join(room);
  assert.equal(a.html(), '<p>one</p><p>two</p>', 'the first sync brings the document');
  a.doc.getXmlFragment('prosemirror').insert(0, [a.paragraph('zero')]);
  b.doc.getXmlFragment('prosemirror').push([b.paragraph('three')]);
  a.flush(room); b.flush(room);
  a.drain(room); b.drain(room);
  assert.equal(roomHtml(room), '<p>zero</p><p>one</p><p>two</p><p>three</p>', 'both edits merged');
  assert.equal(a.html(), b.html(), 'every editor converges');
  assert.equal(a.html(), roomHtml(room));
  assert.ok(persistRoom(room), 'the row changed');
  const note = readNote(user, 'doc1');
  assert.equal(note.html, '<p>zero</p><p>one</p><p>two</p><p>three</p>');
  const row = getDb().prepare('SELECT crdt, crdt_rev, rev FROM notes WHERE user_id = ? AND ward = ?').get(user, 'doc1') as { crdt: Buffer; crdt_rev: number; rev: number };
  assert.ok(row.crdt.length > 0);
  assert.equal(row.crdt_rev, row.rev);
  assert.equal(persistRoom(room), false, 'nothing new to write');
  leaveRoom(room, a.conn); leaveRoom(room, b.conn);
  assert.equal(peekRoom(user, 'doc1'), undefined, 'the last editor leaving closes the room');
  const again = openRoom(user, 'doc1');
  assert.equal(roomHtml(again), '<p>zero</p><p>one</p><p>two</p><p>three</p>', 'reopened from the stored Yjs state');
  closeRoom(again);
});

test('a viewer receives everything and changes nothing', () => {
  writeNote(user, 'doc2', { html: '<p>kept</p>' });
  const room = openRoom(user, 'doc2');
  const v = client(true);
  v.join(room);
  assert.equal(v.html(), '<p>kept</p>');
  v.doc.getXmlFragment('prosemirror').push([v.paragraph('sneaked in')]);
  v.flush(room);
  assert.equal(roomHtml(room), '<p>kept</p>', 'a viewer’s update is dropped');
  const editor = client();
  editor.join(room);
  const bad = encoding.createEncoder();
  encoding.writeVarUint(bad, MSG_AWARENESS);
  assert.throws(() => handleMessage(room, editor.conn, encoding.toUint8Array(bad)), 'a malformed frame throws; the socket layer closes 1008');
  // A viewer cannot touch anyone's presence either — not even to announce themselves (lib/shares.ts joinPresence does that).
  const aw = new awarenessProtocol.Awareness(v.doc);
  aw.setLocalStateField('user', { name: 'Vera' });
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_AWARENESS);
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]));
  handleMessage(room, v.conn, encoding.toUint8Array(e));
  assert.equal(room.awareness.getStates().size, 0, 'a viewer’s awareness is dropped');
  handleMessage(room, editor.conn, encoding.toUint8Array(e));
  assert.deepEqual([...room.awareness.getStates().values()].map((st) => (st as { user?: { name: string } }).user?.name), ['Vera'], 'an editor’s lands');
  assert.ok(editor.conn.ids.has(aw.clientID));
  leaveRoom(room, v.conn); leaveRoom(room, editor.conn);
  aw.destroy();
  assert.equal(peekRoom(user, 'doc2'), undefined, 'the last one left');
});

test('a write from outside the room lands in the live document and reaches its editors', () => {
  writeNote(user, 'doc3', { html: '<p>before</p>' });
  const room = openRoom(user, 'doc3');
  const a = client();
  a.join(room);
  writeNote(user, 'doc3', { html: '<h1>Rime wrote this</h1><p>before</p>' }); // what write_note does
  assert.equal(roomHtml(room), '<h1>Rime wrote this</h1><p>before</p>');
  a.drain(room);
  assert.equal(a.html(), '<h1>Rime wrote this</h1><p>before</p>', 'the editor received the change');
  persistRoom(room);
  const row = getDb().prepare('SELECT crdt_rev, rev FROM notes WHERE user_id = ? AND ward = ?').get(user, 'doc3') as { crdt_rev: number; rev: number };
  assert.equal(row.crdt_rev, row.rev, 'the Yjs state is stored at the new rev');
  closeRoom(room);
  // No room open: the store moves on, the Yjs state falls behind, the next open rebuilds from HTML.
  writeNote(user, 'doc3', { html: '<p>after</p>' });
  const stale = getDb().prepare('SELECT crdt_rev, rev FROM notes WHERE user_id = ? AND ward = ?').get(user, 'doc3') as { crdt_rev: number; rev: number };
  assert.notEqual(stale.crdt_rev, stale.rev);
  const reopened = openRoom(user, 'doc3');
  assert.equal(roomHtml(reopened), '<p>after</p>');
  closeRoom(reopened);
});

test('ink rides the room as its own shared list; a structured page is refused', () => {
  writeNote(user, 'doc4', { html: '<p>x</p>', ink: '[{"c":"#000","w":2,"p":[[1,2,0.5]]}]' });
  const room = openRoom(user, 'doc4');
  assert.equal(room.ink.length, 1);
  assert.equal(typeof (room.ink.get(0) as { id?: unknown }).id, 'string', 'a stroke from before the room gets the id the eraser deletes by');
  room.ink.push([{ c: '#f00', w: 3, p: [[3, 4, 1]] }]);
  assert.ok(persistRoom(room));
  assert.equal(JSON.parse(readNote(user, 'doc4').ink).length, 2);
  closeRoom(room);
  writeNote(user, 'page1', { html: pageDocument('spreadsheet', { version: 1 }) });
  assert.throws(() => openRoom(user, 'page1'), (e: { status?: number }) => e.status === 426);
});

const statusFrames = (inbox: Uint8Array[]) => inbox.filter((m) => decoding.readVarUint(decoding.createDecoder(m)) === MSG_STATUS).map((m) => { const d = decoding.createDecoder(m); decoding.readVarUint(d); return JSON.parse(decoding.readVarString(d)) as { persist: string; message?: string }; });

test('a save the store refuses keeps the room and tells the editors; it lands once the cause is gone', () => {
  writeNote(user, 'doc5', { html: '<p>x</p>' });
  const room = openRoom(user, 'doc5');
  const a = client();
  a.join(room);
  // 2 MB of ink is over the store's cap: the write fails, the room stays, the editor hears why.
  room.ink.push([{ c: '#000', w: 2, p: Array.from({ length: 200_000 }, (_, i) => [i, i, 0.5]) }]);
  assert.equal(persistRoom(room), true, 'the row would have changed');
  assert.match(room.failed ?? '', /ink/i);
  assert.ok(room.timer, 'a retry is armed');
  assert.equal(statusFrames(a.inbox).at(-1)?.persist, 'error');
  assert.equal(readNote(user, 'doc5').html, '<p>x</p>', 'nothing was written');
  leaveRoom(room, a.conn);
  assert.equal(peekRoom(user, 'doc5'), room, 'the last editor leaving cannot close a room whose save is refused');
  const b = client();
  b.join(room);
  assert.equal(statusFrames(b.inbox).at(-1)?.persist, 'error', 'a late joiner hears it too');
  room.ink.delete(0, room.ink.length);
  persistRoom(room);
  assert.equal(room.failed, undefined);
  assert.equal(statusFrames(b.inbox).at(-1)?.persist, 'ok');
  leaveRoom(room, b.conn);
  assert.equal(peekRoom(user, 'doc5'), undefined);
});

test('a purge ends the room without a save of its own; an unreadable document closes without a throw', () => {
  writeNote(user, 'doc6', { html: '<p>a</p>' });
  const room = openRoom(user, 'doc6');
  const a = client();
  a.join(room);
  a.doc.getXmlFragment('prosemirror').push([a.paragraph('typed')]);
  a.flush(room);
  assert.ok(room.dirty);
  getDb().prepare("UPDATE notes SET trashed_at = datetime('now') WHERE user_id = ? AND ward = ?").run(user, 'doc6'); // only the trash can be emptied
  purgeNote(user, 'doc6');
  assert.equal(peekRoom(user, 'doc6'), undefined, 'the room went with the note');
  assert.ok(!noteExists(user, 'doc6'), 'and did not resurrect it');

  writeNote(user, 'doc7', { html: '<p>fine</p>' });
  const bad = openRoom(user, 'doc7');
  const closes: number[] = [];
  const conn: NoteConn = { readOnly: false, ids: new Set(), send: () => {}, close: (code) => closes.push(code) };
  joinRoom(bad, conn);
  bad.doc.transact(() => { (bad.fragment as unknown as { insert(i: number, c: unknown[]): void }).insert(0, [new Y.Map()]); }, conn);
  assert.doesNotThrow(() => persistRoom(bad), 'a foreign Yjs type in the fragment is not a process crash');
  assert.deepEqual(closes, [1011]);
  assert.equal(peekRoom(user, 'doc7'), undefined);
  assert.equal(readNote(user, 'doc7').html, '<p>fine</p>', 'the last good state stands');
});
