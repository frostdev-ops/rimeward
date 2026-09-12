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
import { readNote, writeNote } from '../src/lib/note.ts';
import { pageDocument } from '../src/lib/notebook-pages.ts';
import { docToHtml } from '../src/lib/note-pm.ts';
import { noteSchema } from '../src/lib/note-schema.ts';
import { MSG_AWARENESS, MSG_SYNC, closeRoom, ensureNoteRooms, handleMessage, joinRoom, leaveRoom, openRoom, openRooms, peekRoom, persistRoom, roomHtml, type NoteConn } from '../src/lib/note-room.ts';

ensureNoteRooms();
const user = createUser('room@example.com', 'pw-room-1');
// A room's awareness timer holds the event loop: a failed assertion must not hang the run.
after(() => { for (const r of openRooms()) closeRoom(r); });

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
      if (type !== MSG_SYNC) continue;
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
  const bad = encoding.createEncoder();
  encoding.writeVarUint(bad, MSG_AWARENESS);
  assert.throws(() => handleMessage(room, v.conn, encoding.toUint8Array(bad)), 'a malformed frame throws; the socket layer closes 1008');
  // A viewer's presence still counts: their awareness state joins the room and leaves with them.
  const aw = new awarenessProtocol.Awareness(v.doc);
  aw.setLocalStateField('user', { name: 'Vera' });
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_AWARENESS);
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]));
  handleMessage(room, v.conn, encoding.toUint8Array(e));
  assert.deepEqual([...room.awareness.getStates().values()].map((st) => (st as { user?: { name: string } }).user?.name), ['Vera']);
  assert.ok(v.conn.ids.has(aw.clientID));
  leaveRoom(room, v.conn);
  aw.destroy();
  assert.equal(peekRoom(user, 'doc2'), undefined, 'the viewer was the last one in');
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
  room.ink.push([{ c: '#f00', w: 3, p: [[3, 4, 1]] }]);
  assert.ok(persistRoom(room));
  assert.equal(JSON.parse(readNote(user, 'doc4').ink).length, 2);
  closeRoom(room);
  writeNote(user, 'page1', { html: pageDocument('spreadsheet', { version: 1 }) });
  assert.throws(() => openRoom(user, 'page1'), (e: { status?: number }) => e.status === 426);
});
