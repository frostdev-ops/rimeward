// C2: `screen` as a monitor source. The fake source below writes through the same
// `Feed` the bundled screen does (lens/screen.ts), so the parse, the gate, the
// deliveries and the acks under test are the real ones.
import './_setup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';

import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source } from '../src/lib/lens/core.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import { screenOffline } from '../src/lib/lens/types.ts';
import { connectMonitorSource, parseMonitorSource, validateMonitorSource } from '../src/lib/agent/monitor-sources.ts';
import { getDb } from '../src/lib/db.ts';
import { activeConversation } from '../src/lib/agent/conversations.ts';
import { monitorRuntime, shutdownAgentMonitors, tickMonitors } from '../src/lib/agent/monitors.ts';
import { parseMonitorFilter } from '../src/lib/agent/monitor-filter.ts';

interface FakeScreen {
  source: Source;
  /** The core connects a source on its first consumer, and that is asynchronous. */
  live(): boolean;
  paint(rows: string[]): void;
}

function fakeScreen(): FakeScreen {
  let feed: Feed | null = null;
  let seq = 0;
  return {
    source: {
      keyframeOn: ['app'],
      async connect(_user, _target, f): Promise<() => void> {
        feed = f;
        seq += 1;
        f.epoch(1, seq);
        f.ref('frame-1');
        f.meta('app', 'com.apple.Safari "Safari" pid=812', seq);
        f.meta('window', '9 "Notes — plan"', seq);
        return (): void => {
          feed = null;
        };
      },
    },
    live: (): boolean => feed !== null,
    paint(rows: string[]): void {
      seq += 1;
      feed?.replace(rows.map((text) => ({ text, src: 'ax' })), seq);
    },
  };
}

async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const LAYOUT = [
  { i: 'ln1', type: 'lens', size: '3x2' },
  { i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } },
];

/** A user with a Screen lens ward and the fake source registered for `screen:local`. */
function setup(t: TestContext, email: string, layout: unknown[] = LAYOUT) {
  const user = createUser(email, 'pw-lens-monitor-1');
  saveDashboard(user, validateLayout(layout)!);
  const screen = fakeScreen();
  const real = SOURCES.screen;
  SOURCES.screen = (): Source => screen.source;
  t.after(() => {
    releaseLens(user, 'screen:local');
    if (real) SOURCES.screen = real;
    else delete SOURCES.screen;
  });
  return { user, screen };
}

test('a screen source folds its watch shorthand and rejects a malformed rect', () => {
  const s = parseMonitorSource({ type: 'screen', for: 'a build error', regex: 'error', rect: [0, 0, 100, 50], visual: true });
  assert.equal(s.type, 'screen');
  assert.equal(s.watch?.for, 'a build error');
  assert.equal(s.watch?.regex, 'error');
  assert.deepEqual(s.watch?.rect, [0, 0, 100, 50]);
  assert.equal(s.watch?.visual, true);
  // A monitor never asks for triage implicitly; the watch's own field is what turns it on.
  assert.equal(s.watch?.triage, false);
  assert.equal(parseMonitorSource({ type: 'screen' }).watch, undefined);
  // An explicit watch is the whole spec: the shorthand beside it is not merged in.
  assert.equal(parseMonitorSource({ type: 'screen', regex: 'shorthand', watch: { regex: 'explicit' } }).watch?.regex, 'explicit');

  assert.throws(() => parseMonitorSource({ type: 'screen', rect: [0, 0, 100] }), /\[x,y,w,h\]/);
  assert.throws(() => parseMonitorSource({ type: 'screen', rect: [0, 0, 100, Number.NaN] }), /\[x,y,w,h\]/);
  assert.throws(() => parseMonitorSource({ type: 'screen', rect: 'all of it' }), /\[x,y,w,h\]/);
  assert.throws(() => parseMonitorSource({ type: 'screen', regex: '([' }), /not a valid pattern/);
});

