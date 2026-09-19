import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from './fake-clock.ts';
import { LensCore } from '../src/lib/lens/core.ts';
import type { LensSettings } from '../src/lib/lens/core.ts';
import { crop, describe, screenSource, text } from '../src/lib/lens/screen.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import type { Delivery, Rect } from '../src/lib/lens/types.ts';
import { createUser } from '../src/lib/users.ts';

// The screen half of BlackIce's scene.test.ts and core.test.ts, driven through
// the real screen source on a fake desktop: what a signal does to the document,
// and what the three screen-only reads ask the native side for. The rest of the
// wire contract is pinned by the lifted fixtures (tests/lens-replay.test.ts),
// which replay through this same module.

const DISPLAY = { id: 1, w: 1800, h: 1169, scale: 2 };
const GEOMETRY = { window: [195, 92, 656, 422], scale: 2, contentRect: [0, 0, 1312, 844], contentScale: 2, captured: [0, 0, 656, 422] };

type Body = Record<string, unknown>;
const sig = (seq: number, kind: Body, epoch = 1, at = seq * 10): Body => ({ type: 'lens', at, epoch, seq, ...kind });
const app = (seq: number, bundle = 'com.apple.dt.Xcode', epoch = 1): Body =>
  sig(seq, { kind: 'app', bundle, name: bundle.split('.').pop() ?? 'App', pid: 123 }, epoch);
const windowSig = (seq: number, title = 'main.rs', epoch = 1): Body =>
  sig(seq, { kind: 'window', id: 5375, title, bounds: [195, 92, 656, 422], display: DISPLAY }, epoch);
const wire = (text: string, y: number): Body => ({ bbox: [12, y, 300, 18], text });
const axText = (seq: number, lines: Body[], epoch = 1, rect: Rect = [0, 0, 656, 422]): Body =>
  sig(seq, { kind: 'ax-text', rect, lines }, epoch);
const ocrSig = (seq: number, lines: Body[], axCovered = false, epoch = 1, rect: Rect = [0, 0, 656, 422]): Body =>
  sig(seq, { kind: 'ocr', ref: `f-${epoch}-${seq}`, rect, lines, ms: 40, axCovered }, epoch);
const frameSig = (seq: number, dirty: { bbox: Rect; d: number }[] = [], at?: number, epoch = 1): Body =>
  sig(seq, { kind: 'frame', ref: `f-${epoch}-${seq}`, w: 1312, h: 844, ratio: 0.1, dirty, geometry: GEOMETRY }, epoch, at);

let users = 0;

interface Harness {
  core: LensCore;
  clock: FakeClock;
  calls: { op: string; value: unknown; deadlineMs: number | undefined }[];
  reply(op: string, value: unknown): void;
  inject(body: Body): void;
  sent(id: string): Delivery[];
  desktop: (op: string, value?: unknown, deadlineMs?: number) => Promise<unknown>;
  tick(): Promise<void>;
}

