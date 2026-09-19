// C3: the lens as a leyline source. A fake `screen` source stands in for the
// bundled one: it writes the SAME header strings the real one does
// (lens/screen.ts `headMeta`) and its rows through the same `Feed`, so the gate,
// the deliveries and the acks under test are the real ones.
import './_setup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source } from '../src/lib/lens/core.ts';
import { screenWindow, syncLensEdges } from '../src/lib/lens/leylines.ts';
import { ACTION_EXECS, getGraph, saveGraph, subscribeLogic } from '../src/lib/logic-engine.ts';
import { renderTemplate, type LogicEdge } from '../src/lib/logic.ts';
import { getDashboard } from '../src/lib/dashboard.ts';

/** The real screen's `app` header: bundle id, quoted name, pid. */
const appHeader = (bundle: string, name: string): string => `${bundle} "${name}" pid=812`;

interface FakeScreen {
  source: Source;
  paint(rows: string[]): void;
  app(bundle: string, name: string): void;
  /** Consent withdrawn or Screen Recording lost: the capture stops. */
  stop(): void;
  /** Consent back: the same core comes live again and re-reads the screen. */
  start(): void;
}

function fakeScreen(): FakeScreen {
  let feed: Feed | null = null;
  let seq = 0;
  const header = (): void => {
    seq += 1;
    feed?.meta('window', '9 "Notes — plan"', seq);
    feed?.meta('focus', 'AXTextArea "body" value=""', seq);
    feed?.meta('app', appHeader('com.apple.Safari', 'Safari'), seq);
  };
  const source: Source = {
    // The screen source forces a keyframe when the frontmost app changes.
    keyframeOn: ['app'],
    async connect(_user, _target, f): Promise<() => void> {
      feed = f;
      seq += 1;
      f.epoch(1, seq);
      f.ref('frame-1');
      header();
      return (): void => {
        feed = null;
      };
    },
  };
  return {
    source,
    paint(rows: string[]): void {
      seq += 1;
      feed?.replace(rows.map((text) => ({ text, src: 'ax' })), seq);
    },
    app(bundle: string, name: string): void {
      seq += 1;
      feed?.meta('app', appHeader(bundle, name), seq);
    },
    stop(): void {
      feed?.offline('not-consented');
    },
    start(): void {
      feed?.online();
      header();
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

/** A user, the fake screen source, a core with an instant settle, and the
 *  `agent.ask` exec replaced by one that records the rendered prompt. */
async function setup(t: TestContext, email: string, edges: LogicEdge[]) {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const user = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(user, validateLayout(LAYOUT)!);
  saveGraph(user, { edges });

  const screen = fakeScreen();
  const real = SOURCES.screen;
  SOURCES.screen = (): Source => screen.source;
  const core = lens(user, 'screen:local', (): LensSettings => ({ settleMs: 0, minLines: 1 }))!;
  assert.ok(core);

  const asks: string[] = [];
  const original = ACTION_EXECS['agent.ask']!;
  ACTION_EXECS['agent.ask'] = async (ctx, e) => {
    asks.push(renderTemplate(String(e.action.params.prompt), ctx.vars));
    return 'asked';
  };
  t.after(() => {
    ACTION_EXECS['agent.ask'] = original;
    syncLensEdges(user, [], []); // drops every consumer this test bound
    releaseLens(user, 'screen:local');
    if (real) SOURCES.screen = real;
    else delete SOURCES.screen;
    screenWindow.delete(user);
  });

  const sync = (): void => syncLensEdges(user, getGraph(user).edges, getDashboard(user));
  sync();
  // `connect` resolves on a microtask; the header it writes is the first keyframe.
  await until('the source to connect', () => core.status().v > 0);
  return { user, core, screen, asks, sync };
}

const screenEdge = (over: Partial<LogicEdge> = {}): LogicEdge => ({
  id: 'sc1',
  source: { ward: 'ln1', trigger: 'screen-changed', params: {} },
  conditions: [],
  action: { type: 'agent.ask', ward: 'ag1', params: { prompt: '{{screen.app}} | {{screen.window}} | {{screen.text}}' } },
  enabled: true,
  ...over,
});

const watchEdge = (over: Partial<LogicEdge> = {}): LogicEdge => ({
  id: 'w1',
  source: { ward: 'ln1', trigger: 'watch-matched', params: { for: 'a build error', regex: 'error' } },
  conditions: [],
  action: { type: 'agent.ask', ward: 'ag1', params: { prompt: '{{lens.delivery}} | {{lens.text}}' } },
  enabled: true,
  ...over,
});

const delivered = (core: { status(): { consumers: { id: string; delivered: string | null }[] } }, id: string): string | null | undefined =>
  core.status().consumers.find((c) => c.id === id)?.delivered;

test('a screen delivery fires screen-changed once, renders {{screen.*}} and is acknowledged', async (t) => {
  const { core, screen, asks } = await setup(t, 'lens-ly-screen@t.dev', [screenEdge()]);
  screen.paint(['npm run build', 'error TS2345: nope']);
  await until('the change to fire', () => asks.length === 1);
  const prompt = asks[0]!;
  assert.match(prompt, /^com\.apple\.Safari "Safari" pid=812 \| 9 "Notes — plan" \| /);
  assert.match(prompt, /error TS2345/, 'the observed text is in scope');
  assert.match(prompt, /lens observation/, 'the delivery carries its banner');
  assert.equal(delivered(core, 'leylines'), null);

  // One delivery is one firing: nothing re-fires on its own.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 1);
});

test('the app filter takes a name or a bundle id, and the hourly cap is per change', async (t) => {
  const { user, core, screen, asks } = await setup(t, 'lens-ly-cap@t.dev', [
    // The name, as a person would type it — the header carries the bundle id,
    // the name and the pid, so exact equality on the header would never match.
    screenEdge({ id: 'sc1', source: { ward: 'ln1', trigger: 'screen-changed', params: { app: 'Xcode' } } }),
    screenEdge({
      id: 'sc2',
      source: { ward: 'ln1', trigger: 'screen-changed', params: { app: 'com.apple.dt.Xcode' } },
      action: { type: 'agent.ask', ward: 'ag1', params: { prompt: 'by id: {{screen.app}}' } },
    }),
  ]);
  screen.paint(['one']);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 0, 'the frontmost app is Safari, not Xcode');
  assert.equal(screenWindow.get(user)?.length ?? 0, 0, 'a change nobody watches spends no slot');

  // The cap is the per-user hourly window: full, a delivery is dropped whole —
  // and still acknowledged, or the consumer would stall until the window clears.
  screenWindow.set(user, Array.from({ length: 300 }, () => Date.now()));
  screen.app('com.apple.dt.Xcode', 'Xcode');
  await until('the delivery to be acknowledged', () => delivered(core, 'leylines') === null);
  assert.equal(asks.length, 0, 'over the cap, nothing fired');

  screenWindow.delete(user);
  screen.paint(['two', 'three']);
  await until('both edges to fire', () => asks.length === 2);
  assert.match(asks[0]!, /^com\.apple\.dt\.Xcode "Xcode" pid=812 \|/, 'matched on the name');
  assert.match(asks[1]!, /^by id: com\.apple\.dt\.Xcode/, 'and on the bundle id');
  assert.equal(screenWindow.get(user)?.length, 1, 'one change is one slot, however many edges it feeds');
});

test('a consent toggle keeps the bound consumer: the same core goes offline and live again', async (t) => {
  const { core, screen, asks } = await setup(t, 'lens-ly-consent@t.dev', [screenEdge()]);
  screen.paint(['before']);
  await until('the first change to fire', () => asks.length === 1);

  // Consent withdrawn: the capture stops and the source says so.
  screen.stop();
  assert.equal(core.status().state, 'offline');

  // And back on. Nothing was released, so the listener, the consumer and its
  // cursor are the ones bound at the start.
  screen.start();
  assert.equal(core.status().state, 'live');
  screen.paint(['after']);
  await until('the change after the toggle to fire', () => asks.length === 2);
  assert.match(asks[1]!, /after/);
  assert.equal(delivered(core, 'leylines'), null, 'still acknowledged by the same consumer');
});

test('watch-matched fires only its own edge, and a disabled edge drops its consumer', async (t) => {
  const { user, core, screen, asks, sync } = await setup(t, 'lens-ly-watch@t.dev', [
    watchEdge(),
    watchEdge({
      id: 'w2',
      source: { ward: 'ln1', trigger: 'watch-matched', params: { for: 'a deploy', regex: 'deployed' } },
      action: { type: 'agent.ask', ward: 'ag1', params: { prompt: 'w2 {{lens.text}}' } },
    }),
  ]);
  const rows = () =>
    (getDb().prepare("SELECT id FROM lens_consumers WHERE user_id=? AND source='screen:local' ORDER BY id").all(user) as { id: string }[]).map((r) => r.id);
  assert.deepEqual(rows(), ['edge-w1', 'edge-w2']);

  screen.paint(['error TS2345: nope']);
  await until('the matching watch to fire', () => asks.length === 1);
  assert.match(asks[0]!, /error TS2345/);
  assert.equal(delivered(core, 'edge-w1'), null, 'the delivery was acknowledged');
  assert.equal(delivered(core, 'edge-w2') ?? null, null, 'the other watch never matched');
  // The firing carries screen.* too, because this watch reads the screen.
  assert.match(asks[0]!, /^[a-z0-9-]+:\d+ \| /);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 1, 'one delivery, one firing, on one edge');

  saveGraph(user, { edges: [watchEdge({ enabled: false })] });
  sync();
  assert.deepEqual(rows(), [], 'a disabled edge and a deleted one both drop their consumer');
});

test('scene events coalesce into one lens refresh', async (t) => {
  const { user, screen } = await setup(t, 'lens-ly-refresh@t.dev', [screenEdge()]);
  const seen: unknown[] = [];
  const unsub = subscribeLogic(user, (event, data) => {
    if (event === 'refresh') seen.push(data);
  });
  t.after(unsub);
  screen.paint(['a']);
  screen.paint(['a', 'b']);
  await until('the coalesced refresh', () => seen.length > 0, 5000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(seen, [{ type: 'lens' }]);
});
