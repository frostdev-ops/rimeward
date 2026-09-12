// The browser ward's WebSocket: one socket per viewer at /api/browser/ws/<ward>,
// jpeg frames DOWN as binary messages (decoded from CDP's base64 once, latest
// wins against the socket's own write backpressure — no frame timer), every
// other event as JSON text, and the human's command batches UP as JSON text.
// The SSE + POST routes stay for a viewer the desktop relay serves: the relay
// is HTTP and cannot carry an upgrade, so a relayed ward is refused here (409)
// before the upgrade and the client falls back to them.
//
// Input runs on ONE worker per session over ONE ordered queue of single
// commands. A socket ("owner") that closes has its unrun commands purged and a
// `release` control entry appended, so every key/button whose `down` this
// owner EXECUTED is released after whatever is executing and before anything
// a reconnected socket admits. Held state is recorded by the worker after a
// command settles, never at admission.
import http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { browserWard } from '../dashboard.ts';
import { browserScale } from '../wards.ts';
import { principalAlive, refuseUpgrade, upgradeSession } from '../live-stream.ts';
import { shareStillAllows } from '../shares.ts';
import { browserIsRelayed, resolveBrowserDevice } from './routing.ts';
import { normalizeCmds, open, pushState, remoteKey, runCmds, subscribe, type BrowserEvent, type Cmd, type HumanOwner, type Session } from './session.ts';
import { rtcIce, rtcInbound, rtcJoin } from './rtc.ts';

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
const ROUTE = /^\/api\/browser\/ws\/([a-z0-9-]{1,32})(?:\?|$)/;
/** Queued commands / bytes ONE viewer may hold on a session. */
const MAX_QUEUED = 4000;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const TEXT_BACKLOG = 4 * 1024 * 1024;
/** A command the renderer never acknowledges (a page stuck in a busy loop)
 *  must not wedge every viewer's input for the session's life. */
const CMD_MS = 10_000;

interface Owner extends HumanOwner {
  sock: WebSocket;
  session: string;
  ready: boolean;
  dispose: () => void;
  /** This viewer's WebRTC peer on the capture page, while it has one. */
  rtc?: { conn: string; leave: () => void };
}

export function browserUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  // Node drops its own error handler before emitting `upgrade`; until `ws`
  // installs one in handleUpgrade, a reset during the async resolution below
  // would be an uncaught exception.
  socket.on('error', () => {});
  const auth = upgradeSession(req);
  if (typeof auth === 'number') { refuseUpgrade(socket, auth); return; }
  const m = ROUTE.exec(req.url ?? '');
  if (!m) { refuseUpgrade(socket, 404); return; }
  // A share viewed from a desktop app: the frames come over the forwarded SSE + POST path.
  if (auth.forward) { refuseUpgrade(socket, 409); return; }
  const ward = m[1]!, userId = auth.userId;
  const cfg = browserWard(userId, ward);
  if (!cfg) { refuseUpgrade(socket, 400); return; }
  const dsf = browserScale(Number(new URL(req.url!, 'http://localhost').searchParams.get('dsf')));
  // A share's viewer watches the owner's session; only an edit share drives it.
  const readOnly = !!auth.share && auth.share.share.role !== 'edit';
  // Who watches, for the stream's ICE: the grantee, the owner, or nobody (a link).
  const viewer = auth.share ? auth.share.share.grantee : auth.userId;
  void resolveBrowserDevice(userId, ward, cfg).then(placement => {
    if (browserIsRelayed(userId, cfg, placement)) { refuseUpgrade(socket, 409); return; }
    // Every beat asks again: the session, and inside a share its role and reach.
    const live = () => principalAlive(auth.id) && (!auth.share || shareStillAllows(auth.share.share, 'GET', auth.url));
    wss.handleUpgrade(req, socket, head, ws => attach(ws, userId, ward, cfg, auth.id, dsf, readOnly, live, viewer));
  }, () => refuseUpgrade(socket, 503));
}