function harness(): Harness {
  const clock = new FakeClock(100_000);
  const calls: { op: string; value: unknown; deadlineMs: number | undefined }[] = [];
  const replies = new Map<string, unknown[]>();
  const sent = new Map<string, Delivery[]>();
  let push: ((signal: Body) => void) | null = null;

  const desktop = async (op: string, value?: unknown, deadlineMs?: number): Promise<unknown> => {
    calls.push({ op, value, deadlineMs });
    const queue = replies.get(op);
    const next = queue && queue.length > 0 ? queue.shift() : undefined;
    if (next === undefined) throw new Error('standalone');
    if (next instanceof Error) throw next;
    return next;
  };

  const user = createUser(`lens-screen-${++users}@example.com`, 'pw-lens-screen-1');
  const source = screenSource({
    desktop,
    attach: (fn) => {
      push = fn;
      return (): void => {
        push = null;
      };
    },
    now: () => clock.now(),
  });
  const core = new LensCore({
    user,
    target: 'local',
    source,
    clock,
    store: { ...sqliteStore(user, 'screen:local', () => clock.now()), loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
  });
  core.on('delivery', (id, delivery) => {
    const list = sent.get(id);
    if (list) list.push(delivery);
    else sent.set(id, [delivery]);
  });

  return {
    core,
    clock,
    calls,
    desktop,
    reply(op, value) {
      const queue = replies.get(op);
      if (queue) queue.push(value);
      else replies.set(op, [value]);
    },
    inject: (body) => push?.(body),
    sent: (id) => sent.get(id) ?? [],
    tick: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
}

const ackLast = (h: Harness, id: string): Delivery => {
  const last = h.sent(id).at(-1) as Delivery;
  assert.ok(last, 'a delivery to acknowledge');
  h.core.look(id, { ack: last.delivery });
  return last;
};

/** App, window and one line of text, every keyframe acknowledged: the state
 *  every delta test starts from. `app` and `window` each force a keyframe of
 *  their own, so the head lands before the text does. */
async function primed(h: Harness, id: string): Promise<void> {
  h.core.consumer(id); // the first read is what connects the source
  h.inject(app(1));
  h.inject(windowSig(2));
  await h.tick();
  assert.equal(ackLast(h, id).kind, 'key', 'the first delivery is always a keyframe');
  h.inject(axText(3, [wire('let x = 1', 34)]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(ackLast(h, id).kind, 'key', 'the window header changed since the cursor');
}

test('the header fields are the screen\'s own strings, and an app switch is a new epoch', async () => {
  const h = harness();
  await primed(h, 'c');
  const meta = h.core.doc().meta;
  assert.equal(meta.app?.value, 'com.apple.dt.Xcode "Xcode" pid=123');
  assert.equal(meta.window?.value, '5375 "main.rs" display=1 1800x1169 @2');
  assert.deepEqual(meta.window?.bounds, [195, 92, 656, 422]);

  h.inject(app(1, 'com.apple.Safari', 2));
  h.inject(axText(2, [wire('a fresh epoch', 34)], 2));
  await h.tick();
  const doc = h.core.doc();
  assert.equal(doc.epoch, 2);
  assert.deepEqual(doc.lines.map((l) => l.text), ['a fresh epoch']);
  assert.equal(doc.meta.window, undefined, 'the old epoch\'s header went with it');
  assert.equal(h.sent('c').at(-1)?.kind, 'key', 'an app switch flushes a keyframe');
});

test('a signal from a dead epoch never enters the document', async () => {
  const h = harness();
  await primed(h, 'c');
  const before = h.core.doc().v;

  h.inject(axText(99, [wire('from the past', 34)], 0));
  h.inject(sig(99, { kind: 'ax-focus', role: 'AXTextField', label: 'gone', value: 'x', bounds: null }, 0));
  // Nothing but an app or a window may open an epoch, however new it is.
  h.inject(axText(99, [wire('from the future', 34)], 9));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().v, before, 'nothing to freeze');
  assert.equal(h.core.doc().epoch, 1);
  assert.equal(h.core.doc().lines.some((l) => l.text !== 'let x = 1'), false);
});

test('an axCovered OCR removes nothing, and an ordinary one owns its rect', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(axText(4, [wire('Save changes?', 0), wire('Discard', 40)]));
  await h.tick();
  const ids = h.core.doc().lines.map((l) => l.id);

  h.inject(ocrSig(5, [], true));
  h.clock.advance(750);
  await h.tick();
  assert.deepEqual(h.core.doc().lines.map((l) => l.src), ['ax', 'ax'], 'an axCovered read is empty by design');

  h.inject(ocrSig(6, [wire('Save changes?', 0), wire('Discard', 40)]));
  await h.tick();
  assert.deepEqual(h.core.doc().lines.map((l) => l.src), ['ocr', 'ocr']);
  assert.deepEqual(h.core.doc().lines.map((l) => l.id), ids, 'the same text in the same place is the same line');
  assert.deepEqual(h.core.doc().lines.map((l) => l.conf), [1, 1]);
});

test('focus is a header field that delivers, and a sheet flushes at once', async () => {
  const h = harness();
  await primed(h, 'c');

  h.inject(sig(10, { kind: 'ax-focus', role: 'AXTextArea', label: 'editor', value: 'later', bounds: [0, 32, 656, 384] }));
  // An older read cannot overwrite it.
  h.inject(sig(9, { kind: 'ax-value', role: 'AXTextArea', label: 'editor', value: 'earlier', bounds: null }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().meta.focus?.value, 'AXTextArea "editor" value="later"');
  assert.equal(ackLast(h, 'c').kind, 'delta', 'focus is a rule key: it delivers on its own');

  const before = h.sent('c').length;
  h.inject(sig(11, { kind: 'ax-sheet', title: 'Save As', bounds: [100, 100, 400, 200] }));
  assert.equal(h.core.doc().meta.sheet?.value, '"Save As"');
  assert.equal(h.sent('c').length, before + 1, 'a sheet does not wait for the settle window');
  assert.equal(h.sent('c').at(-1)?.kind, 'key');
});

test('a frame pins the ref, collects its dirty rectangles and opens the settle window', async () => {
  const h = harness();
  await primed(h, 'c');
  const dirty = { bbox: [0, 200, 100, 50] as Rect, d: 0.42 };

  h.inject(frameSig(10, [dirty], h.clock.now()));
  assert.deepEqual(h.core.doc().dirty, [dirty], 'collected on the working copy until the freeze');
  h.clock.advance(750);
  await h.tick();

  const delta = h.sent('c').at(-1) as Delivery;
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.ref, 'f-1-10', 'the version is pinned to the frame it was made against');
  assert.match(delta.text, /~ 0,200,100,50/);

  // A source-named live region is churn: the gate keeps it out of the candidates.
  h.inject(frameSig(11, [{ bbox: [0, 0, 10, 10], d: 0.01 }], h.clock.now()));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.sent('c').at(-1)?.delivery, delta.delivery, 'a change under the visual threshold delivers nothing');
});

test('a gap recovers from the snapshot: the boundary discards, newer applies, the keyframe is forced', async () => {
  const h = harness();
  await primed(h, 'c');

  h.reply('lens-snapshot', {
    epoch: 1,
    seq: 50,
    app: { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 123 },
    window: { id: 5375, title: 'main.rs', bounds: [195, 92, 656, 422], url: null, display: DISPLAY },
    display: DISPLAY,
    focus: null,
    sheet: null,
    axText: [wire('let x = 1', 34), wire('from the snapshot', 52)],
    ocr: [],
    latest: { ref: 'f-1-50', geometry: GEOMETRY },
    live: false,
  });

  h.inject(sig(51, { kind: 'gap', from: 10, to: 50 }));
  assert.equal(h.core.doc().incomplete, true, 'incomplete until the snapshot lands');
  const band: Rect = [0, 80, 656, 60];
  h.inject(axText(45, [wire('stale queue', 90)], 1, band));
  h.inject(axText(60, [wire('after the boundary', 108)], 1, band));
  await h.tick();

  assert.deepEqual(h.calls.map((c) => c.op), ['lens-snapshot', 'lens-snapshot'], 'one on connect, one for the gap');
  assert.equal(h.calls[0]?.deadlineMs, 2_000);
  assert.deepEqual(
    h.core.doc().lines.map((l) => l.text),
    ['let x = 1', 'from the snapshot', 'after the boundary']
  );
  assert.equal(h.core.doc().incomplete, false);

  // Anything at or below the boundary stays out for the rest of the epoch.
  h.inject(axText(50, [wire('still stale', 126)], 1, band));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().lines.some((l) => l.text === 'still stale'), false);

  const recovery = h.sent('c').at(-1) as Delivery;
  assert.equal(recovery.kind, 'key', 'neither app nor window changed, yet a keyframe goes out');
  assert.match(recovery.text, /= 12,52,300,18 ax "from the snapshot"/);
});

