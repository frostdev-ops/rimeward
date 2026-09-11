import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { getDb } from '../src/lib/db.ts';
import { createSession, destroySession, SESSION_COOKIE } from '../src/lib/auth.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { browserUpgrade } from '../src/lib/browser/live.ts';
import { browserIsRelayed, routeBrowser } from '../src/lib/browser/routing.ts';
import { closeSession, open, peek, type Session } from '../src/lib/browser/session.ts';
import { browserScale } from '../src/lib/wards.ts';

// The browser ward's WebSocket (lib/browser/live.ts) against a real headless
// Chromium: the handshake, binary HiDPI frames, and the one-worker input queue
// under every disconnect sequence the design promises — held state recorded
// at execution, a gone viewer's unrun input purged, its executed downs
// released after the executing command and before a reconnected viewer's
// first command, another viewer's press left alone, bounds and sign-out.
// Skips where no chromium is installed.

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

type Msg = { type: string; [k: string]: unknown };
interface Client {
  ws: WebSocket;
  msgs: Msg[];
  frames: Buffer[];
  closed: Promise<number>;
  /** The first message matching, already received or still to come. */
  next(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  frame(ms?: number): Promise<Buffer>;
  send(cmds: unknown): void;
}

let base = '';
function client(ward: string, session: string, dsf?: number): Client {
  const ws = new WebSocket(`ws://${base}/api/browser/ws/${ward}${dsf === undefined ? '' : `?dsf=${dsf}`}`, { origin: `http://${base}`, headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  const msgs: Msg[] = [], frames: Buffer[] = [];
  const waiters: (() => void)[] = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) frames.push(raw as Buffer); else msgs.push(JSON.parse(raw.toString()));
    wake();
  });
  const closed = new Promise<number>(resolve => { ws.on('close', code => { resolve(code); wake(); }); ws.on('error', () => {}); });
  const c: Client = {
    ws, msgs, frames, closed,
    next: (pred, ms = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no message within ${ms}ms; got ${JSON.stringify(msgs.map(m => m.type))}`)), ms);
      const check = () => { const m = msgs.find(pred); if (m) { clearTimeout(timer); resolve(m); return; } waiters.push(check); };
      check();
    }),
    frame: (ms = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame within ${ms}ms`)), ms);
      const check = () => { const f = frames.at(-1); if (f) { clearTimeout(timer); resolve(f); return; } waiters.push(check); };
      check();
    }),
    send: cmds => ws.send(JSON.stringify({ cmds })),
  };
  return c;
}

