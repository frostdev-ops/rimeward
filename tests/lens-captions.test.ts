import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from './fake-clock.ts';
import { Captions, RETRY_MS, captionsFor, screenCaptionSinks, systemLanguage } from '../src/lib/lens/captions.ts';
import type { DrawReq, TranslateReq } from '../src/lib/lens/captions.ts';
import { browserSource } from '../src/lib/lens/browser.ts';
import type { PageRead } from '../src/lib/lens/browser.ts';
import { LensCore } from '../src/lib/lens/core.ts';
import type { LensSettings } from '../src/lib/lens/core.ts';
import { screenSource } from '../src/lib/lens/screen.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import type { Rect } from '../src/lib/lens/types.ts';
import { createUser } from '../src/lib/users.ts';

// BlackIce tests/captions.test.ts, driven through the real screen source on a
// fake desktop: what a batch is, what is discarded, what a move redraws, and
// what a degraded helper reports. The tool half lives in lens-tools.test.ts.

const DISPLAY = { id: 1, w: 1800, h: 1169, scale: 2 };
const GEOMETRY = { window: [195, 92, 656, 422], scale: 2, contentRect: [0, 0, 1312, 844], contentScale: 2, captured: [0, 0, 656, 422] };
const START = 100_000;

type Body = Record<string, unknown>;
const sig = (seq: number, kind: Body, epoch = 1, at = START): Body => ({ type: 'lens', at, epoch, seq, ...kind });
const app = (seq: number, epoch = 1): Body =>
  sig(seq, { kind: 'app', bundle: 'com.apple.Safari', name: 'Safari', pid: 123 }, epoch);
const windowSig = (seq: number, epoch = 1): Body =>
  // Tall enough to hold thirteen caption windows 200 points apart: an OCR line
  // outside the window is dropped on adoption.
  sig(seq, { kind: 'window', id: 5375, title: 'noticias', bounds: [195, 92, 656, 3000], display: DISPLAY }, epoch);
const frameSig = (seq: number, epoch = 1): Body =>
  sig(seq, { kind: 'frame', ref: `f-${epoch}-${seq}`, w: 1312, h: 844, ratio: 0.1, dirty: [], geometry: GEOMETRY }, epoch);
const wire = (text: string, y: number): Body => ({ bbox: [12, y, 300, 18], text });
const ocrSig = (seq: number, lines: Body[], o: { epoch?: number; at?: number; rect?: Rect } = {}): Body =>
  sig(seq, { kind: 'ocr', ref: `f-1-${seq}`, rect: o.rect ?? [0, 0, 656, 422], lines, ms: 20, axCovered: false }, o.epoch ?? 1, o.at ?? START);

interface Deferred {
  texts: string[];
  resolve: (out: string[]) => void;
  reject: (err: Error) => void;
}

interface Harness {
  core: LensCore;
  captions: Captions;
  clock: FakeClock;
  calls: { op: string; value: Body }[];
  of(op: string): Body[];
  hold(): Deferred[];
  inject(body: Body): void;
  tick(): Promise<void>;
  start(): Promise<void>;
}

let users = 0;