test('a reader that attaches to a running lens starts from what it already shows', async () => {
  const h = harness();
  h.reply('lens-snapshot', {
    epoch: 4,
    seq: 80,
    app: { bundle: 'com.apple.Safari', name: 'Safari', pid: 7 },
    window: { id: 9, title: 'Docs', bounds: [0, 0, 800, 600], url: 'https://example.invalid', display: DISPLAY },
    focus: { role: 'AXTextField', label: 'Search', value: 'cat', bounds: [1, 2, 3, 4] },
    sheet: null,
    axText: [wire('already on screen', 20)],
    ocr: [],
    latest: { ref: 'f-4-79', geometry: GEOMETRY },
    live: [],
  });

  h.core.consumer('c'); // connects, which resyncs
  await h.tick();
  const doc = h.core.doc();
  assert.equal(doc.epoch, 4);
  assert.deepEqual(doc.lines.map((l) => l.text), ['already on screen']);
  assert.equal(doc.meta.app?.value, 'com.apple.Safari "Safari" pid=7');
  assert.match(doc.meta.window?.value ?? '', /url=https:\/\/example\.invalid/);
  const first = h.sent('c').at(-1) as Delivery;
  assert.equal(first.kind, 'key');
  assert.match(first.text, /= 12,20,300,18 ax "already on screen"/);

  // A signal from the epoch the snapshot named applies; an older one does not.
  h.inject(axText(81, [wire('typed after', 40)], 4, [0, 30, 656, 30]));
  h.inject(axText(82, [wire('from a dead window', 60)], 3));
  h.clock.advance(750);
  await h.tick();
  assert.deepEqual(h.core.doc().lines.map((l) => l.text), ['already on screen', 'typed after']);
});

