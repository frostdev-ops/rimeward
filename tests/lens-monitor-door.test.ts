import './_setup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
// The session below exists only so the monitor source validates; nothing reads its PTY.
createRequire(import.meta.url)('node-pty').spawn = () => {
  let exit = (_: { exitCode: number; signal: number }): void => {};
  let ended = false;
  return {
    pid: 1,
    process: 'lens-monitor-door',
    onData: () => {},
    onExit: (fn: (e: { exitCode: number; signal: number }) => void) => {
      exit = fn;
    },
    kill: () => {
      if (!ended) {
        ended = true;
        exit({ exitCode: 0, signal: 0 });
      }
    },
    pause: () => {},
    resume: () => {},
    resize: () => {},
    write: () => {},
  };
};

import { getDb } from '../src/lib/db.ts';
import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { addProject } from '../src/lib/dev/projects.ts';
import { startSession, shutdownTerminals } from '../src/lib/dev/terminals.ts';
import { activeConversation } from '../src/lib/agent/conversations.ts';
import { SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { LensSettings, Source } from '../src/lib/lens/core.ts';
import { terminalSource } from '../src/lib/lens/terminal.ts';
import type { TerminalDeps } from '../src/lib/lens/terminal.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import { deleteMonitor, monitorConsumer, monitorNotices, monitorRuntime, shutdownAgentMonitors, tickMonitors } from '../src/lib/agent/monitors.ts';
import { parseMonitorFilter } from '../src/lib/agent/monitor-filter.ts';
import type { RuntimeEvent } from '../src/lib/dev/types.ts';

// The dev runtime the lens terminal source reads: whatever `paint()` last wrote,
// announced on the stream the same way a real session announces its output.
function fakeTerminal(target: string): { deps: TerminalDeps; paint(rows: string[]): void; exit(code: number): void } {
  const session = { id: target, project: 'p', kind: 'claude', state: 'running', exitCode: null, cols: 80, rows: 24, title: 'claude' };
  let lines: string[] = [];
  let sequence = 0;
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const deps = {
    subscribe: ((_user: number, fn: (event: RuntimeEvent) => void) => {
      listeners.add(fn);
      fn({ sequence, type: 'reset', id: '' });
      return (): void => {
        listeners.delete(fn);
      };
    }) as unknown as TerminalDeps['subscribe'],
    rendered: (() => ({ lines, wrapped: lines.map(() => false), scrolled: 0, lost: 0 })) as TerminalDeps['rendered'],
    read: (() => ({ session: { ...session } })) as unknown as TerminalDeps['read'],
  };
  return {
    deps,
    paint(rows: string[]): void {
      lines = rows;
      sequence += 1;
      for (const fn of [...listeners]) fn({ sequence, type: 'output', id: target, data: { sequence } });
    },
    /** The session ends: a `session` header change, which forces a keyframe. */
    exit(code: number): void {
      session.state = 'exited';
      session.exitCode = code as never;
      sequence += 1;
      for (const fn of [...listeners])
        fn({ sequence, type: 'session', id: target, data: { state: session.state, exitCode: code, cols: session.cols, rows: session.rows } });
    },
  };
}

const db = (): ReturnType<typeof getDb> => getDb();
const consumerRow = (user: number, source: string, id: string) =>
  db().prepare('SELECT * FROM lens_consumers WHERE user_id=? AND source=? AND id=?').get(user, source, id) as
    | { cursor: number; delivered_id: string | null }
    | undefined;
const pending = (monitor: string) =>
  db().prepare("SELECT * FROM agent_monitor_events WHERE monitor=? AND state='pending' ORDER BY id").all(monitor) as { payload: string }[];

/** The pipeline is asynchronous end to end (settle → gate → match → insert). */
async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A user, a real session (only so `validateMonitorSource` finds one), the fake dev deps
 *  the lens actually reads, and one monitor row on it. */
async function setup(t: TestContext, email: string, monitor: string, filter: unknown, watch?: unknown) {
  const user = createUser(email, 'pw-lens-monitor-1');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  const root = fs.mkdtempSync(os.tmpdir() + '/fdlens-');
  const project = addProject(user, root);
  const session = await startSession(user, { project: project.id, kind: 'shell' });
  const sourceId = `terminal:${session.id}`;
  t.after(async () => {
    releaseLens(user, sourceId);
    shutdownAgentMonitors();
    await shutdownTerminals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const terminal = fakeTerminal(session.id);
  const real = SOURCES.terminal;
  SOURCES.terminal = (): Source => terminalSource(terminal.deps);
  t.after(() => {
    SOURCES.terminal = real;
  });
  // Created here so the core settles instantly; `connectMonitorSource` reuses it.
  assert.ok(lens(user, sourceId, (): LensSettings => ({ settleMs: 0, minLines: 1 })));

  const conversation = activeConversation(user, 'ag1', 'codex');
  // A task conversation never wakes from `tickMonitors`, which keeps the door under
  // test (deliver → record → notice → ack) clear of a headless turn.
  db().prepare("UPDATE agent_conversations SET task_id='task-lens' WHERE id=?").run(conversation.id);

  const consumer = monitorConsumer(monitor);
  assert.match(consumer, /^[a-z0-9-]{1,40}$/);
  db()
    .prepare(
      'INSERT INTO agent_monitors(id,user_id,ward,conversation_id,runtime,name,source,filter,status,min_interval_seconds,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      monitor,
      user,
      'ag1',
      conversation.id,
      monitorRuntime(),
      'observations',
      JSON.stringify({ type: 'terminal', target: session.id, ...(watch === undefined ? {} : { watch }) }),
      JSON.stringify(parseMonitorFilter(filter)),
      'watching',
      1,
      Date.now()
    );
  return { user, sourceId, consumer, terminal, conversation };
}

test('a monitor consumes lens deliveries: baseline, delta, notice, ack, delete', async (t) => {
  const monitor = 'monitor:11111111-2222-3333-4444-555555555555';
  const { user, sourceId, consumer, terminal, conversation } = await setup(t, 'lens-monitor@example.com', monitor, {
    field: 'text',
    op: 'contains',
    value: 'error',
  });

  terminal.paint(['ready']);
  await tickMonitors();
  await until('the consumer to be attached', () => consumerRow(user, sourceId, consumer) !== undefined);
  // The connect baseline (never acknowledged, never a delivery) is what gives the monitor
  // a `previous`, so a `changed` filter cannot fire on the first delta after a reset.
  await until('the connect baseline to be recorded', () => {
    const row = db().prepare('SELECT cursor FROM agent_monitors WHERE id=?').get(monitor) as { cursor: string };
    return (JSON.parse(row.cursor).previous as { eventType?: string } | undefined)?.eventType === 'baseline';
  });
  assert.equal(
    (db().prepare('SELECT count(*) AS n FROM lens_events WHERE user_id=? AND source=? AND consumer_id=?').get(user, sourceId, consumer) as { n: number }).n,
    0,
    'the connect baseline is not a delivery'
  );

  // That baseline seeded the consumer's cursor too, so the first delivery is a
  // DELTA of what changed after it — not a keyframe of the document it just carried.
  const seeded = consumerRow(user, sourceId, consumer)!.cursor;
  assert.ok(seeded > 0, 'the connect baseline seeds the cursor');
  terminal.paint(['ready', 'hello world']);
  await until('the first delivery to be acknowledged', () => {
    const row = consumerRow(user, sourceId, consumer);
    return !!row && row.delivered_id === null && row.cursor > seeded;
  });
  const first = db()
    .prepare('SELECT * FROM lens_events WHERE user_id=? AND source=? AND consumer_id=? ORDER BY id LIMIT 1')
    .get(user, sourceId, consumer) as { since: number | null } | undefined;
  assert.equal(first?.since, seeded, 'the first delivery is a delta from the seeded cursor');
  assert.deepEqual(pending(monitor), []);
  const afterBaseline = consumerRow(user, sourceId, consumer)!.cursor;

  // A change the filter does not want: acknowledged at once, nothing recorded.
  terminal.paint(['ready', 'hello world', 'all good here']);
  await until('the filter miss to be acknowledged', () => {
    const row = consumerRow(user, sourceId, consumer);
    return !!row && row.delivered_id === null && row.cursor > afterBaseline;
  });
  assert.deepEqual(pending(monitor), []);
  const afterMiss = consumerRow(user, sourceId, consumer)!.cursor;

  // A match: recorded as a pending event, and the delivery stays unacknowledged
  // until the notice is stored.
  terminal.paint(['ready', 'hello world', 'all good here', 'error: build failed']);
  await until('the match to be recorded', () => pending(monitor).length === 1);
  const payload = JSON.parse(pending(monitor)[0]!.payload) as { text: string; eventType: string; delivery: string; v: number };
  assert.equal(payload.eventType, 'delta');
  assert.ok(payload.text.includes('error: build failed'));
  assert.ok(payload.text.startsWith(OBSERVATION_BANNER));
  assert.equal(consumerRow(user, sourceId, consumer)!.delivered_id, payload.delivery);

  const notices = monitorNotices({ userId: user, ward: 'ag1', conv: conversation.id });
  assert.equal(notices.length, 1);
  // The whole delivery text rides the notice, banner and all — not a 350-char slice.
  assert.ok(notices[0]!.text.includes('error: build failed'));
  assert.ok(notices[0]!.text.includes(OBSERVATION_BANNER));
  assert.deepEqual(pending(monitor), []);
  assert.equal(consumerRow(user, sourceId, consumer)!.delivered_id, null);
  assert.equal(consumerRow(user, sourceId, consumer)!.cursor, payload.v);

  // The next delivery starts from the version the notice acknowledged.
  terminal.paint(['ready', 'hello world', 'all good here', 'error: build failed', 'error: again']);
  await until('the next delta', () => pending(monitor).length === 1);
  const next = db()
    .prepare('SELECT * FROM lens_events WHERE user_id=? AND source=? AND consumer_id=? ORDER BY id DESC LIMIT 1')
    .get(user, sourceId, consumer) as { since: number | null; v: number };
  assert.equal(next.since, payload.v);
  assert.ok(next.v > payload.v);
  assert.ok(afterMiss > 0);

  // Deleting the monitor takes its consumer with it.
  deleteMonitor({ userId: user, ward: 'ag1', conv: conversation.id }, monitor);
  assert.equal(consumerRow(user, sourceId, consumer), undefined);
  assert.equal(
    (db().prepare('SELECT count(*) AS n FROM lens_events WHERE user_id=? AND source=? AND consumer_id=?').get(user, sourceId, consumer) as { n: number }).n,
    0
  );
});

test('every keyframe after the first is an observation, not a baseline', async (t) => {
  const monitor = 'monitor:66666666-7777-8888-9999-aaaaaaaaaaaa';
  const { user, sourceId, consumer, terminal } = await setup(t, 'lens-exit@example.com', monitor, {
    field: 'text',
    op: 'contains',
    value: 'exit=',
  });

  terminal.paint(['$ npm run build']);
  await tickMonitors();
  await until('the consumer to be attached', () => consumerRow(user, sourceId, consumer) !== undefined);

  // The first keyframe is the baseline, swallowed before the filter.
  terminal.paint(['$ npm run build', 'building…']);
  await until('the baseline keyframe to be acknowledged', () => {
    const row = consumerRow(user, sourceId, consumer);
    return !!row && row.delivered_id === null && row.cursor > 0;
  });
  assert.deepEqual(pending(monitor), []);

  // The session ends: a `session` header change, so a second keyframe — which the filter
  // must see, or a terminal exit is silently swallowed.
  terminal.exit(0);
  await until('the exit keyframe to be recorded', () => pending(monitor).length === 1);
  const payload = JSON.parse(pending(monitor)[0]!.payload) as { eventType: string; text: string };
  assert.equal(payload.eventType, 'key');
  assert.ok(payload.text.includes('session=exited exit=0'), payload.text.slice(0, 200));
});

test('a keyframe forced by an evicted cursor is an observation, not a swallowed baseline', async (t) => {
  const monitor = 'monitor:bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const { user, sourceId, consumer, terminal } = await setup(t, 'lens-evicted@example.com', monitor, {
    field: 'text',
    op: 'contains',
    value: 'build failed',
  });

  // A consumer restored from the store whose acknowledged version is no longer in
  // the ring: a restart, or 32 settles it never answered. What comes back is a
  // keyframe of the whole document — and the connect baseline below has already
  // seeded the cursor, so that keyframe is news like any other.
  db()
    .prepare(
      'INSERT INTO lens_consumers(user_id,source,id,kind,cursor,baseline_v,baseline_complete,next_delivery,seen_at) VALUES(?,?,?,?,?,?,?,?,?)'
    )
    .run(user, sourceId, consumer, 'monitor', 999, 999, 1, 3, Date.now());
  // The core loads its consumers when it is built, so rebuild it on that row.
  releaseLens(user, sourceId);
  assert.ok(lens(user, sourceId, (): LensSettings => ({ settleMs: 0, minLines: 1 })));

  terminal.paint(['$ npm run build', 'error: build failed']);
  await tickMonitors();
  await until('the evicted keyframe to be recorded', () => pending(monitor).length === 1);
  const payload = JSON.parse(pending(monitor)[0]!.payload) as { eventType: string; text: string };
  assert.equal(payload.eventType, 'key');
  assert.ok(payload.text.includes('error: build failed'), payload.text.slice(0, 200));
});

test("a watch's first hit wakes the ward, as a delta from the connect baseline", async (t) => {
  const monitor = 'monitor:cccccccc-dddd-eeee-ffff-000000000000';
  // `regex` needs no embedder, so the gate can evaluate it on any machine.
  const { user, sourceId, consumer, terminal } = await setup(
    t,
    'lens-watch-first@example.com',
    monitor,
    { field: 'text', op: 'contains', value: 'build failed' },
    { visual: false, triage: false, regex: 'build failed' }
  );

  terminal.paint(['$ npm run build']);
  await tickMonitors();
  await until('the consumer to be attached', () => consumerRow(user, sourceId, consumer) !== undefined);
  // A change the watch does not want delivers nothing at all.
  terminal.paint(['$ npm run build', 'compiling…']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(pending(monitor), []);

  // The first thing this consumer is ever handed is the hit itself, and because
  // the connect baseline seeded its cursor it is a delta of exactly that row.
  terminal.paint(['$ npm run build', 'compiling…', 'error: build failed']);
  await until('the first hit to be recorded', () => pending(monitor).length === 1);
  const payload = JSON.parse(pending(monitor)[0]!.payload) as { eventType: string; text: string };
  assert.equal(payload.eventType, 'delta');
  // Everything since the baseline, and nothing the baseline already carried.
  assert.ok(payload.text.includes('compiling…'));
  assert.ok(!payload.text.includes('$ npm run build'), 'not the document the baseline already carried');
  assert.ok(payload.text.includes('error: build failed'), payload.text.slice(0, 200));
});