function harness(
  over: {
    settings?: { caption_from?: string | null; caption_to?: string | null };
    pairs?: unknown;
    noHelper?: boolean;
    refuse?: Record<string, string>;
    /** Errors the translate op answers with, in order, before it works. */
    transient?: string[];
  } = {}
): Harness {
  const clock = new FakeClock(START);
  const calls: { op: string; value: Body }[] = [];
  const held: Deferred[] = [];
  let holding = false;
  let push: ((signal: Body) => void) | null = null;

  const translate = (texts: string[]): Promise<{ texts: string[] }> => {
    if (!holding) return Promise.resolve({ texts: texts.map((t) => `->${t}`) });
    return new Promise((resolve, reject) => {
      held.push({ texts, resolve: (out) => resolve({ texts: out }), reject });
    });
  };

  const desktop = async (op: string, value?: unknown): Promise<unknown> => {
    calls.push({ op, value: (value ?? {}) as Body });
    const refused = over.refuse?.[op];
    if (refused !== undefined) throw new Error(refused); // what Rust's `{id, error}` becomes
    if (op === 'helper-translate') {
      const next = over.transient?.shift();
      if (next !== undefined) throw new Error(next);
      return translate(((value ?? {}) as { texts: string[] }).texts);
    }
    if (op === 'helper-capabilities') {
      if (over.noHelper) throw new Error('down');
      return { translation: over.pairs ?? [['en', 'es']] };
    }
    if (op === 'overlay-show') return { id: ((value ?? {}) as { id: string }).id };
    if (op === 'overlay-clear') return true;
    throw new Error('standalone');
  };

  const user = createUser(`lens-captions-${++users}@example.com`, 'pw-lens-captions-1');
  const core = new LensCore({
    user,
    target: 'local',
    source: screenSource({ desktop, attach: (fn) => { push = fn; return (): void => { push = null; }; }, now: () => clock.now() }),
    clock,
    store: { ...sqliteStore(user, 'screen:local', () => clock.now()), loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
  });
  // The deps boundary: the screen's three sinks are the three desktop ops, so
  // this fake desktop is still what every assertion below reads.
  const captions = captionsFor(core, {
    ...screenCaptionSinks(desktop),
    clock,
    settings: () => ({ caption_from: null, caption_to: null, ...over.settings }),
  });
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  return {
    core,
    captions,
    clock,
    calls,
    of: (op) => calls.filter((c) => c.op === op).map((c) => c.value),
    hold: () => {
      holding = true;
      return held;
    },
    inject: (body) => push?.(body),
    tick,
    async start() {
      await captions.set({ on: true });
      this.inject(app(1));
      this.inject(windowSig(2));
      this.inject(frameSig(3));
      await tick();
      calls.length = 0;
    },
  };
}

const items = (call: Body | undefined): { rect: Rect; text: string }[] =>
  JSON.parse(String(call?.text ?? '{"items":[]}')).items;

// -------------------------------------------------------------- the batching

test('added lines become batches of at most six vertically adjacent lines', async () => {
  const h = harness();
  await h.start();
  // Eight adjacent lines (2 pt apart, well inside 1.5 line heights) then two
  // more after a wide gap: six, two, and the pair across the gap.
  h.inject(
    ocrSig(4, [
      ...[40, 60, 80, 100, 120, 140, 160, 180].map((y, i) => wire(`uno ${i}`, y)),
      wire('lejos a', 400),
      wire('lejos b', 420),
    ])
  );
  h.clock.advance(750);
  await h.tick();

  assert.deepEqual(
    h.of('helper-translate').map((v) => (v.texts as string[]).length),
    [6, 2, 2],
    'six per batch, then the rest, then the block after the gap'
  );
  const shown = h.of('overlay-show');
  assert.deepEqual(shown.map((v) => v.id), ['cap-0', 'cap-1', 'cap-2']);
  assert.equal(shown[0]?.kind, 'caption');
  assert.equal(shown[0]?.ttlMs, 20_000);
  assert.equal(shown[0]?.epoch, 1);
  assert.deepEqual(shown[0]?.anchor, { rect: [12, 40, 300, 118], ref: 'f-1-3' }, 'the union of the six line boxes');
  assert.deepEqual(items(shown[0]), [40, 60, 80, 100, 120, 140].map((y, i) => ({ rect: [12, y, 300, 18], text: `->uno ${i}` })));

  const first = h.of('helper-translate')[0];
  assert.equal(first?.source, 'en');
  assert.equal(first?.target, 'es');
  assert.equal(first?.epoch, 1);
  assert.equal(first?.seq, 4);
});

test('a translation already in the cache is drawn without a helper call', async () => {
  const h = harness();
  await h.start();
  h.inject(ocrSig(4, [wire('hola', 40), wire('adios', 60)]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.of('helper-translate').length, 1);

  // The same words appear somewhere else on the page: new line ids, same keys.
  h.inject(ocrSig(5, [wire('hola', 300), wire('adios', 320)], { rect: [0, 280, 656, 60] }));
  h.clock.advance(750);
  await h.tick();

  assert.equal(h.of('helper-translate').length, 1, 'nothing new to translate');
  const shown = h.of('overlay-show');
  assert.equal(shown.length, 2);
  assert.deepEqual(items(shown[1]), [
    { rect: [12, 300, 300, 18], text: '->hola' },
    { rect: [12, 320, 300, 18], text: '->adios' },
  ]);
});

// ------------------------------------------------------- what is discarded

test('a translation that lands after the window changed is never drawn', async () => {
  const h = harness();
  await h.start();
  const held = h.hold();
  h.inject(ocrSig(4, [wire('hola', 40)]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(held.length, 1);

  h.inject(app(10, 2)); // the user moved to another window: a new epoch
  await h.tick();
  held[0]?.resolve(['hello']);
  await h.tick();

  assert.deepEqual(h.of('overlay-show'), [], 'the caption described a window nobody is looking at');
});

test('a line removed while it was being translated is never drawn', async () => {
  const h = harness();
  await h.start();
  const held = h.hold();
  h.inject(ocrSig(4, [wire('hola', 40), wire('adios', 60)]));
  h.clock.advance(750);
  await h.tick();

  h.inject(ocrSig(5, [wire('hola', 40)])); // `adios` is gone
  held[0]?.resolve(['hello', 'goodbye']);
  await h.tick();

  const shown = h.of('overlay-show');
  assert.equal(shown.length, 1);
  assert.deepEqual(items(shown[0]), [{ rect: [12, 40, 300, 18], text: 'hello' }]);
});

test('changing the pair discards what the old pair had in flight', async () => {
  const h = harness();
  await h.start();
  const held = h.hold();
  h.inject(ocrSig(4, [wire('hola', 40)]));
  h.clock.advance(750);
  await h.tick();

  await h.captions.set({ on: true, from: 'es', to: 'fr' });
  await h.tick();
  assert.equal(held.length, 2, 'the new pair is warmed; its batch waits for the helper slot');
  assert.deepEqual(h.of('helper-translate')[1]?.texts, ['ok'], 'the warm-up');
  assert.equal(h.of('helper-translate')[1]?.target, 'fr');

  held[0]?.resolve(['hello']);
  held[1]?.resolve(['ok']);
  await h.tick();
  assert.deepEqual(h.of('overlay-show'), [], 'the reply belongs to a pair nobody asked for');
  assert.equal(held.length, 3, 'the old batch done, the new pair re-translates what is on screen');
  assert.equal(h.of('helper-translate')[2]?.target, 'fr');

  held[2]?.resolve(['bonjour']);
  await h.tick();
  assert.deepEqual(items(h.of('overlay-show')[0]), [{ rect: [12, 40, 300, 18], text: 'bonjour' }]);
});

test('turning captions off discards the reply and clears what was drawn', async () => {
  const h = harness();
  await h.start();
  h.inject(ocrSig(4, [wire('hola', 40)]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.of('overlay-show').length, 1);

  const held = h.hold();
  h.inject(ocrSig(5, [wire('hola', 40), wire('adios', 60)]));
  h.clock.advance(750);
  await h.tick();

  const state = await h.captions.set({ on: false });
  assert.deepEqual(state, { on: false, from: 'en', to: 'es', state: 'off' });
  assert.deepEqual(h.of('overlay-clear'), [{ id: 'cap-0' }], 'the caption window it drew is taken down');

  held[0]?.resolve(['goodbye']);
  await h.tick();
  assert.equal(h.of('overlay-show').length, 1, 'nothing new is drawn while captions are off');
});

// ------------------------------------------------------------------- moved

test('a scroll places the same translations again with no helper call', async () => {
  const h = harness();
  await h.start();
  h.inject(ocrSig(4, [wire('hola', 40), wire('adios', 60)]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.of('overlay-show').length, 1);
  assert.equal(h.of('helper-translate').length, 1);

  // The same lines, 30 pt up: ids are adopted, so this is `moved`.
  h.inject(ocrSig(5, [wire('hola', 10), wire('adios', 30)]));
  await h.tick();

  assert.equal(h.of('helper-translate').length, 1, 'a move never asks the helper again');
  const shown = h.of('overlay-show');
  assert.equal(shown.length, 2);
  assert.equal(shown[1]?.id, 'cap-0', 'the same caption window');
  assert.deepEqual(items(shown[1]), [
    { rect: [12, 10, 300, 18], text: '->hola' },
    { rect: [12, 30, 300, 18], text: '->adios' },
  ]);
  assert.deepEqual(shown[1]?.anchor, { rect: [12, 10, 300, 38], ref: 'f-1-3' });
});

// ------------------------------------------------------------- latest wins

test('translates go to the helper one at a time; a newer batch for a waiting window replaces it', async () => {
  const h = harness();
  await h.start();
  const held = h.hold();
  // Thirteen blocks far enough apart to be thirteen batches over six caption
  // windows: one at the helper, the rest queued, and the thirteenth (cap-0
  // again) replaces the queued cap-0 batch instead of joining the line.
  h.inject(ocrSig(4, Array.from({ length: 13 }, (_, i) => wire(`l${i}`, i * 200))));
  h.clock.advance(750);
  await h.tick();

  assert.equal(held.length, 1, 'one translate at the helper, the rest wait');
  assert.deepEqual(held[0]?.texts, ['l0']);

  for (let n = 0; n < 6; n++) {
    held[n]?.resolve([`t${n}`]);
    await h.tick();
  }
  assert.equal(held.length, 7, 'each reply lets the next batch go');
  assert.deepEqual(
    held.slice(1, 7).map((d) => d.texts),
    [['l7'], ['l8'], ['l9'], ['l10'], ['l11'], ['l12']],
    'one waiting batch per window and the newest wins: six windows can only ever show six batches'
  );

  held[6]?.resolve(['twelve']);
  await h.tick();
  const shown = h.of('overlay-show').filter((v) => v.id === 'cap-0');
  assert.deepEqual(
    shown.map((v) => items(v)[0]?.text),
    ['t0', 'twelve']
  );
  for (const overtaken of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) {
    assert.equal(
      h.of('helper-translate').some((v) => (v.texts as string[]).includes(overtaken)),
      false,
      `${overtaken} was overtaken and never reached the helper`
    );
  }
});

// --------------------------------------------------------------- degraded

test('turning captions on warms the pair, and a busy helper is retried until it answers', async () => {
  const transient: string[] = [];
  const h = harness({ transient });
  await h.captions.set({ on: true });
  const warm = h.of('helper-translate')[0];
  assert.deepEqual(warm?.texts, ['ok'], 'the warm-up carries one throwaway text');
  transient.push('busy', 'deadline');
  h.inject(app(1));
  h.inject(windowSig(2));
  h.inject(frameSig(3));
  h.calls.length = 0;
  h.inject(ocrSig(4, [wire('hello', 34)]));
  h.clock.advance(750);
  await h.tick();
  await h.tick();
  assert.equal(h.of('overlay-show').length, 0, 'the first answer was busy');
  assert.equal(h.captions.state().error, undefined, 'a transient answer is not the reported error');
  h.clock.advance(RETRY_MS);
  await h.tick();
  await h.tick();
  assert.equal(h.of('overlay-show').length, 0, 'the second answer was a deadline');
  h.clock.advance(RETRY_MS * 2);
  await h.tick();
  await h.tick();
  const shown = h.of('overlay-show');
  assert.equal(shown.length, 1, 'the third attempt drew');
  assert.deepEqual(items(shown[0]).map((item) => item.text), ['->hello']);
  assert.equal(h.captions.state().error, undefined);
});

test('a missing translation pack is reported and nothing is drawn', async () => {
  const h = harness();
  await h.start();
  const held = h.hold();
  h.inject(ocrSig(4, [wire('hola', 40)]));
  h.clock.advance(750);
  await h.tick();
  held[0]?.reject(new Error('not-installed'));
  await h.tick();

  assert.deepEqual(h.of('overlay-show'), []);
  assert.deepEqual(h.captions.state(), {
    on: true,
    from: 'en',
    to: 'es',
    state: 'unavailable',
    error: 'not-installed en->es',
  });
});

// ------------------------------------------------------------- the defaults

test('the pair falls back from settings to the helper to en plus the system language', async () => {
  const stored = harness({ settings: { caption_from: 'de', caption_to: 'fr' } });
  assert.deepEqual(await stored.captions.set({ on: true }), { on: true, from: 'de', to: 'fr', state: 'on' });

  const helper = harness({ pairs: [['ja', 'en']] });
  assert.deepEqual(await helper.captions.set({ on: true }), { on: true, from: 'ja', to: 'en', state: 'on' });

  const bare = harness({ noHelper: true });
  assert.deepEqual(await bare.captions.set({ on: true }), { on: true, from: 'en', to: systemLanguage(), state: 'on' });

  const explicit = harness({ settings: { caption_from: 'de', caption_to: 'fr' } });
  assert.deepEqual(await explicit.captions.set({ on: true, from: 'es', to: 'en' }), {
    on: true,
    from: 'es',
    to: 'en',
    state: 'on',
  });
});

// ------------------------------------------------------------------ timing

test('stats report the batches and how long each one took to be drawn', async () => {
  const h = harness();
  await h.start();
  assert.deepEqual(h.captions.stats(), { batches: 0, p50Ms: 0, p95Ms: 0 });

  // A batch the helper answers at once, inside one instant of the fake clock.
  h.inject(ocrSig(4, [wire('hola', 40)]));
  h.clock.advance(750);
  await h.tick();
  assert.deepEqual(h.captions.stats(), { batches: 1, p50Ms: 0, p95Ms: 0 });

  // One the helper sits on for 300 ms. `at` is the document version's own
  // stamp, so what is measured is the settled document to the drawn caption.
  const held = h.hold();
  h.inject(ocrSig(5, [wire('adios', 300)], { rect: [0, 280, 656, 60] }));
  h.clock.advance(750);
  await h.tick();
  h.clock.advance(300);
  held[0]?.resolve(['goodbye']);
  await h.tick();

  assert.deepEqual(h.captions.stats(), { batches: 2, p50Ms: 0, p95Ms: 300 });
});

// ----------------------------------------------------------- another source

/** The same `Captions` over a browser ward: the class knows nothing about a
 *  desktop op any more, so a page draws and translates through plain functions
 *  and every rule above (batching, discarding, the reported error) still holds. */
function browserHarness(over: { answer?: () => { texts: string[] } | { error: string } } = {}): {
  captions: Captions;
  clock: FakeClock;
  drawn: DrawReq[];
  cleared: (string | undefined)[];
  asked: TranslateReq[];
  show(nodes: [string, number][]): void;
  tick(): Promise<void>;
} {
  const clock = new FakeClock(START);
  const drawn: DrawReq[] = [];
  const cleared: (string | undefined)[] = [];
  const asked: TranslateReq[] = [];
  let nodes: PageRead['nodes'] = [];
  let fresh = true;
  let dirty = true;
  const user = createUser(`lens-captions-browser-${++users}@example.com`, 'pw-lens-captions-1');
  const core = new LensCore({
    user,
    target: 'br1',
    source: browserSource({
      clock,
      every: 250,
      read: async (): Promise<PageRead | null> => {
        if (!fresh && !dirty) return null;
        const read: PageRead = { url: 'https://pages.test/one', title: 'One', fresh, nodes: [...nodes], changed: [] };
        fresh = false;
        dirty = false;
        return read;
      },
    }),
    clock,
    store: { ...sqliteStore(user, 'browser:br1', () => clock.now()), loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
  });
  const captions = captionsFor(core, {
    clock,
    settings: () => ({ caption_from: 'en', caption_to: 'es' }),
    draw: async (req) => {
      drawn.push(req);
      return { id: req.id };
    },
    clear: async (id) => {
      cleared.push(id);
      return true;
    },
    translate: async (req) => {
      asked.push(req);
      return over.answer ? over.answer() : { texts: req.texts.map((t) => `->${t}`) };
    },
  });
  return {
    captions,
    clock,
    drawn,
    cleared,
    asked,
    show(next): void {
      nodes = next.map(([text, y]) => ({ text, rect: [0, y, 600, 24] }));
      dirty = true;
    },
    async tick(): Promise<void> {
      clock.advance(250);
      for (let n = 0; n < 4; n++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a browser ward captions through its own sinks, and nothing here is a desktop op', async () => {
  const h = browserHarness();
  h.show([['hola', 40], ['adios', 64]]);
  assert.deepEqual(await h.captions.set({ on: true }), { on: true, from: 'en', to: 'es', state: 'on' });
  assert.equal(h.asked[0]?.warm, true, 'the pair is warmed first, whatever translates it');
  await h.tick();

  assert.deepEqual(h.asked[1]?.texts, ['hola', 'adios']);
  assert.equal(h.asked[1]?.from, 'en');
  assert.equal(h.drawn.length, 1);
  assert.equal(h.drawn[0]?.kind, 'caption');
  assert.equal(h.drawn[0]?.id, 'cap-0');
  assert.deepEqual(h.drawn[0]?.anchor, { rect: [0, 40, 600, 48], ref: 'https://pages.test/one#1' }, 'the union of the lines, pinned to the read they came from');
  assert.deepEqual(JSON.parse(String(h.drawn[0]?.text)).items, [
    { rect: [0, 40, 600, 24], text: '->hola' },
    { rect: [0, 64, 600, 24], text: '->adios' },
  ]);

  // Turning them off takes down what was drawn, through the same sink.
  await h.captions.set({ on: false });
  assert.deepEqual(h.cleared, ['cap-0']);
});

test('a translator that refuses answers with a value, and the state says what it said', async () => {
  const h = browserHarness({ answer: () => ({ error: 'not-installed' }) });
  h.show([['hola', 40]]);
  await h.captions.set({ on: true });
  await h.tick();
  assert.deepEqual(h.drawn, [], 'nothing is drawn from a refusal');
  assert.deepEqual(h.captions.state(), {
    on: true,
    from: 'en',
    to: 'es',
    state: 'unavailable',
    error: 'not-installed en->es',
  });
});