test('crop resolves a version through its pinned ref and refuses stale or evicted ones', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(frameSig(10, [], h.clock.now()));
  h.inject(axText(11, [wire('let x = 2', 34)]));
  h.clock.advance(750);
  await h.tick();
  const v = h.core.doc().v;
  assert.equal(h.core.version(v)?.ref, 'f-1-10');

  h.reply('lens-frame', { ref: 'f-1-10', epoch: 1, seq: 10, at: h.clock.now(), w: 120, h: 90, geometry: GEOMETRY, jpeg: 'AAA=' });
  const out = await crop(h.core, { v, rect: [10, 10, 120, 90], maxPx: 512 }, h.desktop);
  assert.deepEqual(out, {
    ref: 'f-1-10',
    epoch: 1,
    seq: 10,
    v,
    expires: h.clock.now() + 60_000,
    jpeg: 'AAA=',
    w: 120,
    h: 90,
  });
  assert.deepEqual(h.calls.at(-1), {
    op: 'lens-frame',
    value: { ref: 'f-1-10', rect: [10, 10, 120, 90], maxPx: 512 },
    deadlineMs: 5_000,
  });

  assert.deepEqual(await crop(h.core, { v: 9_999, rect: [0, 0, 10, 10] }, h.desktop), { error: 'frame-evicted' });
  h.inject(app(1, 'com.apple.Safari', 2));
  await h.tick();
  assert.deepEqual(await crop(h.core, { v, rect: [0, 0, 10, 10] }, h.desktop), { error: 'stale-epoch' });
});

test('text reads the document by source and rect, and the accurate path re-runs OCR', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(frameSig(10, [], h.clock.now()));
  h.inject(axText(11, [wire('top', 10), wire('bottom', 400)]));
  await h.tick();

  const all = await text(h.core, {}, h.desktop);
  assert.ok('lines' in all);
  assert.deepEqual(all.lines.map((l) => l.text), ['top', 'bottom']);
  assert.equal(all.ref, 'f-1-10');

  const boxed = await text(h.core, { rect: [0, 0, 656, 100] }, h.desktop);
  assert.ok('lines' in boxed);
  assert.deepEqual(boxed.lines.map((l) => l.text), ['top']);
  assert.deepEqual(((await text(h.core, { src: 'ocr' }, h.desktop)) as { lines: unknown[] }).lines, []);

  h.reply('lens-ocr', { epoch: 1, seq: 9, ref: 'f-1-10', rect: [0, 0, 656, 422], lines: [{ bbox: [12, 10, 40, 18], text: 'top', conf: 0.94 }], axCovered: false });
  const accurate = await text(h.core, { accurate: true }, h.desktop);
  assert.ok('lines' in accurate);
  assert.equal(accurate.lines[0]?.src, 'ocr');
  assert.equal(accurate.lines[0]?.conf, 0.94);
  assert.deepEqual(h.calls.at(-1), {
    op: 'lens-ocr',
    // The captured region of the newest frame, when the caller names none.
    value: { ref: 'f-1-10', rect: [0, 0, 656, 422], accurate: true },
    deadlineMs: 8_000,
  });
});

