import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from './fake-clock.ts';
import { LensCore } from '../src/lib/lens/core.ts';
import type { Decider, LensSettings } from '../src/lib/lens/core.ts';
import { crop, describe, nativeState, screenSource, text } from '../src/lib/lens/screen.ts';
import { frameTrouble } from '../src/lib/lens/tools.ts';
import { screenOffline } from '../src/lib/lens/types.ts';
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

function harness(decider?: Decider): Harness {
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
    ...(decider ? { decider } : {}),
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

  assert.deepEqual(
    h.calls.map((c) => c.op),
    ['lens-status', 'lens-snapshot', 'lens-snapshot'],
    'what the lens is doing, then one snapshot on connect and one for the gap'
  );
  assert.equal(h.calls[1]?.deadlineMs, 2_000);
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

test('a window that shrinks drops the lines outside it, and a move keeps them', async () => {
  const h = harness();
  await primed(h, 'c');
  // Widened to the full display, then the wide layout: the sidebar's line and
  // two from a pane past x=656.
  h.inject(sig(9, { kind: 'ax-window', title: 'main.rs', bounds: [0, 39, 1800, 422] }));
  h.inject(ocrSig(10, [wire('let x = 1', 34), { bbox: [1052, 20, 108, 13], text: 'Background tasks' }, { bbox: [1436, 20, 74, 11], text: 'New tab +' }], false, 1, [0, 0, 1800, 422]));
  h.clock.advance(750);
  await h.tick();
  assert.equal(ackLast(h, 'c').kind, 'delta');
  assert.equal(h.core.doc().lines.length, 3);

  // A move alone changes nothing about which lines stand.
  h.inject(sig(11, { kind: 'ax-window', title: 'main.rs', bounds: [200, 92, 1800, 422] }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().lines.length, 3, 'a move keeps every line');

  // Tiled to the left half: nothing the stream captures is past x=656 now,
  // and no read will ever claim those lines, so the shrink removes them.
  h.inject(sig(12, { kind: 'ax-window', title: 'main.rs', bounds: [-1, 40, 656, 422] }));
  h.clock.advance(750);
  await h.tick();
  const last = ackLast(h, 'c');
  assert.equal(last.kind, 'delta');
  assert.match(last.text, /-.*Background tasks/, 'the delta removes the pane line');
  assert.match(last.text, /-.*New tab \+/);
  assert.deepEqual(
    h.core.doc().lines.map((line) => line.text),
    ['let x = 1'],
    'only the line inside the window stands'
  );
  assert.deepEqual(h.core.doc().meta.window?.bounds, [-1, 40, 656, 422]);

  // A read that straddled the resize: its frame was captured at the old size,
  // so its lines and its region are in the old window's points. What it found
  // past the new width is not adopted; what it found inside is.
  h.inject(ocrSig(13, [wire('let x = 1', 34), { bbox: [12, 60, 120, 14], text: 'let y = 2' }, { bbox: [1052, 20, 108, 13], text: 'Background tasks' }], false, 1, [0, 0, 1800, 422]));
  h.clock.advance(750);
  await h.tick();
  assert.deepEqual(
    h.core.doc().lines.map((line) => line.text),
    ['let x = 1', 'let y = 2'],
    'a straddling read adopts only what the window holds now'
  );
});

test('an ax-window move moves the field, and a ticking title delivers nothing on its own', async () => {
  const h = harness();
  await primed(h, 'c');
  const before = h.core.doc().v;
  const sent = h.sent('c').length;

  // A move alone: the value is the same, so nothing is delivered and no version
  // is made — only where the field sits changes (BlackIce's `moved`).
  h.inject(sig(10, { kind: 'ax-window', title: 'main.rs', bounds: [200, 92, 656, 422] }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().v, before, 'a move is not a change anyone reads');
  assert.deepEqual(h.core.doc().meta.window?.bounds, [200, 92, 656, 422]);

  // A title that ticks — an unread count, a call timer — is a settled delta,
  // which a consumer with no watch never receives. It must never keyframe.
  for (let n = 1; n <= 5; n++) {
    h.inject(sig(10 + n, { kind: 'ax-window', title: `(${n}) Inbox`, bounds: [200, 92, 656, 422] }));
    h.clock.advance(750);
    await h.tick();
  }
  assert.equal(h.sent('c').length, sent, 'five retitles, no deliveries');
  assert.equal(h.core.doc().meta.title?.value, '"(5) Inbox"', 'the head shows the new title');
  assert.equal(
    h.core.doc().meta.window?.value,
    '5375 "main.rs" display=1 1800x1169 @2',
    'the window field is still the window signal\'s own'
  );

  // An older read never overwrites the newer title.
  h.inject(sig(9, { kind: 'ax-window', title: 'main.rs', bounds: [195, 92, 656, 422] }));
  assert.equal(h.core.doc().meta.title?.value, '"(5) Inbox"');

  // A real window switch is still a keyframe, and takes the title with it.
  h.inject(windowSig(20, 'lib.rs'));
  await h.tick();
  assert.equal(h.sent('c').at(-1)?.kind, 'key');
  assert.equal(h.core.doc().meta.title, undefined);
  assert.equal(h.core.doc().meta.window?.value, '5375 "lib.rs" display=1 1800x1169 @2');
});

test('a snapshot that lands after the window changed is discarded whole', async () => {
  const h = harness();
  h.reply('lens-snapshot', {
    epoch: 4,
    seq: 80,
    app: { bundle: 'com.apple.Safari', name: 'Safari', pid: 7 },
    window: { id: 9, title: 'Docs', bounds: [0, 0, 800, 600], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    axText: [wire('the window that was', 20)],
    ocr: [],
    latest: { ref: 'f-4-79', geometry: GEOMETRY },
    live: [[0, 0, 10, 10]],
  });

  // The reply is in flight when the user switches windows: it describes a window
  // nobody is looking at, so none of it lands — not its lines, not its live
  // rectangles, and not the frame a crop would otherwise read.
  h.core.consumer('c');
  h.inject(app(1, 'com.apple.Mail', 5));
  h.inject(axText(2, [wire('the window that is', 10)], 5));
  await h.tick();

  const doc = h.core.doc();
  assert.equal(doc.epoch, 5);
  assert.deepEqual(doc.lines.map((l) => l.text), ['the window that is']);
  assert.deepEqual(doc.live, []);
  assert.equal(doc.ref, null);
  // Nor did its frame become the newest one: a crop never asks for `f-4-79`
  // (`latest` is process state — one screen per process — so this is asserted
  // on what was asked for, not on the read failing).
  await crop(h.core, { rect: [0, 0, 10, 10] }, h.desktop);
  assert.notEqual((h.calls.at(-1)?.value as { ref?: string } | undefined)?.ref, 'f-4-79');
});

test('a recovery keeps the window header consistent, so the next retitle is still a delta', async () => {
  const h = harness();
  await primed(h, 'c');
  h.inject(sig(10, { kind: 'ax-window', title: '(1) Inbox', bounds: [195, 92, 656, 422] }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.core.doc().meta.title?.value, '"(1) Inbox"');

  // Rust reports the CURRENT title inside `window`, not the one the window was
  // switched to: the snapshot is what the header restates from afterwards.
  h.reply('lens-snapshot', {
    epoch: 1,
    seq: 50,
    app: { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 123 },
    window: { id: 5375, title: '(1) Inbox', bounds: [195, 92, 656, 422], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    axText: [wire('let x = 1', 34)],
    ocr: [],
    latest: null,
    live: [],
  });
  h.inject(sig(51, { kind: 'gap', from: 11, to: 50 }));
  await h.tick();
  assert.equal(h.core.doc().meta.window?.value, '5375 "(1) Inbox" display=1 1800x1169 @2');
  assert.equal(h.core.doc().meta.title, undefined, 'the recovered header states the title once');
  const recovered = h.sent('c').at(-1) as Delivery;
  h.core.look('c', { ack: recovered.delivery });

  // The tick after the recovery: a title change, not a keyframe.
  h.inject(sig(60, { kind: 'ax-window', title: '(2) Inbox', bounds: [195, 92, 656, 422] }));
  h.clock.advance(750);
  await h.tick();
  assert.equal(h.sent('c').at(-1)?.delivery, recovered.delivery, 'a ticking title still delivers nothing');
  assert.equal(h.core.doc().meta.window?.value, '5375 "(1) Inbox" display=1 1800x1169 @2');
  assert.equal(h.core.doc().meta.title?.value, '"(2) Inbox"');
});

test('a stale snapshot never becomes the window the next retitle restates', async () => {
  const h = harness();
  await primed(h, 'c');
  // The snapshot describes epoch 1; by the time it lands the user has switched
  // windows twice and epoch 5 is what is on screen.
  h.reply('lens-snapshot', {
    epoch: 1,
    seq: 50,
    app: { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 123 },
    window: { id: 5375, title: 'main.rs', bounds: [195, 92, 656, 422], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    axText: [wire('let x = 1', 34)],
    ocr: [],
    latest: null,
    live: [],
  });
  h.inject(sig(51, { kind: 'gap', from: 11, to: 50 }));
  h.inject(app(1, 'com.apple.Mail', 5));
  h.inject(windowSig(2, 'Inbox — Mail', 5));
  await h.tick();
  assert.equal(h.core.doc().epoch, 5);

  // The retitle restates the window it belongs to, never the one the stale
  // snapshot carried.
  h.inject(sig(10, { kind: 'ax-window', title: '(1) Inbox — Mail', bounds: [195, 92, 656, 422] }, 5));
  h.clock.advance(750);
  await h.tick();
  assert.match(h.core.doc().meta.window?.value ?? '', /"Inbox — Mail"/);
  assert.equal(h.core.doc().meta.title?.value, '"(1) Inbox — Mail"');
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
  // The native word, in the words the person needs (screen.ts `screenOffline`).
  assert.equal(status.error, 'macOS has not granted Screen Recording to Rimeward');
  assert.deepEqual(h.core.doc().lines.map((l) => l.text), ['let x = 1']);
});

test('the native reasons are one vocabulary, read off the reply the app already sends', () => {
  assert.equal(screenOffline('not-consented'), 'the Screen lens is turned off for this Mac');
  assert.equal(screenOffline('permission'), 'macOS has not granted Screen Recording to Rimeward');
  assert.equal(screenOffline('unsupported'), 'this computer’s lens cannot run here');
  // A runtime with no lens to ask at all answers the same way.
  assert.equal(screenOffline('unavailable'), 'this computer’s lens cannot run here');
  // The capture stream went down (lens/capture.rs), or its display changed.
  assert.match(screenOffline('stream'), /^the screen lens lost its capture of this Mac’s screen and is bringing it back on its own: ask again/);
  assert.equal(screenOffline('display-changed'), screenOffline('stream'));
  assert.equal(screenOffline(''), 'the screen lens is not running on this computer');
  // A macOS error string `build_capture` handed to `stop()`: its own words, but
  // never bare — every reason the user sees is a sentence.
  assert.equal(
    screenOffline('SCStreamErrorDomain error -3801'),
    'the screen lens stopped on this computer (SCStreamErrorDomain error -3801)'
  );

  // A running lens is not offline at all.
  assert.equal(nativeState({ state: 'running', permissions: { screen: true, ax: true }, consented: true })?.offline, null);
  // macOS answers `lens-status` with no `reason`, so consent and the Screen
  // Recording grant — both in that same reply — are what name it.
  assert.equal(
    nativeState({ state: 'stopped', permissions: { screen: true, ax: true }, consented: false })?.offline,
    'the Screen lens is turned off for this Mac'
  );
  assert.equal(
    nativeState({ state: 'stopped', permissions: { screen: false, ax: false }, consented: true })?.offline,
    'macOS has not granted Screen Recording to Rimeward'
  );
  // The off-macOS stub states its own reason, and a read that failed says nothing.
  assert.equal(nativeState({ state: 'stopped', reason: 'unsupported' })?.offline, 'this computer’s lens cannot run here');
  assert.equal(nativeState(null), null);
});

test('a lens that was never running says so, and consent later brings the same core live', async () => {
  const h = harness();
  // Nothing ever ran, so no `status stopped` transition is coming: the source
  // asks what the lens is doing when it connects, or "off" reads as "live and
  // empty" — an app, a window and no text at all.
  h.reply('lens-status', { state: 'stopped', permissions: { screen: true, ax: true }, consented: false });
  h.core.consumer('c');
  await h.tick();

  const status = h.core.status();
  assert.equal(status.state, 'offline');
  assert.equal(status.error, 'the Screen lens is turned off for this Mac');
  assert.deepEqual(h.calls.map((c) => c.op), ['lens-status'], 'nothing is read off a lens that is not reading');

  // Consent given later: the same core, the same consumer, a fresh read of what
  // is on screen now — even though this source never saw a stop.
  h.reply('lens-snapshot', {
    epoch: 2,
    seq: 90,
    app: { bundle: 'com.apple.Safari', name: 'Safari', pid: 7 },
    window: { id: 9, title: 'Docs', bounds: [0, 0, 800, 600], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    axText: [wire('after consent', 20)],
    ocr: [],
    latest: null,
    live: [],
  });
  h.inject(sig(91, { kind: 'status', state: 'running', screen: true, ax: true }));
  await h.tick();

  assert.equal(h.core.status().state, 'live');
  assert.deepEqual(h.core.doc().lines.map((l) => l.text), ['after consent']);
  assert.match((h.sent('c').at(-1) as Delivery).text, /after consent/);
});

test('a window over the target is a header field, not text: covered delivers, clears, and survives a gap', async () => {
  const h = harness();
  await primed(h, 'c');
  const before = h.sent('c').length;

  // The delivery that started this: the app, the window and the focus were
  // Claude's, every recognized line was a browser's, because the capture is
  // scoped to the target's RECTANGLE and a maximised browser was drawn over it.
  h.inject(
    sig(10, {
      kind: 'covered',
      over: { by: 'Google Chrome', pid: 501, bounds: [0, 0, 1800, 1130] },
    })
  );
  assert.equal(h.core.doc().meta.covered?.value, '"Google Chrome" pid=501');
  assert.deepEqual(h.core.doc().meta.covered?.bounds, [0, 0, 1800, 1130]);
  assert.equal(h.sent('c').length, before + 1, 'covered does not wait for the settle window');
  const key = ackLast(h, 'c');
  assert.equal(key.kind, 'key');
  assert.match(key.text, /covered="Google Chrome" pid=501 bounds=0,0,1800,1130/);

  // The target window is not on screen at all: the same failure, with no
  // process to name and nothing to place.
  h.inject(sig(11, { kind: 'covered', over: { by: 'not on screen', pid: 0 } }));
  assert.equal(h.core.doc().meta.covered?.value, '"not on screen"');
  assert.equal(h.core.doc().meta.covered?.bounds, undefined);

  // Clear: an explicit null drops the field.
  h.inject(sig(12, { kind: 'covered', over: null }));
  assert.equal(h.core.doc().meta.covered, undefined);
  assert.equal(ackLast(h, 'c').kind, 'key', 'and says so at once');

  // A gap recovers it from the snapshot, where it rides beside focus and sheet.
  h.reply('lens-snapshot', {
    epoch: 1,
    seq: 50,
    app: { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 123 },
    window: { id: 5375, title: 'main.rs', bounds: [195, 92, 656, 422], url: null, display: DISPLAY },
    focus: null,
    sheet: null,
    covered: { by: 'Google Chrome', pid: 501, bounds: [0, 0, 1800, 1130] },
    axText: [wire('let x = 1', 34)],
    ocr: [],
    latest: null,
    live: [],
  });
  h.inject(sig(51, { kind: 'gap', from: 13, to: 50 }));
  await h.tick();
  assert.equal(h.core.doc().meta.covered?.value, '"Google Chrome" pid=501');

  // An app switch is a new epoch, and a new target is not covered until a
  // frame of it says so.
  h.inject(app(1, 'com.google.Chrome', 2));
  await h.tick();
  assert.equal(h.core.doc().meta.covered, undefined);
});

test('a covered window contributes no visual candidate and no describe round', async () => {
  const asked: { ref: string; rect: Rect }[] = [];
  const h = harness({
    describe: async (q) => {
      asked.push({ ref: q.ref, rect: q.rect });
      return { json: { text: 'a Microsoft account picker' } };
    },
  });
  await primed(h, 'c');
  // `visual` alone: a watch this machine can actually run with a describe and
  // nothing else (gate.ts `watchMode`).
  await h.core.watch('c', { add: [{ visual: true, triage: false }] });
  const dirty = { bbox: [0, 200, 400, 300] as Rect, d: 0.42 };

  // Uncovered, the repaint is the target's own: a visual candidate, a describe
  // round, and the description lands as an interpreted region.
  h.inject(frameSig(10, [dirty], h.clock.now()));
  assert.deepEqual(h.core.doc().dirty, [dirty]);
  h.clock.advance(750);
  await h.tick();
  assert.equal(asked.length, 1, 'the target got its describe round');
  assert.match((h.sent('c').at(-1) as Delivery).text, /~ 0,200,400,300/);
  ackLast(h, 'c');

  // Covered: the same rectangles are the COVERING window repainting. None of
  // it may reach the document — a visual watch firing here would send another
  // window's pixels to the model and file the answer under this window's name.
  h.inject(sig(11, { kind: 'covered', over: { by: 'Google Chrome', pid: 501, id: 902, bounds: [0, 0, 1800, 1130] } }));
  ackLast(h, 'c'); // the cover keyframes; start the next round from a clean cursor
  const settled = h.sent('c').length;
  h.inject(frameSig(12, [{ bbox: [0, 200, 400, 300] as Rect, d: 0.9 }], h.clock.now()));
  assert.deepEqual(h.core.doc().dirty, [], 'the covering window\'s repaints are not this document\'s');
  h.clock.advance(750);
  await h.tick();
  assert.equal(asked.length, 1, 'no describe round over a covered window');
  assert.equal(h.sent('c').length, settled, 'and nothing visual to deliver');

  // The cover leaves: the target's own repaints count again. A fresh
  // rectangle, because the same one twice inside the frame history is churn
  // and the gate keeps a live region out of the candidates either way.
  h.inject(sig(13, { kind: 'covered', over: null }));
  ackLast(h, 'c'); // clearing the field keyframes too
  h.inject(frameSig(14, [{ bbox: [600, 200, 400, 300] as Rect, d: 0.9 }], h.clock.now()));
  assert.equal(h.core.doc().dirty.length, 1);
  h.clock.advance(750);
  await h.tick();
  assert.equal(asked.length, 2, 'reading resumes with the cover gone');
});

test('a refused rect is bounded by the frame it names, not by the window header', async () => {
  const h = harness();
  await primed(h, 'c');
  // The header says the window is 656x422. The frame holds less than that: 270
  // of those points are off the right edge of the display, so the app's bounds
  // check — which maps the rect through THIS frame's geometry — stops at 386.
  h.inject(
    sig(10, {
      kind: 'frame',
      ref: 'f-1-10',
      w: 772,
      h: 844,
      ratio: 0.1,
      dirty: [],
      geometry: { ...GEOMETRY, captured: [0, 0, 386, 422] },
    })
  );
  const refused = frameTrouble('lens_crop', h.core, 'bad-rect', [400, 10, 200, 30]);
  assert.match(refused, /400,10,200,30/, 'the rect it refused');
  assert.match(refused, /0,0,386,422/, 'what that frame actually holds');
  assert.doesNotMatch(refused, /656/, 'not the window header, which is bigger than the capture');
  assert.match(refused, /window points/, 'the space a rect is in');
});

test('ready() waits for the screen lens status read, so a look never answers a lens that is off', async () => {
  const h = harness();
  let release: () => void = () => {};
  const held = new Promise<unknown>((resolve) => {
    release = (): void => resolve({ state: 'stopped', permissions: { screen: true, ax: true }, consented: false });
  });
  h.reply('lens-status', held);

  let ready: boolean | null = null;
  const settling = h.core.ready(10_000).then((value) => {
    ready = value;
  });
  await h.tick();
  assert.equal(ready, null, 'the connect has not settled while the status read is in flight');

  release();
  await settling;
  assert.equal(ready, true);
  // The point of waiting: what a read sees first is the lens being off, not a
  // live, empty document.
  assert.equal(h.core.status().state, 'offline');
  assert.equal(h.core.status().error, screenOffline('not-consented'));
});