test('a screen monitor needs the desktop that runs the lens, not a lens ward', (t) => {
  const { user } = setup(t, 'lens-monitor-validate@example.com');
  const refused = /Screen monitoring belongs on the desktop that runs the screen lens\./;

  // One screen per runtime: whatever a screen monitor names, it reads screen:local.
  validateMonitorSource(user, { type: 'screen' });
  validateMonitorSource(user, { type: 'screen', target: 'ln1' });
  validateMonitorSource(user, { type: 'screen', target: 'ag1' });

  // Off the desktop app there is no screen to read.
  delete process.env.RIMEWARD_DESKTOP;
  assert.throws(() => validateMonitorSource(user, { type: 'screen' }), refused);
  process.env.RIMEWARD_DESKTOP = '1';

  // A runtime with no screen source registered is refused too.
  const source = SOURCES.screen!;
  delete SOURCES.screen;
  assert.throws(() => validateMonitorSource(user, { type: 'screen' }), refused);
  SOURCES.screen = source;

  // No lens ward at all: the lens is runtime state (consent, pause), never layout.
  const bare = createUser('lens-monitor-bare@example.com', 'pw-lens-monitor-1');
  saveDashboard(bare, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  validateMonitorSource(bare, { type: 'screen' });
});

test('a lens that is not reading takes its monitor offline with the reason, and comes back', async (t) => {
  const { user, screen } = setup(t, 'lens-monitor-offline@example.com');
  const monitor = 'monitor:99999999-8888-7777-6666-555555555555';
  const conversation = activeConversation(user, 'ag1', 'codex');
  getDb().prepare("UPDATE agent_conversations SET task_id='task-lens-off' WHERE id=?").run(conversation.id);
  getDb()
    .prepare('INSERT INTO agent_monitors(id,user_id,ward,conversation_id,runtime,name,source,filter,status,min_interval_seconds,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(monitor, user, 'ag1', conversation.id, monitorRuntime(), 'screen', JSON.stringify({ type: 'screen' }),
      JSON.stringify(parseMonitorFilter({ field: 'text', op: 'contains', value: 'error' })), 'watching', 1, Date.now());
  t.after(() => shutdownAgentMonitors());

  // The core the tools and the ward read, taken offline the way the screen source
  // takes it offline when `lens-start` answers `not-consented`.
  const core = lens(user, 'screen:local')!;
  core.feed.offline(screenOffline('not-consented'));

  // Being off is NOT invalid: an invalid monitor is `blocked` with a generic
  // message every tick, and would never reach the reconnect that carries this.
  validateMonitorSource(user, { type: 'screen' });
  await tickMonitors();
  const off = getDb().prepare('SELECT status,error FROM agent_monitors WHERE id=?').get(monitor) as { status: string; error: string | null };
  assert.equal(off.status, 'offline');
  assert.equal(off.error, 'the Screen lens is turned off for this Mac');

  // Consent given back: the retry window is 5 s, so this proves the row rather
  // than the timer — the same core, live again, and a source that connects.
  core.feed.online();
  assert.equal(core.status().state, 'live');
  assert.equal(screen.live(), false, 'nothing connected to a lens that was not reading');
});

test('a screen monitor reads screen:local: baseline, then a delivery its watch let through', async (t) => {
  const { user, screen } = setup(t, 'lens-monitor-connect@example.com');
  const core = lens(user, 'screen:local', (): LensSettings => ({ settleMs: 0, minLines: 1 }))!;
  assert.ok(core);

  const events: { key: string; data: Record<string, unknown>; baseline?: boolean }[] = [];
  const errors: string[] = [];
  // The ward id is what the monitor names; the core it reads is the one screen.
  const off = await connectMonitorSource(
    user,
    parseMonitorSource({ type: 'screen', target: 'ln1', regex: 'error' }),
    (key, data, baseline) => events.push({ key, data, baseline }),
    (error) => errors.push(error),
    undefined,
    'mon-screen1'
  );
  t.after(() => off());
  await until('the source to connect', () => screen.live());

  // One baseline per connect, before anything can be delivered.
  assert.equal(events.length, 1);
  assert.match(events[0]!.key, /^baseline:/);
  assert.equal(events[0]!.baseline, true);
  assert.equal(events[0]!.data.eventType, 'baseline');
  assert.equal(events[0]!.data.source, 'screen:local');
  assert.ok(String(events[0]!.data.text).startsWith(OBSERVATION_BANNER));

  // The watch reached the consumer, and it is what holds the deliveries back.
  const watches = core.consumer('mon-screen1', 'monitor').watches;
  assert.equal(watches.length, 1);
  assert.equal(watches[0]!.spec.regex, 'error');
  assert.equal(watches[0]!.spec.triage, false);

  screen.paint(['all good here']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, 1, 'a change the watch does not want is not delivered');

  screen.paint(['all good here', 'error: build failed']);
  await until('the watch hit to be delivered', () => events.length > 1);
  const hit = events[1]!;
  assert.equal(hit.key, hit.data.delivery, 'a delivery is keyed by its own id');
  assert.equal(hit.data.source, 'screen:local');
  assert.ok(['key', 'delta'].includes(String(hit.data.eventType)));
  assert.ok(String(hit.data.text).includes('error: build failed'));
  assert.ok(String(hit.data.text).startsWith(OBSERVATION_BANNER));
  assert.equal(core.consumer('mon-screen1', 'monitor').delivered?.id, hit.data.delivery);
  assert.deepEqual(errors, []);

  // Closing drops the listener and nothing else: the core keeps running for its
  // other consumers, and the unacknowledged delivery survives.
  off();
  const delivered = events.length;
  core.look('mon-screen1', { ack: String(hit.data.delivery), fields: [] });
  screen.paint(['all good here', 'error: build failed', 'error: again']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, delivered, 'a closed monitor hears nothing more');
  assert.ok(core.status().v > 0);
});
