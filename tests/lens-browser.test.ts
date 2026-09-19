// D3: the browser lens source. The first half drives the real `browserSource`
// over a scripted page read (its own epoch/seq/key rules); the second half runs
// the monitor door on it with a fake browser session, and proves the legacy
// hashed-blob branch is still what a caller without a consumer gets.
import './_setup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { LensCore, SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { LensSettings, Source } from '../src/lib/lens/core.ts';
import { browserSource } from '../src/lib/lens/browser.ts';
import type { BrowserDeps, PageRead } from '../src/lib/lens/browser.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import { connectMonitorSource, lensSourceId, parseMonitorSource } from '../src/lib/agent/monitor-sources.ts';
import { validateGraph } from '../src/lib/logic.ts';
import { FakeClock } from './fake-clock.ts';

const WARD = 'br1';

interface FakePage {
  deps: BrowserDeps;
  /** What the tab shows from now on; `changed` is what repainted. */
  show(nodes: [string, number][], opts?: { url?: string; title?: string; changed?: boolean }): void;
  /** The next read throws, the way a session that went away does. */
  fail(error: string | null): void;
  reads: number;
}

/** A page whose blocks are `[text, y]`, each 600x24 wide at that y. */
function fakePage(clock: FakeClock): FakePage {
  let url = 'https://pages.test/one';
  let title = 'One';
  let nodes: PageRead['nodes'] = [];
  let changed: PageRead['changed'] = [];
  let dirty = false;
  let fresh = true;
  let error: string | null = null;
  const state: FakePage = {
    reads: 0,
    deps: {
      clock,
      every: 250,
      read: async (_user, _ward, force): Promise<PageRead | null> => {
        if (error) throw Error(error);
        state.reads += 1;
        if (!fresh && !dirty && !force) return null;
        const read: PageRead = { url, title, fresh, nodes: [...nodes], changed: [...changed] };
        fresh = false;
        dirty = false;
        changed = [];
        return read;
      },
    },
    show(next, opts = {}): void {
      if (opts.url && opts.url !== url) {
        url = opts.url;
        fresh = true; // a new document: the page-side reader went with the old one
      }
      if (opts.title) title = opts.title;
      nodes = next.map(([text, y]) => ({ text, rect: [0, y, 600, 24] }));
      if (opts.changed) changed = next.map(([, y]) => [0, y, 600, 24] as PageRead['changed'][number]);
      dirty = true;
    },
    fail(next): void {
      error = next;
    },
  };
  return state;
}

