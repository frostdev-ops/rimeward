import './_setup.ts';
import test from 'node:test';
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
function fakeTerminal(target: string): { deps: TerminalDeps; paint(rows: string[]): void } {
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

test('a monitor consumes lens deliveries: baseline, delta, notice, ack, delete', async (t) => {
  const user = createUser('lens-monitor@example.com', 'pw-lens-monitor-1');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);

  // A real session only so `validateMonitorSource` finds one; every row the lens
  // reads comes from the fake deps below.
  const root = fs.mkdtempSync(os.tmpdir() + '/fdlens-');
  const project = addProject(user, root);
  const session = await startSession(user, { project: project.id, kind: 'shell' });
  t.after(async () => {
    releaseLens(user, `terminal:${session.id}`);
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
  const sourceId = `terminal:${session.id}`;
  // Created here so the core settles instantly; `connectMonitorSource` reuses it.
  const core = lens(user, sourceId, (): LensSettings => ({ settleMs: 0, minLines: 1 }));
  assert.ok(core);

  const conversation = activeConversation(user, 'ag1', 'codex');
  // A task conversation never wakes from `tickMonitors`, which keeps the door under
  // test (deliver → record → notice → ack) clear of a headless turn.
  db().prepare("UPDATE agent_conversations SET task_id='task-lens' WHERE id=?").run(conversation.id);

  const monitor = 'monitor:11111111-2222-3333-4444-555555555555';
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
      'build errors',
      JSON.stringify({ type: 'terminal', target: session.id }),
      JSON.stringify(parseMonitorFilter({ field: 'text', op: 'contains', value: 'error' })),
      'watching',
      1,
      Date.now()
    );

  terminal.paint(['ready']);
  await tickMonitors();
  await until('the consumer to be attached', () => consumerRow(user, sourceId, consumer) !== undefined);

  // The first delivery is the whole document: a keyframe, which the monitor records
  // as a baseline and acknowledges without matching anything.
  terminal.paint(['ready', 'hello world']);
  await until('the baseline keyframe to be acknowledged', () => {
    const row = consumerRow(user, sourceId, consumer);
    return !!row && row.delivered_id === null && row.cursor > 0;
  });
  const first = db()
    .prepare('SELECT * FROM lens_events WHERE user_id=? AND source=? AND consumer_id=? ORDER BY id LIMIT 1')
    .get(user, sourceId, consumer) as { since: number | null } | undefined;
  assert.equal(first?.since, null, 'the first delivery is a keyframe');
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