function attach(ws: WebSocket, userId: number, ward: string, cfg: NonNullable<ReturnType<typeof browserWard>>, session: string, dsf: number, readOnly = false, live: () => boolean = () => principalAlive(session), viewer: number | null = userId): void {
  let s: Session | undefined;
  let unsub: ReturnType<typeof subscribe> | undefined;
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive || !live()) { owner.dispose(); ws.terminate(); return; }
    alive = false; ws.ping();
  }, 25_000);
  const owner: Owner = {
    sock: ws, session, dead: false, ready: false,
    heldKeys: new Set(), heldButtons: new Set(),
    dispose: () => {
      if (owner.dead) return;
      owner.dead = true; owner.ready = false;
      clearInterval(heartbeat);
      owner.rtc?.leave(); owner.rtc = undefined;
      unsub?.(); unsub = undefined;
      if (!s) return;
      s.owners.delete(owner);
      // This owner's unrun input is stale; its executed downs still need an up.
      s.humanQueue = s.humanQueue.filter(e => e.owner !== owner || 'control' in e);
      s.humanBytes = s.humanQueue.reduce((n, e) => n + e.bytes, 0);
      s.humanQueue.push({ owner, control: 'release', bytes: 0 });
      startWorker(s);
    },
  };
  const text = (value: object) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > TEXT_BACKLOG) { ws.close(1013, 'Slow receiver'); return; }
    ws.send(JSON.stringify(value));
  };
  const fail = (code: number, why: string) => { owner.dispose(); if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, why); };
  ws.on('pong', () => { alive = true; });
  ws.on('error', () => owner.dispose());
  ws.on('close', () => owner.dispose());
  ws.on('message', (raw, isBinary) => {
    if (owner.dead) return;
    if (isBinary || !s || !owner.ready) { fail(1008, 'Not ready'); return; }
    const message = raw.toString();
    let body: { cmds?: unknown; rtc?: unknown } | null;
    try { body = JSON.parse(message) as { cmds?: unknown; rtc?: unknown }; } catch { fail(1008, 'Bad batch'); return; }
    // WebRTC signaling for this socket's own peer — an answer or a candidate, from any role.
    if (body && typeof body === 'object' && 'rtc' in body) {
      if (!owner.rtc || !rtcInbound(owner.rtc.conn, body.rtc, s)) fail(1008, 'Bad rtc');
      return;
    }
    if (readOnly) return; // a viewer's input never reaches the page (the client sends none)
    let cmds: Cmd[];
    try { cmds = normalizeCmds(body?.cmds); } catch { fail(1008, 'Bad batch'); return; }
    if (!principalAlive(session)) { fail(4401, 'Signed out'); return; }
    // Admission: bytes are the whole message's, charged to its first surviving
    // entry — a coalesced move never hides a large text command's cost. A
    // message that coalesced away entirely costs nothing: it kept no data.
    let bytes = Buffer.byteLength(message);
    for (const cmd of cmds) {
      const tail = s.humanQueue.at(-1);
      if (cmd.t === 'move' && tail && !('control' in tail) && tail.owner === owner && tail.cmd.t === 'move') { tail.cmd = cmd; continue; }
      s.humanQueue.push({ owner, cmd, bytes });
      s.humanBytes += bytes;
      bytes = 0;
    }
    // The bound is per viewer: a stalled viewer's backlog closes that viewer,
    // never the one who happened to send next.
    let mine = 0, myBytes = 0;
    for (const e of s.humanQueue) if (e.owner === owner) { mine++; myBytes += e.bytes; }
    if (mine > MAX_QUEUED || myBytes > MAX_QUEUED_BYTES) { fail(1008, 'Input backlog'); return; }
    startWorker(s);
  });
  text({ type: 'hello' });

  void open(userId, ward, cfg, { dsf }).then(live => {
    if (owner.dead) return;
    s = live;
    s.owners.add(owner);
    let busy = false, pending: Buffer | null = null;
    const sendFrame = (buf: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      busy = true;
      ws.send(buf, err => {
        busy = false;
        if (err) { ws.terminate(); return; }
        const next = pending; pending = null;
        if (next) sendFrame(next);
      });
    };
    unsub = subscribe(s, (ev: BrowserEvent) => {
      if (ev.type === 'frame') {
        const buf = Buffer.from(ev.data, 'base64');
        if (busy) pending = buf; else sendFrame(buf);
      } else if (ev.type === 'closed') { owner.dispose(); if (ws.readyState === WebSocket.OPEN) ws.close(1000); }
      else text(ev);
    });
    owner.ready = true;
    void pushState(s);
    // The stream, once the capture page is up (the first viewer arrives while it opens):
    // `ice` now, the page's offer next, frames off once the peer connects.
    const jpeg = unsub, sess = s;
    void (sess.streamOpening ?? Promise.resolve()).then(() => {
      if (owner.dead || s !== sess) return;
      owner.rtc = rtcJoin(sess, rtcIce(userId, { userId: viewer }), text, on => jpeg.jpeg(!on)) ?? undefined;
    });
  }, err => {
    if (owner.dead) return;
    text({ type: 'route', online: false, detail: err instanceof Error ? err.message.split('\n')[0]! : 'browser failed to start' } satisfies BrowserEvent);
    fail(1011, 'Browser unavailable');
  });
}

