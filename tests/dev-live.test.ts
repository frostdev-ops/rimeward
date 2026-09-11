import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { getDb } from '../src/lib/db.ts';
import { createSession, SESSION_COOKIE } from '../src/lib/auth.ts';
import { addProject } from '../src/lib/dev/projects.ts';
import { startSession } from '../src/lib/dev/terminals.ts';
import { devUpgrade } from '../src/lib/dev/live.ts';

// The terminal ward's WebSocket (lib/dev/live.ts) over a mocked PTY: hello
// before anything, output only for subscribed sessions, input applied through
// the same lease rules as the POST route and acknowledged by serial, a foreign
// owner refused without losing the socket, and the refusals before upgrade.

process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
const ptys: { id: number; written: string[]; size?: [number, number]; emit: (d: string) => void }[] = [];
const pty = createRequire(import.meta.url)('node-pty');
let nextPid = 100;
pty.spawn = () => {
  let output = (_: string) => {};
  const rec = { id: ++nextPid, written: [] as string[], size: undefined as [number, number] | undefined, emit: (d: string) => output(d) };
  ptys.push(rec);
  return {
    pid: rec.id,
    onData: (fn: (d: string) => void) => { output = fn; },
    onExit: () => {},
    kill() {}, pause() {}, resume() {},
    write: (d: string | Buffer) => rec.written.push(String(d)),
    resize: (c: number, r: number) => { rec.size = [c, r]; },
  };
};

getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES ('t@x', 'x', 'admin')`).run();
const user = (getDb().prepare('SELECT id FROM users WHERE email = ?').get('t@x') as { id: number }).id;
const cookie = createSession(user).id;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-live-'));
const project = addProject(user, root);
const server = http.createServer((_, res) => res.end()).on('upgrade', devUpgrade);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

type Msg = { t: string; [k: string]: unknown };
function client(owner = 'client:test', headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${cookie}` }) {
  const ws = new WebSocket(`ws://${base}/api/dev/ws?_ward=w&owner=${encodeURIComponent(owner)}`, { origin: `http://${base}`, headers });
  const msgs: Msg[] = [];
  const waiters: (() => void)[] = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  ws.on('message', raw => { msgs.push(JSON.parse(raw.toString())); wake(); });
  const closed = new Promise<number>(resolve => { ws.on('close', code => { resolve(code); wake(); }); ws.on('error', () => {}); });
  const status = new Promise<number>(resolve => { ws.on('unexpected-response', (_, res) => { resolve(res.statusCode ?? 0); ws.terminate(); }); });
  const next = (pred: (m: Msg) => boolean, ms = 3000) => new Promise<Msg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message within ${ms}ms; got ${JSON.stringify(msgs)}`)), ms);
    const check = () => { const m = msgs.find(pred); if (m) { clearTimeout(timer); resolve(m); return; } waiters.push(check); };
    check();
  });
  const send = (m: object) => ws.send(JSON.stringify(m));
  return { ws, msgs, closed, status, next, send };
}
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

test('hello precedes reset; output reaches only subscribed sessions', async () => {
  const a = await startSession(user, { project: project.id, kind: 'shell' });
  const b = await startSession(user, { project: project.id, kind: 'shell' });
  const c = client();
  await c.next(m => m.t === 'ev');
  assert.equal(c.msgs[0]!.t, 'hello');
  assert.equal((c.msgs[1]!.ev as { type: string }).type, 'reset');
  c.send({ t: 'sub', id: a.id });
  await settle(20);
  ptys[0]!.emit('from-a'); ptys[1]!.emit('from-b');
  await c.next(m => m.t === 'ev' && (m.ev as { data?: { data: string } }).data?.data === 'from-a');
  await settle();
  assert.equal(c.msgs.some(m => JSON.stringify(m).includes('from-b')), false, 'unsubscribed output is filtered on the server');
  c.send({ t: 'unsub', id: a.id });
  await settle(20);
  ptys[0]!.emit('later-a');
  await settle();
  assert.equal(c.msgs.some(m => JSON.stringify(m).includes('later-a')), false);
  // Session events still arrive for every session of the user.
  await startSession(user, { project: project.id, kind: 'shell' });
  await c.next(m => m.t === 'ev' && (m.ev as { type: string }).type === 'session');
  c.ws.close();
});

test('input is applied under the lease and acknowledged by serial; a foreign owner gets err, not a close', async () => {
  const s = await startSession(user, { project: project.id, kind: 'shell' });
  const rec = ptys.at(-1)!;
  const c = client('client:one');
  await c.next(m => m.t === 'hello');
  c.send({ t: 'in', id: s.id, data: 'ls\r', n: 7 });
  const ack = await c.next(m => m.t === 'ack');
  assert.deepEqual([ack.id, ack.n], [s.id, 7]);
  assert.deepEqual(rec.written, ['ls\r']);
  c.send({ t: 'rs', id: s.id, cols: 132, rows: 40 });
  await settle(30);
  assert.deepEqual(rec.size, [132, 40]);
  c.send({ t: 'int', id: s.id });
  await settle(30);
  assert.equal(rec.written.at(-1), '\x03');
  const other = client('client:two');
  await other.next(m => m.t === 'hello');
  other.send({ t: 'in', id: s.id, data: 'rm -rf\r', n: 1 });
  const err = await other.next(m => m.t === 'err');
  assert.equal(err.n, 1);
  assert.match(String(err.message), /Another client controls/);
  assert.equal(rec.written.includes('rm -rf\r'), false);
  assert.equal(other.ws.readyState, WebSocket.OPEN, 'a refused write keeps the socket');
  other.send({ t: 'in', id: 'nope', data: 'x', n: 2 });
  assert.equal((await other.next(m => m.t === 'err' && m.n === 2)).message, 'Terminal not found.');
  c.ws.close(); other.ws.close();
});

test('bad messages close 1008; a missing cookie, a bad owner and a non-desktop refuse before upgrade', async () => {
  const c = client();
  await c.next(m => m.t === 'hello');
  c.ws.send('not json');
  assert.equal(await c.closed, 1008);
  assert.equal(await client('client:test', {}).status, 401);
  assert.equal(await client('agent:rime').status, 400);
  process.env.RIMEWARD_DESKTOP = '';
  try { assert.equal(await client().status, 409); }
  finally { process.env.RIMEWARD_DESKTOP = '1'; }
});
