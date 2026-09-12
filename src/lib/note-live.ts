// The notepads' collaboration socket: /api/note/ws/<document>[?ward=<host>][&share=<id>],
// binary y-websocket frames both ways (lib/note-room.ts speaks the protocol).
// One socket per editor; a session or a share opens it (live-stream.ts
// upgradeSession), a share's viewer read-only. A desktop viewing a share is
// refused (409) — that editor keeps the plain save path.
import http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { principalAlive, refuseUpgrade, upgradeSession } from './live-stream.ts';
import { resolveNote } from './note.ts';
import { ensureNoteRooms, handleMessage, joinRoom, leaveRoom, openRoom, type NoteConn, type Room } from './note-room.ts';
import { shareAllows } from './shares.ts';

const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
const ROUTE = /^\/api\/note\/ws\/([a-z0-9-]{1,32})(?:\?|$)/;
const BACKLOG = 16 * 1024 * 1024;

export function noteUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.on('error', () => {});
  const auth = upgradeSession(req);
  if (typeof auth === 'number') { refuseUpgrade(socket, auth); return; }
  if (auth.forward) { refuseUpgrade(socket, 409); return; }
  const m = ROUTE.exec(req.url ?? '');
  if (!m) { refuseUpgrade(socket, 404); return; }
  const url = new URL(req.url!, 'http://localhost');
  if (auth.share && !shareAllows(auth.share, 'GET', url)) { refuseUpgrade(socket, 403); return; }
  const n = resolveNote(auth.userId, m[1], url.searchParams.has('ward'));
  if (!n) { refuseUpgrade(socket, 404); return; }
  let room: Room;
  try { room = openRoom(auth.userId, n.id); }
  catch (err) { refuseUpgrade(socket, (err as { status?: number }).status ?? 500); return; }
  const readOnly = !!auth.share && auth.share.share.role !== 'edit';
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, room, readOnly, auth.id));
}

function attach(ws: WebSocket, room: Room, readOnly: boolean, principal: string): void {
  const conn: NoteConn = {
    readOnly,
    ids: new Set(),
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > BACKLOG) { ws.close(1013, 'Slow receiver'); return; }
      ws.send(data);
    },
    close: (code, reason) => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason); },
  };
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive || !principalAlive(principal)) { ws.terminate(); return; }
    alive = false;
    ws.ping();
  }, 25_000);
  ws.on('pong', () => { alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => { clearInterval(heartbeat); leaveRoom(room, conn); });
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) return;
    if (!principalAlive(principal)) { ws.close(4401, 'Signed out'); return; }
    const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    try { handleMessage(room, conn, new Uint8Array(buf)); }
    catch { ws.close(1008, 'Bad message'); }
  });
  joinRoom(room, conn);
}

export function ensureNoteLive(): void {
  ensureNoteRooms();
  (globalThis as typeof globalThis & { __fdNoteUpgrade?: typeof noteUpgrade }).__fdNoteUpgrade = noteUpgrade;
}