function core(email: string, page: FakePage, clock: FakeClock): LensCore {
  const user = createUser(email, 'pw-lens-browser-1');
  return new LensCore({
    user,
    target: WARD,
    source: browserSource(page.deps),
    clock,
    store: { ...sqliteStore(user, `browser:${WARD}`, () => clock.now()), loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
  });
}

/** The lens registry builds its cores on the SYSTEM clock, so a monitor test
 *  advances the fake clock for the source's own poll and then waits for real. */
async function step(clock: FakeClock, ms = 250): Promise<void> {
  clock.advance(ms);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function until(what: string, fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** One poll of the source, plus the microtask work its read hands off. */
async function poll(clock: FakeClock, ms = 250): Promise<void> {
  clock.advance(ms);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('the browser source: one line per block, a navigation is an epoch, one seq per read', async (t) => {
  const clock = new FakeClock(1_000_000);
  const page = fakePage(clock);
  page.show([
    ['Quarterly report', 0],
    ['Revenue is up', 32],
    ['Revenue is up', 64], // the same text twice: two lines, two ids
  ]);
  const lensCore = core('lens-browser-source@example.com', page, clock);
  t.after(() => lensCore.close());

  const seen: string[] = [];
  lensCore.on('delivery', (_id, d) => seen.push(`${d.kind} epoch=${d.epoch}`));
  lensCore.consumer('c');
  await poll(clock, 0); // the consumer is what connects the source

  const doc = lensCore.doc();
  assert.equal(doc.epoch, 1);
  assert.equal(doc.lines.length, 3);
  assert.deepEqual(
    doc.lines.map((line) => [line.text, line.key, line.src, line.bbox]),
    [
      ['Quarterly report', 'Quarterly report', 'dom', [0, 0, 600, 24]],
      ['Revenue is up', 'Revenue is up', 'dom', [0, 32, 600, 24]],
      ['Revenue is up', 'Revenue is up', 'dom', [0, 64, 600, 24]],
    ],
    'the key is the normalised text, and two blocks reading the same are two lines'
  );
  assert.equal(new Set(doc.lines.map((line) => line.id)).size, 3);
  assert.equal(doc.meta.url?.value, 'https://pages.test/one');
  assert.equal(doc.meta.title?.value, 'One');
  assert.deepEqual(seen, ['key epoch=1'], 'the url header forces the first keyframe');
  const firstSeq = lensCore.status().seq;
  assert.ok(firstSeq > 0);

  // A read that finds nothing changed is no seq, no version, no delivery.
  const before = lensCore.status();
  await poll(clock);
  assert.equal(lensCore.status().seq, before.seq);
  assert.equal(lensCore.status().v, before.v);

  // A change in place: one seq, and it settles into one delta.
  lensCore.history('c', { ack: `c:1`, limit: 1 });
  page.show(
    [
      ['Quarterly report', 0],
      ['Revenue is up', 32],
      ['Revenue is up', 64],
      ['One more paragraph', 96],
    ],
    { changed: true }
  );
  await poll(clock);
  assert.equal(lensCore.status().seq, firstSeq + 1, 'one read is one seq');
  await poll(clock, 750);
  assert.deepEqual(seen, ['key epoch=1', 'delta epoch=1']);
  assert.equal(lensCore.doc().epoch, 1, 'a mutation is not a navigation');

  // A navigation: a new document, a new epoch, and nothing the old page said.
  lensCore.history('c', { ack: 'c:2', limit: 1 });
  page.show([['A different page entirely', 0]], { url: 'https://pages.test/two', title: 'Two' });
  await poll(clock);
  assert.equal(lensCore.doc().epoch, 2);
  assert.deepEqual(
    lensCore.doc().lines.map((line) => line.text),
    ['A different page entirely']
  );
  assert.equal(lensCore.doc().meta.title?.value, 'Two');
  assert.deepEqual(seen, ['key epoch=1', 'delta epoch=1', 'key epoch=2']);
  const last = lensCore.status().seq;

  // The session goes away, then comes back: offline, then live again.
  page.fail('Browser is offline; waiting for its session to reconnect.');
  await poll(clock);
  assert.equal(lensCore.status().state, 'offline');
  assert.match(lensCore.status().error ?? '', /Browser is offline/);
  page.fail(null);
  await poll(clock);
  assert.equal(lensCore.status().state, 'live');
  assert.equal(lensCore.status().seq, last, 'coming back is not a read of its own');
});

test('the browser source stops polling when the core closes', async (t) => {
  const clock = new FakeClock(2_000_000);
  const page = fakePage(clock);
  page.show([['Only paragraph', 0]]);
  const lensCore = core('lens-browser-close@example.com', page, clock);
  t.after(() => lensCore.close());
  lensCore.consumer('c');
  await poll(clock, 0);
  await poll(clock);
  const reads = page.reads;
  assert.ok(reads > 0);
  lensCore.close();
  await poll(clock, 5000);
  assert.equal(page.reads, reads, 'a closed core reads nothing more');
  assert.equal(clock.pending(), 0, 'and leaves no timer behind');
});

test('snapshot() is a full re-read even when nothing changed', async (t) => {
  const clock = new FakeClock(3_000_000);
  const page = fakePage(clock);
  page.show([['The only paragraph', 0]]);
  const source = browserSource(page.deps);
  const user = createUser('lens-browser-snapshot@example.com', 'pw-lens-browser-1');
  const lensCore = new LensCore({
    user,
    target: WARD,
    source,
    clock,
    store: { ...sqliteStore(user, `browser:${WARD}`, () => clock.now()), loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
  });
  t.after(() => lensCore.close());
  lensCore.consumer('c');
  await poll(clock, 0);

  // Nothing has changed since the connect read, and the snapshot still answers:
  // it is the full repaint gap recovery rebuilds from.
  const snap = await source.snapshot!();
  assert.ok(snap);
  assert.equal(snap.epoch, 1);
  assert.deepEqual(
    snap.lines.map((line) => line.text),
    ['The only paragraph']
  );
  assert.equal(snap.meta.url?.value, 'https://pages.test/one');
  assert.ok((await source.snapshot!())!.seq > snap.seq, 'each read is its own seq');
});

// ------------------------------------------------------------ the monitor door

const LAYOUT = [
  { i: WARD, type: 'browser', size: '3x2' },
  { i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } },
];

function ward(t: TestContext, email: string): { user: number; page: FakePage; clock: FakeClock } {
  const user = createUser(email, 'pw-lens-browser-1');
  saveDashboard(user, validateLayout(LAYOUT)!);
  const clock = new FakeClock(4_000_000);
  const page = fakePage(clock);
  const real = SOURCES.browser!;
  SOURCES.browser = (): Source => browserSource(page.deps);
  t.after(() => {
    releaseLens(user, `browser:${WARD}`);
    SOURCES.browser = real;
  });
  return { user, page, clock };
}

test('a browser monitor with a consumer reads the ward through its lens', async (t) => {
  const { user, page, clock } = ward(t, 'lens-browser-monitor@example.com');
  assert.equal(lensSourceId({ type: 'browser', target: WARD }), `browser:${WARD}`);
  page.show([['Build queue is empty', 0]]);
  const lensCore = lens(user, `browser:${WARD}`, (): LensSettings => ({ settleMs: 0, minLines: 1 }))!;
  assert.ok(lensCore);

  const events: { key: string; data: Record<string, unknown>; baseline?: boolean }[] = [];
  const errors: string[] = [];
  const off = await connectMonitorSource(
    user,
    parseMonitorSource({ type: 'browser', target: WARD, regex: 'failed' }),
    (key, data, baseline) => events.push({ key, data, baseline }),
    (error) => errors.push(error),
    undefined,
    'mon-browser1'
  );
  t.after(() => off());
  await until('the first read to land', () => events.length >= 2);

  // One baseline per connect, and then the first read's keyframe: `url` is a
  // keyframe key, so a page arriving (or a navigation) is an observation on its
  // own and reaches the monitor whatever its watch says.
  assert.equal(events.length, 2);
  assert.equal(events[0]!.baseline, true);
  assert.equal(events[0]!.data.source, `browser:${WARD}`);
  assert.ok(String(events[0]!.data.text).startsWith(OBSERVATION_BANNER));
  assert.equal(events[1]!.data.eventType, 'key');
  assert.ok(String(events[1]!.data.text).includes('Build queue is empty'));
  lensCore.look('mon-browser1', { ack: String(events[1]!.data.delivery), fields: [] });

  const watches = lensCore.consumer('mon-browser1', 'monitor').watches;
  assert.equal(watches.length, 1);
  assert.equal(watches[0]!.spec.regex, 'failed');

  page.show(
    [
      ['Build queue is empty', 0],
      ['step one is green', 32],
    ],
    { changed: true }
  );
  await step(clock);
  await step(clock);
  assert.equal(events.length, 2, 'a change the watch does not want is not delivered');

  page.show(
    [
      ['Build queue is empty', 0],
      ['step one is green', 32],
      ['step two failed', 64],
    ],
    { changed: true }
  );
  await step(clock);
  await until('the watch hit to be delivered', () => events.length > 2);
  assert.equal(events.length, 3, 'the watch hit is delivered');
  assert.equal(events[2]!.key, events[2]!.data.delivery);
  assert.ok(String(events[2]!.data.text).includes('step two failed'));
  assert.deepEqual(errors, []);
});

test('a browser monitor without a consumer still takes the legacy branch', async (t) => {
  const { user } = ward(t, 'lens-browser-legacy@example.com');
  // The legacy branch reads the ward's session directly, and there is none here:
  // its own message is what proves the lens door was not taken.
  await assert.rejects(
    connectMonitorSource(
      user,
      parseMonitorSource({ type: 'browser', target: WARD }),
      () => {},
      () => {}
    ),
    /Browser is offline; waiting for its session to reconnect\./
  );
});

test('a watch-matched leyline anchors on a browser ward', () => {
  const layout = validateLayout(LAYOUT)!;
  const edge = (ward: string): unknown => ({
    id: 'w1',
    source: { ward, trigger: 'watch-matched', params: { for: 'a checkout error', regex: 'error' } },
    conditions: [],
    action: { type: 'agent.ask', ward: 'ag1', params: { prompt: '{{lens.text}}' } },
    enabled: true,
  });
  assert.ok(validateGraph({ edges: [edge(WARD)] }, layout, { isAdmin: false }));
  // The agent ward beside it reads no lens, so it is still refused.
  assert.equal(validateGraph({ edges: [edge('ag1')] }, layout, { isAdmin: false }), null);
});