/** Width × height from a JPEG's SOF marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  for (let i = 2; i < buf.length - 9; i++) {
    if (buf[i] !== 0xff) continue;
    const marker = buf[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
  }
  throw new Error('no SOF marker');
}

/** The status an upgrade is refused with (a status line, never a socket). */
async function refused(ward: string, cookie: string, origin: string): Promise<number | undefined> {
  const ws = new WebSocket(`ws://${base}/api/browser/ws/${ward}`, { origin, headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  ws.on('error', () => {});
  const [req, res] = await once(ws, 'unexpected-response') as [http.ClientRequest, http.IncomingMessage];
  req.destroy();
  return res.statusCode;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error(`${what} not met within ${ms}ms`); await sleep(20); }
}

test('browserScale: the display ratio clamped 1–2 in quarter steps, 1 for anything else', () => {
  assert.equal(browserScale(2), 2);
  assert.equal(browserScale(1.3), 1.25);
  assert.equal(browserScale(3), 2);
  assert.equal(browserScale(0.5), 1);
  assert.equal(browserScale(NaN), 1);
  assert.equal(browserScale('2'), 1);
  assert.equal(browserScale(undefined), 1);
});

test('browserIsRelayed: a foreign device relays, this computer or no device serves locally', () => {
  const cfg = { backend: 'app' as const };
  assert.equal(browserIsRelayed(1, cfg, { device: 'a', pairId: 'b', desktop: true }), true);
  assert.equal(browserIsRelayed(1, cfg, { device: 'a', pairId: 'a', desktop: true }), false);
  assert.equal(browserIsRelayed(1, cfg, { device: 'a', desktop: false }), true);
  assert.equal(browserIsRelayed(1, cfg, { desktop: false }), false);
  assert.equal(browserIsRelayed(1, { backend: 'local' }, { pairId: 'p', desktop: true }), false); // not joined
});

test('a request the relay already delivered to this desktop is served before any resolution', async () => {
  const env = { desktop: process.env.RIMEWARD_DESKTOP, token: process.env.RIMEWARD_NATIVE_TOKEN };
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'relay-fixture';
  try {
    const uid = seedUser('relayed@test'), device = randomUUID();
    // Pinned to another computer: resolving this ward would relay it.
    saveDashboard(uid, [{ i: 'far', type: 'browser', size: '3x2', device, config: { backend: 'app' } }]);
    const request = new Request('http://localhost/api/browser/far', { headers: { 'x-rimeward-relayed': '1', 'x-rimeward-native-token': 'relay-fixture' } });
    assert.equal(await routeBrowser(uid, 'far', request), undefined);
    const wrong = new Request('http://localhost/api/browser/far', { headers: { 'x-rimeward-relayed': '1', 'x-rimeward-native-token': 'nope' } });
    await assert.rejects(routeBrowser(uid, 'far', wrong)); // no short-circuit: resolution runs (and cannot reach that desktop here)
  } finally {
    if (env.desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = env.desktop;
    if (env.token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = env.token;
  }
});

test('the ward WebSocket: handshake, HiDPI frames, and the one-worker input queue under every disconnect', async (t) => {
  const uid = seedUser('live@test');
  const sid = createSession(uid).id;
  saveDashboard(uid, [
    { i: 'bw', type: 'browser', size: '3x2', config: { backend: 'local' } },
    { i: 'far', type: 'browser', size: '3x2', device: randomUUID(), config: { backend: 'app' } },
    { i: 'note', type: 'note', size: '1x1' },
  ]);
  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', browserUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  let s: Session | undefined;
  try {
    // Refusals happen BEFORE the upgrade: a status line, never a `hello`.
    for (const [ward, cookie, status] of [['note', sid, 400], ['bw', 'nope', 401], ['far', sid, 409]] as const) {
      assert.equal(await refused(ward, cookie, `http://${base}`), status, ward);
    }
    assert.equal(await refused('bw', sid, 'http://evil.test'), 403);

    // The first viewer launches the browser: `hello` arrives at once, then
    // input before `view` is a protocol error, and that close DURING the
    // launch leaves no subscription or owner behind.
    const early = client('bw', sid, 2);
    await early.next(m => m.type === 'hello');
    assert.equal(early.msgs.length, 1, 'hello is the first message');
    early.send([{ t: 'reload' }]);
    assert.equal(await early.closed, 1008);
    assert.equal(early.msgs.some(m => m.type === 'view'), false);
    try { s = await open(uid, 'bw', { backend: 'local' }); }
    catch (err) {
      if (existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) throw err;
      t.skip(`no chromium here: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      return;
    }
    assert.equal(s.dsf, 2, 'launched at the first viewer\'s scale');
    assert.equal(s.subs.size, 0); assert.equal(s.owners.size, 0);

    // Handshake and a binary frame at device pixels.
    const a = client('bw', sid, 1.5);
    await a.next(m => m.type === 'hello');
    const view = await a.next(m => m.type === 'view');
    assert.equal(view.dsf, 2, 'the session\'s scale, fixed at launch, not this viewer\'s');
    await a.next(m => m.type === 'tabs');
    const frame = await a.frame();
    assert.deepEqual(jpegSize(frame), { width: s.viewport.width * 2, height: s.viewport.height * 2 });

    // The page records what actually reaches it; `mousedown` can be slow on demand.
    await s.page.setContent(`<input id="i"><script>
      window.log = []; window.slow = 0;
      for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup']) addEventListener(type, e => {
        log.push(type + ':' + (e.key ?? e.button));
        if (type === 'mousedown' && slow) { const end = Date.now() + slow; while (Date.now() < end); }
      });
    </script>`);
    const log = () => s!.page.evaluate(() => (window as unknown as { log: string[] }).log);
    const slow = (ms: number) => s!.page.evaluate(v => { (window as unknown as { slow: number }).slow = v; }, ms);

    // Error isolation: a refused navigation reports and the next command still runs.
    a.send([{ t: 'goto', url: 'javascript:alert(1)' }]);
    assert.match(String((await a.next(m => m.type === 'error')).message), /http/);
    a.send([{ t: 'resize', w: 900, h: 600 }]);
    await until(() => s!.viewport.width === 900 && s!.viewport.height === 600, 5000, 'resize');
    assert.deepEqual(jpegSize(await (async () => { a.frames.length = 0; return a.frame(); })()), { width: 1800, height: 1200 });

    // Held reflects execution: Shift-down executed, Shift-up queued behind a
    // slow command, the socket closes → the queued up is purged, the release
    // runs after the slow command settles, exactly once.
    a.send([{ t: 'key', type: 'down', key: 'Shift' }]);
    await until(async () => (await log()).includes('keydown:Shift'), 5000, 'Shift down');
    await slow(1500);
    a.send([{ t: 'down', x: 10, y: 10, button: 0 }, { t: 'key', type: 'up', key: 'Shift' }]);
    await sleep(200); // the slow down is executing; the up is queued behind it
    a.ws.close();
    await a.closed;
    await sleep(2000);
    let seen = await log();
    assert.deepEqual(seen.filter(x => x.startsWith('keyup') || x.startsWith('mouseup')), ['mouseup:0', 'keyup:Shift'].sort((p, q) => seen.indexOf(p) - seen.indexOf(q)));
    assert.equal(seen.filter(x => x === 'keyup:Shift').length, 1, 'the purged queued up never doubles the release');
    assert.ok(seen.indexOf('mousedown:0') < seen.indexOf('keyup:Shift'), 'release follows the executing command');
    assert.equal(s.owners.size, 0);

    // Same-batch cancellation: only the executing command survives a disconnect.
    await s.page.evaluate(() => { (window as unknown as { log: string[] }).log = []; });
    const b = client('bw', sid);
    await b.next(m => m.type === 'view');
    b.send([{ t: 'down', x: 10, y: 10, button: 0 }, { t: 'text', text: 'x' }, { t: 'key', type: 'down', key: 'a' }]);
    await sleep(200);
    b.ws.close();
    await b.closed;
    await sleep(2000);
    seen = await log();
    assert.deepEqual(seen, ['mousedown:0', 'mouseup:0'], 'the queued text and key never ran; the executed down was released');
    assert.equal(await s.page.evaluate(() => (document.getElementById('i') as HTMLInputElement).value), '');
    await slow(0);

    // Cleanup precedes a reconnected viewer's first command.
    await s.page.evaluate(() => { (window as unknown as { log: string[] }).log = []; });
    const c = client('bw', sid);
    await c.next(m => m.type === 'view');
    c.send([{ t: 'key', type: 'down', key: 'Shift' }]);
    await until(async () => (await log()).includes('keydown:Shift'), 5000, 'Shift down');
    c.ws.close();
    const d = client('bw', sid);
    await d.next(m => m.type === 'view');
    d.send([{ t: 'key', type: 'down', key: 'a' }, { t: 'key', type: 'up', key: 'a' }]);
    await until(async () => (await log()).includes('keyup:a'), 5000, 'a typed');
    seen = await log();
    assert.deepEqual(seen, ['keydown:Shift', 'keyup:Shift', 'keydown:a', 'keyup:a']);

    // Ownership: a press another live viewer also holds is not ours to release.
    await s.page.evaluate(() => { (window as unknown as { log: string[] }).log = []; });
    const e = client('bw', sid);
    await e.next(m => m.type === 'view');
    d.send([{ t: 'key', type: 'down', key: 'Alt' }]);
    e.send([{ t: 'key', type: 'down', key: 'Alt' }]);
    await until(async () => (await log()).filter(x => x === 'keydown:Alt').length >= 1, 5000, 'Alt down');
    await sleep(300);
    d.ws.close(); await d.closed; await sleep(500);
    assert.equal((await log()).includes('keyup:Alt'), false, 'the other viewer still holds Alt');
    e.ws.close(); await e.closed; await sleep(500);
    assert.equal((await log()).filter(x => x === 'keyup:Alt').length, 1);

    // Bounds: more than 4000 queued commands behind a slow one, or one message over 256 KB.
    await slow(1500);
    const g = client('bw', sid);
    await g.next(m => m.type === 'view');
    g.send([{ t: 'down', x: 10, y: 10, button: 0 }]);
    await sleep(100);
    for (let i = 0; i < 21; i++) g.send(Array(200).fill({ t: 'wheel', x: 1, y: 1, dx: 0, dy: 1 }));
    assert.equal(await g.closed, 1008);
    await sleep(1600);
    await slow(0);
    const h = client('bw', sid);
    await h.next(m => m.type === 'view');
    h.send([{ t: 'text', text: 'y'.repeat(300 * 1024) }]);
    assert.equal(await h.closed, 1009);

    // Sign-out during queued work is terminal for what that viewer still has queued.
    await s.page.evaluate(() => { (window as unknown as { log: string[] }).log = []; });
    const other = createSession(uid).id;
    await slow(1500);
    const k = client('bw', other);
    await k.next(m => m.type === 'view');
    k.send([{ t: 'down', x: 10, y: 10, button: 0 }, { t: 'key', type: 'down', key: 'z' }, { t: 'key', type: 'up', key: 'z' }]);
    await sleep(200);
    destroySession(other);
    assert.equal(await k.closed, 4401);
    await sleep(1800);
    await slow(0);
    seen = await log();
    assert.deepEqual(seen, ['mousedown:0', 'mouseup:0'], 'nothing queued ran after the sign-out; the executed down was released');
    // A signed-out socket cannot admit anything either.
    assert.equal(await refused('bw', other, `http://${base}`), 401);

    // The browser closing ends every socket normally; the client reconnects on its own.
    const z = client('bw', sid);
    await z.next(m => m.type === 'view');
    await closeSession(s);
    assert.equal(await z.closed, 1000);
    assert.equal(peek(uid, 'bw'), undefined);
    s = undefined;
  } finally {
    if (s) await closeSession(s);
    server.close();
  }
});
