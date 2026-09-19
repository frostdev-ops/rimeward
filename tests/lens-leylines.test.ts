// C3: the lens as a leyline source. A fake `screen` source stands in for the
// bundled one (B2 is not landed here): it writes a header and rows through the
// same `Feed` the real one will, so the gate, the deliveries and the acks under
// test are the real ones.
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

function fakeScreen(): { source: Source; paint(rows: string[]): void; app(name: string): void } {
  let feed: Feed | null = null;
  let seq = 0;
  const source: Source = {
    // The screen source forces a keyframe when the frontmost app changes.
    keyframeOn: ['app'],
    async connect(_user, _target, f): Promise<() => void> {
      feed = f;
      seq += 1;
      f.epoch(1, seq);
      f.ref('frame-1');
      f.meta('window', 'Notes — plan', seq);
      f.meta('focus', 'body', seq);
      f.meta('app', 'Safari', seq);
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
    app(name: string): void {
      seq += 1;
      feed?.meta('app', name, seq);
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
  assert.match(prompt, /^Safari \| Notes — plan \| /);
  assert.match(prompt, /error TS2345/, 'the observed text is in scope');
  assert.match(prompt, /lens observation/, 'the delivery carries its banner');
  assert.equal(delivered(core, 'leylines'), null);

  // One delivery is one firing: nothing re-fires on its own.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 1);
});

test('the app filter and the hourly screen cap', async (t) => {
  const { user, core, screen, asks } = await setup(t, 'lens-ly-cap@t.dev', [
    screenEdge({ id: 'sc1', source: { ward: 'ln1', trigger: 'screen-changed', params: { app: 'Xcode' } } }),
  ]);
  screen.paint(['one']);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 0, 'the frontmost app is Safari, not Xcode');

  // The cap is the per-user hourly window: full, a delivery is dropped whole —
  // and still acknowledged, or the consumer would stall until the window clears.
  screenWindow.set(user, Array.from({ length: 300 }, () => Date.now()));
  screen.app('Xcode');
  await until('the delivery to be acknowledged', () => delivered(core, 'leylines') === null);
  assert.equal(asks.length, 0, 'over the cap, nothing fired');

  screenWindow.delete(user);
  screen.paint(['two', 'three']);
  await until('the next change to fire', () => asks.length === 1);
  assert.match(asks[0]!, /^Xcode \|/);
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