/** The one executor of human WebSocket input on a session. A no-op while
 *  running: message handlers only append. Never rejects. */
function startWorker(s: Session): void {
  if (s.humanWorker) return;
  s.humanWorker = (async () => {
    // `s.humanQueue` is re-read every step: a dispose replaces the array.
    for (;;) {
      const e = s.humanQueue.shift();
      if (!e) break;
      s.humanBytes -= e.bytes;
      const owner = e.owner as Owner;
      if ('control' in e) { await release(s, owner).catch(() => {}); continue; }
      if (owner.dead) continue;
      // Every command boundary re-reads the session row (one indexed lookup,
      // cheaper than the CDP round trip it precedes): a sign-out is terminal
      // for whatever this viewer still has queued.
      if (!principalAlive(owner.session)) { owner.dispose(); owner.sock.close(4401, 'Signed out'); continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the page did not take the input')), CMD_MS); });
      late.catch(() => {});
      try { await Promise.race([runCmds(s, [e.cmd]), late]); }
      catch (err) { if (owner.sock.readyState === WebSocket.OPEN) owner.sock.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message.split('\n')[0] : 'failed' })); }
      finally { clearTimeout(timer); }
      // Held reflects execution — recorded after the await settles, thrown or not.
      const c = e.cmd;
      if (c.t === 'key') { const key = remoteKey(s, c.key); if (key) (c.type === 'up' ? owner.heldKeys.delete(key) : owner.heldKeys.add(key)); }
      else if (c.t === 'down' || c.t === 'up') { const b = typeof c.button === 'number' && Number.isFinite(c.button) ? Math.max(0, Math.min(2, c.button)) : 0; (c.t === 'up' ? owner.heldButtons.delete(b) : owner.heldButtons.add(b)); }
    }
  })().catch(() => {}).finally(() => { s.humanWorker = undefined; if (s.humanQueue.length) startWorker(s); });
}

/** Release what a gone owner still holds — except what another live viewer
 *  holds too (one page, one keyboard state: that press is not ours). */
async function release(s: Session, owner: Owner): Promise<void> {
  const others = [...s.owners] as Owner[];
  const ups: Cmd[] = [
    ...[...owner.heldKeys].filter(k => !others.some(o => o.heldKeys.has(k))).map(key => ({ t: 'key' as const, type: 'up' as const, key })),
    ...[...owner.heldButtons].filter(b => !others.some(o => o.heldButtons.has(b))).map(button => ({ t: 'up' as const, x: 0, y: 0, button })),
  ];
  owner.heldKeys.clear(); owner.heldButtons.clear();
  // The held set stores the REMOTE name (`remoteKey` is a no-op on its own
  // output), so these go through `runCmds` and land as themselves.
  for (let i = 0; i < ups.length; i += 200) await runCmds(s, ups.slice(i, i + 200));
}

export function ensureBrowserLive(): void {
  (globalThis as typeof globalThis & { __fdBrowserUpgrade?: typeof browserUpgrade }).__fdBrowserUpgrade = browserUpgrade;
}
