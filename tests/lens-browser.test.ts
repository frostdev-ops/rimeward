// D3: the browser lens source. The first half drives the real `browserSource`
// over a scripted page read (its own epoch/seq/key rules); the second half runs
// the monitor door on it with a fake browser session, and proves the legacy
// hashed-blob branch is still what a caller without a consumer gets.
import './_setup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { LensCore, SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { LensSettings, Source } from '../src/lib/lens/core.ts';
import { browserOverlay, browserSource, clearInPage, drawInPage, readInPage, translateTrouble } from '../src/lib/lens/browser.ts';
import type { BrowserDeps, PageRead } from '../src/lib/lens/browser.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import { connectMonitorSource, lensSourceId, parseMonitorSource } from '../src/lib/agent/monitor-sources.ts';
import { validateGraph } from '../src/lib/logic.ts';
import { lensToolRun } from '../src/lib/lens/agent.ts';
import type { ToolCtx } from '../src/lib/agent/tools.ts';
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
  page.fail('Browser is offline: its session is not running. Open the browser ward on the dashboard, or call browser_open with a URL, and the session starts; the lens reconnects on its own.');
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

test('the last consumer leaving stops the poll, and a new one starts it again', async (t) => {
  const clock = new FakeClock(5_000_000);
  const page = fakePage(clock);
  page.show([['Only paragraph', 0]]);
  const lensCore = core('lens-browser-idle@example.com', page, clock);
  t.after(() => lensCore.close());

  lensCore.consumer('c');
  await poll(clock, 0);
  await poll(clock);
  const reads = page.reads;
  assert.ok(reads > 0);
  const v = lensCore.status().v;

  // Nobody is reading this page any more: the poll stops, and the document it
  // built stays exactly where it was.
  lensCore.deleteConsumer('c');
  await poll(clock, 5000);
  assert.equal(page.reads, reads, 'a source nobody reads is not polled');
  assert.equal(clock.pending(), 0, 'and owns no timer');
  assert.equal(lensCore.status().v, v);
  assert.equal(lensCore.doc().lines.length, 1);

  // A new consumer reads it again: the source connects a second time.
  lensCore.consumer('d');
  await poll(clock, 0);
  await poll(clock);
  assert.ok(page.reads > reads, 'a new consumer starts the source again');
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
    /Browser is offline: its session is not running\./
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

// ------------------------------------------------------- the page-side scripts

/** The two scripts that run IN the page close over nothing, so running them in
 *  a fresh vm context over a stub DOM is the same contract `page.evaluate`
 *  holds them to: a closure over anything in this module would throw here. */
function pageContext(): {
  scope: Record<string, any>;
  body: any;
  timers: { id: number; fn: () => void }[];
  observers: { cb: (records: unknown[]) => void }[];
  element(text: string | null, rect: [number, number, number, number]): any;
  run<T>(fn: (arg: any) => T, arg: unknown): T;
} {
  const el = (tag: string): any => {
    const node: any = {
      tag,
      nodeType: 1,
      className: '',
      style: {} as Record<string, string>,
      children: [] as any[],
      parentElement: null as any,
      shadow: null as any,
      rect: [0, 0, 0, 0],
      text: '',
      get isConnected(): boolean {
        let at: any = node;
        while (at.parentElement) at = at.parentElement;
        return at.root === true;
      },
      set textContent(value: string) {
        node.text = value;
        node.children = [];
      },
      get textContent(): string {
        return node.text;
      },
      append(...nodes: any[]): void {
        for (const child of nodes) {
          child.parentElement = node;
          node.children.push(child);
        }
      },
      remove(): void {
        const at = node.parentElement?.children.indexOf(node) ?? -1;
        if (at >= 0) node.parentElement.children.splice(at, 1);
        node.parentElement = null;
      },
      attachShadow({ mode }: { mode: string }): any {
        const root = el('#shadow');
        root.mode = mode;
        root.parentElement = node;
        node.shadow = root;
        return root;
      },
      contains(other: any): boolean {
        for (let at = other; at; at = at.parentElement) if (at === node) return true;
        return false;
      },
      closest: () => null,
      getBoundingClientRect: () => ({ x: node.rect[0], y: node.rect[1], width: node.rect[2], height: node.rect[3] }),
    };
    return node;
  };

  const html = el('html');
  html.root = true;
  const body = el('body');
  html.append(body);
  const timers: { id: number; fn: () => void }[] = [];
  const observers: { cb: (records: unknown[]) => void }[] = [];
  let next = 1;
  const scope: Record<string, any> = {
    document: {
      title: 'One',
      documentElement: html,
      body,
      createElement: (tag: string) => el(tag),
      createTreeWalker: (root: any) => {
        const found: any[] = [];
        const walk = (node: any): void => {
          for (const child of node.children ?? []) {
            if (child.nodeType === 3) found.push(child);
            else walk(child);
          }
        };
        walk(root);
        let at = 0;
        return { nextNode: () => found[at++] ?? null };
      },
    },
    location: { href: 'https://pages.test/one' },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: 'block' }),
    addEventListener: () => {},
    MutationObserver: class {
      constructor(cb: (records: unknown[]) => void) {
        observers.push({ cb });
      }
      observe(): void {}
      disconnect(): void {}
    },
    setTimeout: (fn: () => void, _ms: number) => {
      const id = next++;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  scope.window = scope;
  const context = vm.createContext(scope);
  return {
    scope,
    body,
    timers,
    observers,
    element(text, rect): any {
      const block = el('p');
      block.rect = rect;
      if (text !== null) block.children.push({ nodeType: 3, nodeValue: text, parentElement: block });
      body.append(block);
      return block;
    },
    run: <T,>(fn: (arg: any) => T, arg: unknown): T =>
      (vm.runInContext(`(${fn.toString()})`, context) as (a: unknown) => T)(arg),
  };
}

/** Values come back from the vm with the vm's own prototypes; strict deep
 *  equality compares those, so anything structural crosses as JSON first. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SIZES = { card: 360, lines: 6, captionMax: 480, inset: 16, pad: 4 };
const draw = (over: Record<string, unknown>): Record<string, unknown> => ({
  marker: 'rimeLensOverlay',
  id: 'a',
  kind: 'card',
  text: '',
  rect: null,
  corner: null,
  ttlMs: 20_000,
  css: 'CSS',
  sizes: SIZES,
  ...over,
});
const READ = { marker: 'rimeLensReader', overlay: 'rimeLensOverlay', force: false, cap: 500, chars: 1000 };

test('the page overlay is one closed layer, and each kind is placed where the native overlay places it', () => {
  const p = pageContext();

  p.run(drawInPage, draw({ id: 'card-1', kind: 'card', text: 'one\ntwo', corner: 'tr' }));
  const layer = p.scope.rimeLensOverlay;
  assert.equal(layer.host.parentElement, p.scope.document.documentElement, 'outside <body>, where the reader never walks');
  assert.match(String(layer.host.style.cssText), /position:fixed/);
  assert.match(String(layer.host.style.cssText), /pointer-events:none/);
  assert.match(String(layer.host.style.cssText), /z-index:2147483647/);
  assert.equal(layer.host.shadow.mode, 'closed');
  assert.equal(layer.host.shadow.children[0].textContent, 'CSS', 'the lifted look goes in with it');

  const card = layer.items.get('card-1');
  assert.equal(card.className, 'card');
  assert.equal(card.style.width, '360px');
  assert.deepEqual([card.style.right, card.style.top], ['16px', '16px'], 'a corner anchor sits 16 points inside it');
  assert.equal(card.children[0].className, 'card-text');
  assert.equal(card.children[0].textContent, 'one\ntwo');

  // A card shows six lines and fades the rest, exactly as render.js cuts it.
  p.run(drawInPage, draw({ id: 'card-1', kind: 'card', text: [1, 2, 3, 4, 5, 6, 7, 8].join('\n'), corner: 'bl' }));
  assert.equal(layer.items.size, 1, 'the same id replaces what it drew');
  assert.equal(layer.host.shadow.children.length, 2, 'the style and one card, not two cards');
  const long = layer.items.get('card-1');
  assert.equal(long.children[0].className, 'card-text truncated');
  assert.equal(long.children[0].textContent, '1\n2\n3\n4\n5\n6');
  assert.deepEqual([long.style.left, long.style.bottom], ['16px', '16px']);

  // A highlight is the rect plus four on every side (overlay.rs HIGHLIGHT_PAD).
  p.run(drawInPage, draw({ id: 'hl', kind: 'highlight', rect: [100, 50, 20, 10] }));
  const hl = layer.items.get('hl');
  assert.deepEqual([hl.style.left, hl.style.top, hl.style.width, hl.style.height], ['96px', '46px', '28px', '18px']);

  // The per-line caption form: one box per line, at the line's own rectangle.
  p.run(drawInPage, draw({
    id: 'cap-0',
    kind: 'caption',
    rect: [10, 20, 300, 40],
    text: JSON.stringify({ items: [{ rect: [10, 20, 300, 18], text: 'hola' }, { rect: [10, 42, 300, 18], text: 'adios' }] }),
  }));
  const items = layer.items.get('cap-0');
  assert.equal(items.className, 'items');
  assert.deepEqual(items.children.map((c: any) => [c.className, c.textContent, c.style.left, c.style.top, c.style.minWidth]), [
    ['caption-item', 'hola', '10px', '20px', '300px'],
    ['caption-item', 'adios', '10px', '42px', '300px'],
  ]);

  // Plain text is one box at the anchor.
  p.run(drawInPage, draw({ id: 'cap-1', kind: 'caption', text: 'not json at all', rect: [5, 6, 0, 0] }));
  const single = layer.items.get('cap-1');
  assert.equal(single.className, 'caption-single');
  assert.equal(single.textContent, 'not json at all');
  assert.deepEqual([single.style.left, single.style.top, single.style.maxWidth], ['5px', '6px', '480px']);

  // ttl: each one takes itself down.
  assert.equal(p.timers.length, 4);
  for (const timer of [...p.timers]) timer.fn();
  assert.equal(layer.items.size, 0);
  assert.equal(layer.host.shadow.children.length, 1, 'only the style is left');
});

test('overlay_clear takes one thing down or everything, and the layer goes with the last of them', () => {
  const p = pageContext();
  p.run(drawInPage, draw({ id: 'one', corner: 'tl', text: 'x' }));
  p.run(drawInPage, draw({ id: 'two', corner: 'tr', text: 'y' }));

  assert.equal(plain(p.run(clearInPage, { marker: 'rimeLensOverlay', id: 'one' })).cleared, 1);
  assert.equal(p.scope.rimeLensOverlay.items.size, 1);
  assert.equal(p.timers.length, 1, 'its ttl went with it');

  assert.equal(plain(p.run(clearInPage, { marker: 'rimeLensOverlay', id: null })).cleared, 1);
  assert.equal(p.scope.rimeLensOverlay, undefined, 'an empty layer takes itself out of the page');
  assert.equal(p.scope.document.documentElement.children.length, 1, 'the body, and nothing of ours');

  // Nothing drawn: clearing is still an answer, never a throw.
  assert.equal(plain(p.run(clearInPage, { marker: 'rimeLensOverlay', id: null })).cleared, 0);
});

test('what the lens draws on a page is not a change the lens then reads', () => {
  const p = pageContext();
  const block = p.element('Quarterly report', [0, 0, 600, 24]);

  const first = plain(p.run(readInPage, READ))!;
  assert.deepEqual(first.nodes, [{ text: 'Quarterly report', rect: [0, 0, 600, 24] }]);
  assert.equal(p.run(readInPage, READ), null, 'nothing changed since');

  // The lens draws a card: the page itself did not change, so the mutation that
  // causes must not make the next read a repaint — or every overlay_show would
  // deliver an observation of itself.
  p.run(drawInPage, draw({ id: 'card-1', corner: 'tr', text: 'hello' }));
  const host = p.scope.rimeLensOverlay.host;
  p.observers[0]!.cb([{ type: 'childList', target: p.scope.document.documentElement, addedNodes: [host], removedNodes: [] }]);
  assert.equal(p.run(readInPage, READ), null, 'drawing is not something the page did');

  // A change the page itself made still is one.
  p.observers[0]!.cb([{ type: 'childList', target: block, addedNodes: [], removedNodes: [] }]);
  const after = plain(p.run(readInPage, READ))!;
  assert.deepEqual(after.changed, [[0, 0, 600, 24]]);
});

// ------------------------------------------------------------- the pixel tools

/** A browser session as the pixel tools use it: an active page that answers a
 *  screenshot. Seeded into the map `peek` reads, so `browser/session.ts` hands
 *  it over without a chromium anywhere. */
function fakeSession(t: TestContext, user: number, shots: { clip: unknown }[]): void {
  const sessions = ((globalThis as unknown as { __fdBrowserSessions?: Map<string, unknown> }).__fdBrowserSessions ??= new Map());
  const key = `${user}:${WARD}`;
  sessions.set(key, {
    chain: Promise.resolve(),
    lastUsed: 0,
    viewport: { width: 800, height: 600 },
    page: {
      isClosed: () => false,
      viewportSize: () => ({ width: 800, height: 600 }),
      screenshot: async (o: { clip: unknown }): Promise<Buffer> => {
        shots.push(o);
        return Buffer.from('jpeg-bytes');
      },
    },
  });
  t.after(() => void sessions.delete(key));
}

test('lens_crop takes the page as it stands, in CSS pixels of the viewport', async (t) => {
  const { user, page } = ward(t, 'lens-browser-crop@example.com');
  page.show([['Quarterly report', 0]]);
  const shots: { clip: unknown }[] = [];
  fakeSession(t, user, shots);
  const ctx = { userId: user, ward: 'agent:ag1', conv: 31 } as ToolCtx;
  const source = `browser:${WARD}`;

  const crop = (await lensToolRun('lens_crop', { source, rect: [10, 20, 100, 50] }, ctx)) as Record<string, any>;
  assert.deepEqual(shots[0], { clip: { x: 10, y: 20, width: 100, height: 50 }, type: 'jpeg', quality: 80, scale: 'css', timeout: 5000 });
  assert.equal(crop.image, Buffer.from('jpeg-bytes').toString('base64'));
  assert.equal(crop.imageMime, 'image/jpeg');
  assert.deepEqual([crop.w, crop.h], [100, 50], 'at CSS scale the rect IS the image');
  assert.match(String(crop.ref), /^https:\/\/pages\.test\/one#\d+$/, 'the receipt names the document the pixels came from');

  // A rect the viewport does not hold: the sentence says what space a rect is
  // in and what this page's bounds are.
  await assert.rejects(
    () => lensToolRun('lens_crop', { source, rect: [900, 0, 10, 10] }, ctx),
    /falls outside the page's viewport, which is 0,0,800,600.*CSS pixels from the top-left of the VIEWPORT/s
  );
  // Trimmed, not refused, when it only hangs over the edge.
  const edge = (await lensToolRun('lens_crop', { source, rect: [760, 0, 100, 40] }, ctx)) as Record<string, any>;
  assert.deepEqual(shots.at(-1), { clip: { x: 760, y: 0, width: 40, height: 40 }, type: 'jpeg', quality: 80, scale: 'css', timeout: 5000 });
  assert.equal(edge.w, 40);

  // A `ref` from a page the ward has left: refused before a shot is taken.
  await assert.rejects(
    () => lensToolRun('lens_crop', { source, rect: [0, 0, 10, 10], ref: 'https://elsewhere.test/#4' }, ctx),
    /names a page this browser ward has since left/
  );
  // A version the ring no longer holds.
  await assert.rejects(
    () => lensToolRun('lens_crop', { source, rect: [0, 0, 10, 10], v: 9999 }, ctx),
    /has no such version: a browser lens keeps its last 32 document versions/
  );
  assert.equal(shots.length, 2, 'nothing refused reached the page');

  // `lens_look {frame: true}` is the same crop, of the whole viewport.
  const look = (await lensToolRun('lens_look', { source, frame: true }, ctx)) as Record<string, any>;
  assert.equal(look.imageMime, 'image/jpeg');
  assert.deepEqual((shots.at(-1) as { clip: unknown }).clip, { x: 0, y: 0, width: 800, height: 600 });

  // The ward's `pixels` knob is the screen's: off is off for every source.
  saveDashboard(user, validateLayout([...LAYOUT, { i: 'ln1', type: 'lens', size: '3x2', config: { pixels: false } }])!);
  await assert.rejects(() => lensToolRun('lens_crop', { source, rect: [0, 0, 10, 10] }, ctx), /lens_crop is off: /);
  saveDashboard(user, validateLayout(LAYOUT)!);
});

test('lens_text reads the page’s own lines, and says that is where they came from', async (t) => {
  const { user, page } = ward(t, 'lens-browser-text@example.com');
  page.show([
    ['Quarterly report', 0],
    ['Revenue is up', 200],
  ]);
  const ctx = { userId: user, ward: 'agent:ag1', conv: 33 } as ToolCtx;
  const source = `browser:${WARD}`;

  const read = (await lensToolRun('lens_text', { source, rect: [0, 0, 600, 30], accurate: true, src: 'ocr' }, ctx)) as Record<string, any>;
  assert.equal(read.from, 'dom');
  assert.match(String(read.accurate), /no recognition to re-run/, 'accurate has nothing to do on a page');
  assert.match(String(read.text), /^\[lens observation: /, 'observed text always carries the banner');
  const body = JSON.parse(String(read.text).split('\n')[1]!) as { lines: { text: string; src: string }[] };
  assert.deepEqual(body.lines.map((l) => [l.text, l.src]), [['Quarterly report', 'dom']], 'the rect picks one block, and `src` never filters a page away');
  assert.equal(read.lines, 1);
});

test('lens_describe on a page needs a model on this computer, and says so when there is none', async (t) => {
  const { user, page } = ward(t, 'lens-browser-describe@example.com');
  page.show([['Quarterly report', 0]]);
  fakeSession(t, user, []);
  const ctx = { userId: user, ward: 'agent:ag1', conv: 35 } as ToolCtx;
  await assert.rejects(
    () => lensToolRun('lens_describe', { source: `browser:${WARD}`, rect: [0, 0, 10, 10] }, ctx),
    /lens_describe is unavailable: this computer has no on-device model with vision to ask\. To see the region, use lens_crop/
  );
});

test('the overlay tools draw into the ward’s page, and captions say what could translate', async (t) => {
  const { user, page } = ward(t, 'lens-browser-overlay@example.com');
  page.show([['Quarterly report', 0]]);
  const evaluated: { arg: Record<string, any> }[] = [];
  const sessions = ((globalThis as unknown as { __fdBrowserSessions?: Map<string, unknown> }).__fdBrowserSessions ??= new Map());
  const key = `${user}:${WARD}`;
  sessions.set(key, {
    chain: Promise.resolve(),
    lastUsed: 0,
    viewport: { width: 800, height: 600 },
    page: {
      isClosed: () => false,
      evaluate: async (_fn: unknown, arg: Record<string, any>) => {
        evaluated.push({ arg });
        return { id: arg.id, cleared: 1 };
      },
    },
  });
  t.after(() => void sessions.delete(key));
  const ctx = { userId: user, ward: 'agent:ag1', conv: 37 } as ToolCtx;
  const source = `browser:${WARD}`;

  const shown = (await lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', text: 'hi', anchor: { corner: 'tr' } }, ctx)) as Record<string, any>;
  assert.equal(shown.id, 'card-1');
  assert.equal(shown.ttl_s, 20);
  assert.equal(evaluated[0]!.arg.corner, 'tr');
  assert.equal(evaluated[0]!.arg.ttlMs, 20_000);
  assert.match(String(evaluated[0]!.arg.css), /caption-item/, 'the look crosses with it');

  // A ref from another page is refused before anything is drawn, the way an
  // evicted screen frame is.
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', anchor: { rect: [0, 0, 10, 10], ref: 'https://elsewhere.test/#2' } }, ctx),
    /names a page this browser ward has since left/
  );
  // An anchor that is neither a corner nor a rect never reaches the page.
  await assert.rejects(() => lensToolRun('overlay_show', { source, id: 'card-2', kind: 'card', anchor: {} }, ctx), /an anchor is \{corner/);
  // Text past the overlay's own cap is refused rather than silently cut.
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-3', kind: 'card', text: 'x'.repeat(2001), anchor: { corner: 'tl' } }, ctx),
    /too-large/
  );
  assert.equal(evaluated.length, 1);

  assert.equal(((await lensToolRun('overlay_clear', { source, id: 'card-1' }, ctx)) as Record<string, any>).cleared, 'card-1');
  assert.equal(evaluated[1]!.arg.id, 'card-1');
  await lensToolRun('overlay_clear', { source }, ctx);
  assert.equal(evaluated[2]!.arg.id, null, 'no id takes down everything this lens drew');

  // Nothing on a server translates by itself, so captions say which switch
  // would let them rather than reporting `on` and drawing nothing.
  const why = translateTrouble(user);
  assert.match(String(why), /Cloud triage for lens watches/);
  await assert.rejects(() => lensToolRun('lens_captions', { source, on: true }, ctx), /lens_captions is unavailable: nothing on this server can translate/);
  assert.equal(((await lensToolRun('lens_captions', { source, on: false }, ctx)) as Record<string, any>).on, false);
});

test('a browser ward with no session answers the pixel tools with the reason', async (t) => {
  const { user, page } = ward(t, 'lens-browser-nosession@example.com');
  page.show([['Quarterly report', 0]]);
  const ctx = { userId: user, ward: 'agent:ag1', conv: 39 } as ToolCtx;
  const source = `browser:${WARD}`;
  // The source itself is live (its read is the fixture's), but the session the
  // pixels would come from is not there.
  await assert.rejects(() => lensToolRun('lens_crop', { source, rect: [0, 0, 10, 10] }, ctx), /Browser is offline: its session is not running\./);
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', anchor: { corner: 'tl' } }, ctx),
    /Browser is offline: its session is not running\./
  );
});