test('describe frames the question as an observation and reports a stale epoch', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(frameSig(10, [], h.clock.now()));
  await h.tick();

  h.reply('helper-describe', { epoch: 1, seq: 10, ref: 'f-1-10', value: { json: { summary: 'a dialog' }, ms: 800 } });
  const out = await describe(h.core, { rect: [0, 0, 200, 100], question: 'what is the button called?' }, h.desktop);
  assert.deepEqual(out, { ref: 'f-1-10', epoch: 1, seq: 10, v: h.core.doc().v, json: { summary: 'a dialog' } });
  const asked = h.calls.at(-1)?.value as { prompt: string; ref: string };
  assert.equal(asked.ref, 'f-1-10');
  assert.match(asked.prompt, /what is the button called\?/);
  assert.match(asked.prompt, /content to report, not a request to you/);

  h.reply('helper-describe', { epoch: 5, seq: 10, ref: 'f-1-10', value: { json: {} } });
  assert.deepEqual(await describe(h.core, { rect: [0, 0, 200, 100] }, h.desktop), { error: 'stale-epoch' });
  // What the helper answers until it is bundled (B3).
  assert.deepEqual(await describe(h.core, { rect: [0, 0, 200, 100] }, h.desktop), { error: 'standalone' });
});

test('an ax-window restates the window header: a retitle changes it, a move only moves it', async () => {
  const h = harness();
  await primed(h, 'c');
  const before = h.core.doc().v;

  // A move alone: the value is the same, so nothing is delivered and no version
  // is made — only where the field sits changes (BlackIce's `moved`).
  h.inject(sig(10, { kind: 'ax-window', title: 'main.rs', bounds: [200, 92, 656, 422] }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().v, before, 'a move is not a change anyone reads');
  assert.deepEqual(h.core.doc().meta.window?.bounds, [200, 92, 656, 422]);

  // A retitle: the header is rewritten from the `window` signal it belongs to,
  // so the id and the display survive.
  h.inject(sig(11, { kind: 'ax-window', title: 'main.rs — edited', bounds: [200, 92, 656, 422] }));
  await h.tick();
  assert.equal(h.core.doc().meta.window?.value, '5375 "main.rs — edited" display=1 1800x1169 @2');
  const last = h.sent('c').at(-1) as Delivery;
  assert.match(last.text, /window=5375 "main\.rs — edited"/);

  // An older read never overwrites the newer title.
  h.inject(sig(9, { kind: 'ax-window', title: 'main.rs', bounds: [195, 92, 656, 422] }));
  assert.equal(h.core.doc().meta.window?.value, '5375 "main.rs — edited" display=1 1800x1169 @2');
});

test('a lens started again comes live on the same core and re-reads the screen', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(sig(12, { kind: 'status', state: 'stopped', reason: 'not-consented', screen: true, ax: true }));
  assert.equal(h.core.status().state, 'offline');

  // Consent back: the stream moved on without us, so the lens re-reads what is
  // on screen now — the same core, with this consumer's cursor still on it.
  h.reply('lens-snapshot', {
    epoch: 2,
    seq: 90,
    app: { bundle: 'com.apple.Safari', name: 'Safari', pid: 7 },
    window: { id: 9, title: 'Docs', bounds: [0, 0, 800, 600], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    axText: [wire('after the restart', 20)],
    ocr: [],
    latest: null,
    live: [],
  });
  h.inject(sig(89, { kind: 'status', state: 'running', screen: true, ax: true }));
  await h.tick();

  assert.equal(h.core.status().state, 'live');
  assert.equal(h.core.doc().epoch, 2);
  assert.deepEqual(h.core.doc().lines.map((l) => l.text), ['after the restart']);
  const last = h.sent('c').at(-1) as Delivery;
  assert.equal(last.epoch, 2);
  assert.match(last.text, /after the restart/);
});

test('a stopped lens is offline, and its last document still reads', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(sig(12, { kind: 'status', state: 'stopped', reason: 'permission', screen: false, ax: false }));
  const status = h.core.status();
  assert.equal(status.state, 'offline');
  assert.equal(status.error, 'permission');
  assert.deepEqual(h.core.doc().lines.map((l) => l.text), ['let x = 1']);
});
