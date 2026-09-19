import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffDocs } from '../src/lib/lens/diff.ts';
import {
  calibration,
  candidates,
  describeTarget,
  evaluate,
  gateDefaults,
  liveRegions,
  watchMode,
} from '../src/lib/lens/gate.ts';
import type { GateDeps, TriageQuery } from '../src/lib/lens/gate.ts';
import type { Consumer, Diff, Dirty, Doc, Line, Rect, Watch, WatchSpec } from '../src/lib/lens/types.ts';

// Documents and diffs are built by hand: the gate must never need doc.ts.

function line(id: string, bbox: Rect, text: string): Line {
  return { id, bbox, text, conf: 1, src: 'ax', key: text.trim().replace(/\s+/g, ' '), seq: 10 };
}

function doc(over: Partial<Doc> = {}): Doc {
  return {
    v: 12,
    at: 1_000,
    epoch: 7,
    incomplete: false,
    // The screen source's own header strings; `app` is what triage is told.
    meta: {
      app: { value: 'Xcode (com.apple.dt.Xcode)' },
      window: { value: '5375 "main.rs"', bounds: [195, 92, 656, 422] },
      focus: { value: 'editor let x = 1', bounds: [0, 32, 600, 384] },
    },
    lines: [],
    regions: [],
    dirty: [],
    live: [],
    ref: 'f-7-298',
    ...over,
  };
}

function emptyDiff(over: Partial<Diff> = {}): Diff {
  return { from: 11, to: 12, epoch: false, metaChanged: [], added: [], removed: [], moved: [], visual: [], ...over };
}

function watch(over: Partial<Watch> & { spec: WatchSpec }): Watch {
  return { id: 'w1', mode: 'unavailable', createdAt: 0, ...over };
}

function consumer(over: Partial<Consumer> = {}): Consumer {
  return {
    id: 'c1',
    kind: 'conv',
    cursor: 11,
    delivered: null,
    baseline: { v: 11, complete: true },
    deltas: 0,
    minIntervalMs: 0,
    lastSentAt: null,
    seenAt: null,
    nextDelivery: 0,
    watches: [],
    ...over,
  };
}

const deps = (over: Partial<GateDeps> = {}): GateDeps => gateDefaults(over);

const frame = (at: number, ...dirty: Dirty[]): { at: number; dirty: Dirty[] } => ({ at, dirty });
const spot = (d: number, bbox: Rect = [600, 0, 200, 100]): Dirty => ({ bbox, d });

test('a rectangle is live after four consecutive frames and not after three', () => {
  const d = deps();
  const three = [frame(0, spot(0.3)), frame(500, spot(0.3)), frame(1_000, spot(0.3))];
  assert.deepEqual(liveRegions(three, d, 1_000), []);

  const four = [...three, frame(1_500, spot(0.3))];
  assert.deepEqual(liveRegions(four, d, 1_500), [[600, 0, 200, 100]]);
  // The window is measured from now, not from the last frame: once the frames
  // stop, the region stops being live.
  assert.deepEqual(liveRegions(four, d, 3_000), [[600, 0, 200, 100]], 'four frames still inside the window');
  assert.deepEqual(liveRegions(four, d, 3_501), [], 'the oldest frame fell out, three remain');

  // Slightly different rectangles still match: ≥ 50 % IoU is the same region.
  const drifting = [
    frame(0, spot(0.3, [600, 0, 200, 100])),
    frame(500, spot(0.3, [604, 2, 200, 100])),
    frame(1_000, spot(0.3, [608, 0, 200, 100])),
    frame(1_500, spot(0.3, [610, 4, 200, 100])),
  ];
  assert.equal(liveRegions(drifting, d, 1_500).length, 1);
});

test('a quiet frame, a faint frame and an old frame all reset the chain', () => {
  const d = deps();
  const quiet = [frame(0, spot(0.3)), frame(500, spot(0.3)), frame(1_000), frame(1_500, spot(0.3)), frame(2_000, spot(0.3))];
  assert.deepEqual(liveRegions(quiet, d, 2_000), [], 'one frame without the region breaks the run');

  const faint = [frame(0, spot(0.3)), frame(500, spot(0.3)), frame(1_000, spot(0.01)), frame(1_500, spot(0.3))];
  assert.deepEqual(liveRegions(faint, d, 1_500), [], 'below liveThreshold is not a frame of movement');

  // 3 s apart: the first frame is outside the window, so only three remain.
  const stale = [frame(0, spot(0.3)), frame(3_200, spot(0.3)), frame(3_600, spot(0.3)), frame(4_000, spot(0.3))];
  assert.deepEqual(liveRegions(stale, d, 4_000), []);
});

test('candidates drop live regions, honour min_lines and keep a meta change', () => {
  const d = deps({ minLines: 2 });
  const live: Rect[] = [[600, 0, 200, 100]];
  const inside = line('t1', [620, 20, 100, 16], 'frame 41');
  const outside = line('t2', [10, 200, 100, 16], 'let y = 2');

  const one = candidates(emptyDiff({ added: [inside, outside] }), live, d);
  assert.deepEqual(one.text.map((l) => l.id), ['t2'], 'a line inside a live region is not a change');
  assert.equal(one.rule, false, 'one changed line is below min_lines');

  const two = candidates(emptyDiff({ added: [outside], removed: [line('t3', [10, 220, 100, 16], 'old')] }), live, d);
  assert.equal(two.rule, true);
  assert.equal(
    candidates(emptyDiff({ metaChanged: ['focus'] }), live, d).rule,
    true,
    'a meta change is a rule hit on its own'
  );
  assert.equal(
    candidates(emptyDiff({ metaChanged: ['window', 'app'] }), live, d).rule,
    false,
    'a key outside ruleKeys forces a keyframe, it does not make a delivery'
  );
  assert.deepEqual(
    candidates(emptyDiff({ metaChanged: ['window'] }), live, { ...d, ruleKeys: ['focus', 'window'] }).rule,
    true,
    'ruleKeys is what decides'
  );
});

test('a visual candidate needs the threshold, open ground and no text change inside it', () => {
  const d = deps();
  const before = doc({ v: 11, lines: [line('t1', [10, 10, 100, 16], 'one')], dirty: [] });
  const after = doc({
    v: 12,
    lines: [line('t1', [10, 10, 100, 16], 'one'), line('t2', [10, 40, 100, 16], 'two')],
    dirty: [
      { bbox: [0, 30, 200, 40], d: 0.4 }, // contains the new line: explained
      { bbox: [400, 300, 120, 90], d: 0.4 }, // open ground
      { bbox: [400, 400, 120, 90], d: 0.05 }, // below visualThreshold
      { bbox: [600, 0, 200, 100], d: 0.9 }, // live
    ],
  });
  const cand = candidates(diffDocs(before, after), [[600, 0, 200, 100]], d);
  assert.deepEqual(cand.visual.map((v) => v.bbox), [[400, 300, 120, 90]]);
});

test('watchMode reports what this machine can actually do', () => {
  const all = { embed: true, triage: true, describe: true, cloud: true };
  const none = { embed: false, triage: false, describe: false, cloud: false };
  const table: [WatchSpec, typeof all, string][] = [
    [{ for: 'the build failed', visual: false, triage: true }, all, 'for'],
    [{ for: 'the build failed', visual: false, triage: true }, { ...none, triage: true }, 'triage-only'],
    [{ for: 'the build failed', visual: false, triage: true }, none, 'unavailable'],
    [{ for: 'the build failed', visual: false, triage: false }, { ...none, triage: true }, 'unavailable'],
    [{ regex: 'error: ', visual: false, triage: false }, none, 'regex'],
    [{ filter: { app: 'Xcode' }, visual: false, triage: false }, none, 'filter'],
    [{ visual: true, triage: false }, none, 'visual'],
    [{ rect: [0, 0, 10, 10], visual: false, triage: false }, none, 'rect'],
    [{ visual: false, triage: true }, { ...none, cloud: true }, 'triage-only'],
    [{ visual: false, triage: true }, none, 'unavailable'],
    [{ visual: false, triage: false }, all, 'unavailable'],
  ];
  for (const [spec, caps, want] of table) {
    assert.equal(watchMode(spec, caps), want, JSON.stringify(spec));
  }
});

test('a consumer with no watches delivers on any rule hit and nothing else', async () => {
  const d = deps();
  const hit = await evaluate(consumer(), candidates(emptyDiff({ added: [line('t1', [0, 0, 10, 10], 'x')] }), [], d), doc(), d);
  assert.deepEqual(hit, { deliver: true, reason: 'rule', watches: [] });

  const miss = await evaluate(consumer(), candidates(emptyDiff(), [], d), doc(), d);
  assert.deepEqual(miss, { deliver: false, reason: 'none', watches: [] });
});

test('a rect watch only fires on changes inside its rectangle', async () => {
  const d = deps();
  const spec: WatchSpec = { rect: [0, 0, 300, 300], visual: false, triage: false };
  const c = consumer({ watches: [watch({ spec, mode: 'rect' })] });

  const outside = candidates(emptyDiff({ added: [line('t1', [400, 400, 100, 16], 'far away')] }), [], d);
  const first = await evaluate(c, outside, doc(), d);
  assert.equal(first.deliver, false);
  assert.deepEqual(first.watches, [{ id: 'w1', hit: false, mode: 'rect' }]);

  const inside = candidates(emptyDiff({ added: [line('t2', [10, 10, 100, 16], 'right here')] }), [], d);
  assert.equal((await evaluate(c, inside, doc(), d)).deliver, true);
});

test('regex and filter run over the changed lines', async () => {
  const d = deps();
  const cand = candidates(emptyDiff({ added: [line('t1', [0, 0, 200, 16], 'error: cannot find value')] }), [], d);
  const regex = consumer({ watches: [watch({ spec: { regex: 'error: ', visual: false, triage: false }, mode: 'regex' })] });
  assert.equal((await evaluate(regex, cand, doc(), d)).deliver, true);

  const noMatch = consumer({ watches: [watch({ spec: { regex: '^warning', visual: false, triage: false }, mode: 'regex' })] });
  assert.equal((await evaluate(noMatch, cand, doc(), d)).deliver, false);

  const filter = consumer({
    watches: [watch({ spec: { filter: { text: 'cannot find', app: 'Xcode' }, visual: false, triage: false }, mode: 'filter' })],
  });
  assert.equal((await evaluate(filter, cand, doc(), d)).deliver, true);

  const wrongApp = consumer({
    watches: [watch({ spec: { filter: { text: 'cannot find', app: 'Safari' }, visual: false, triage: false }, mode: 'filter' })],
  });
  assert.equal((await evaluate(wrongApp, cand, doc(), d)).deliver, false, 'every field of a filter must match');

  const noSuchKey = consumer({
    watches: [watch({ spec: { filter: { tab: 'anything' }, visual: false, triage: false }, mode: 'filter' })],
  });
  assert.equal((await evaluate(noSuchKey, cand, doc(), d)).deliver, false, 'a field the source does not publish never matches');
});

test('a rect watch sees a meta change only where the field sits', async () => {
  const d = deps();
  const cand = candidates(emptyDiff({ metaChanged: ['focus'] }), [], d);
  const at = (rect: Rect): Consumer =>
    consumer({ watches: [watch({ spec: { rect, visual: false, triage: false }, mode: 'rect' })] });

  // The document's focus field is bounded 0,32,600,384.
  assert.equal((await evaluate(at([0, 0, 300, 300]), cand, doc(), d)).deliver, true);
  assert.equal((await evaluate(at([800, 800, 100, 100]), cand, doc(), d)).deliver, false);

  // A field the source could not place counts inside EVERY rectangle: dropping
  // it would silently lose the one signal that says where the user is working.
  const unplaced = doc({ meta: { focus: { value: 'editor let x = 1' } } });
  assert.equal((await evaluate(at([0, 0, 300, 300]), cand, unplaced, d)).deliver, true);
  assert.equal((await evaluate(at([800, 800, 100, 100]), cand, unplaced, d)).deliver, true);
  assert.equal(
    (await evaluate(consumer({ watches: [watch({ spec: { regex: 'let x', visual: false, triage: false }, mode: 'regex' })] }), cand, unplaced, d)).deliver,
    true,
    'a watch with no rect still reads it'
  );

  // A LINE without geometry stays outside every rect: a rect watch is a
  // question about a place, and the line cannot answer it.
  const placeless = candidates(emptyDiff({ added: [{ id: 'l1', text: 'row', src: 'pty', key: 'row', seq: 3 }] }), [], d);
  assert.equal((await evaluate(at([0, 0, 300, 300]), placeless, doc({ meta: {} }), d)).deliver, false);
});

test('the gate reads header values whole, however the render cuts them', async () => {
  const d = deps();
  const long = doc({ meta: { focus: { value: `${'x'.repeat(300)} error: cannot find value` } } });
  const cand = candidates(emptyDiff({ metaChanged: ['focus'] }), [], d);
  const c = consumer({ watches: [watch({ spec: { regex: 'cannot find', visual: false, triage: false }, mode: 'regex' })] });
  assert.equal((await evaluate(c, cand, long, d)).deliver, true, 'past the 120-char render cut');

  const filter = consumer({
    watches: [watch({ spec: { filter: { focus: 'cannot find' }, visual: false, triage: false }, mode: 'filter' })],
  });
  assert.equal((await evaluate(filter, cand, long, d)).deliver, true, 'and a filter reads the same raw value');
});

test('a `for` watch passes on max cosine against its own vector', async () => {
  const vectors: Record<string, number[]> = {
    'Build succeeded in 4.2s': [1, 0, 0],
    'Indexing | Processing files': [0, 1, 0],
  };
  const d = deps({ embed: async (texts) => texts.map((t) => vectors[t] ?? [0, 0, 1]) });
  const spec: WatchSpec = { for: 'the compile finished', visual: false, triage: false };
  const c = consumer({ watches: [watch({ spec, vector: [0.98, 0.2, 0], mode: 'for' })] });

  const near = candidates(emptyDiff({ added: [line('t1', [0, 0, 200, 16], 'Build succeeded in 4.2s')] }), [], d);
  assert.equal((await evaluate(c, near, doc(), d)).deliver, true, `cosine clears ${calibration().forThreshold}`);

  const far = candidates(emptyDiff({ added: [line('t2', [0, 0, 200, 16], 'Indexing | Processing files')] }), [], d);
  assert.equal((await evaluate(c, far, doc(), d)).deliver, false);

  // No vector and no triage: nothing left that can answer the question.
  const blind = consumer({ watches: [watch({ spec, mode: 'for' })] });
  const report = await evaluate(blind, near, doc(), d);
  assert.deepEqual(report.watches, [{ id: 'w1', hit: false, mode: 'unavailable', evaluation: 'unavailable' }]);
  assert.equal(report.deliver, false);
});

test('triage decides a `for` watch that asks for it, and the cloud answers a rate-limited helper', async () => {
  const asked: TriageQuery[] = [];
  const spec: WatchSpec = { for: 'a modal dialog appeared', visual: false, triage: true };
  const c = () => consumer({ watches: [watch({ spec, vector: [1, 0], mode: 'for' })] });
  const cand = (d: GateDeps) =>
    candidates(emptyDiff({ added: [line('t1', [0, 0, 200, 16], 'Unsaved changes')] }), [], d);

  const yes = deps({
    embed: async (t) => t.map(() => [1, 0]),
    triage: async (q) => {
      asked.push(q);
      return { yes: true };
    },
  });
  assert.equal((await evaluate(c(), cand(yes), doc(), yes)).deliver, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.watch, 'a modal dialog appeared');
  assert.equal(asked[0]?.app, 'Xcode (com.apple.dt.Xcode)');
  assert.match(asked[0]?.diff ?? '', /^\+ 0,0,200,16 "Unsaved changes"$/);

  const no = deps({ embed: async (t) => t.map(() => [1, 0]), triage: async () => ({ yes: false }) });
  assert.equal((await evaluate(c(), cand(no), doc(), no)).deliver, false);

  let cloudCalls = 0;
  const limited = deps({
    embed: async (t) => t.map(() => [1, 0]),
    triage: async () => ({ error: 'rate-limited' }),
    cloudTriage: async () => {
      cloudCalls += 1;
      return { yes: true };
    },
  });
  assert.equal((await evaluate(c(), cand(limited), doc(), limited)).deliver, true);
  assert.equal(cloudCalls, 1);

  // Triage cannot answer and there is no cloud: the cosine already judged the
  // text, so the watch goes out on that alone and says so.
  const down = deps({ embed: async (t) => t.map(() => [1, 0]), triage: async () => ({ error: 'down' }) });
  const report = await evaluate(c(), cand(down), doc(), down);
  assert.deepEqual(report.watches, [{ id: 'w1', hit: true, mode: 'for', evaluation: 'weak' }]);
  assert.equal(report.deliver, true);

  // A regex asked to triage has no such fallback: the verdict is missing.
  const regex = consumer({ watches: [watch({ spec: { regex: 'unsaved', visual: false, triage: true }, mode: 'regex' })] });
  const missing = await evaluate(regex, cand(down), doc(), down);
  assert.deepEqual(missing.watches, [{ id: 'w1', hit: false, mode: 'regex', evaluation: 'unavailable' }]);

  // Embeddings gone mid-flight: the prefilter is bypassed and only triage may
  // say yes, so a failed triage is unavailable, never weak.
  const blind = deps({ embed: async () => null, triage: async () => ({ error: 'down' }) });
  const bypassed = await evaluate(c(), cand(blind), doc(), blind);
  assert.deepEqual(bypassed.watches, [{ id: 'w1', hit: false, mode: 'for', evaluation: 'unavailable' }]);
});

test('a `for` watch always ends in triage when triage can answer, whatever the spec says', async () => {
  let asked = 0;
  const d = deps({
    embed: async (t) => t.map(() => [1, 0]),
    triage: async () => {
      asked += 1;
      return { yes: false };
    },
  });
  const spec: WatchSpec = { for: 'a modal dialog appeared', visual: false, triage: false };
  const c = consumer({ watches: [watch({ spec, vector: [1, 0], mode: 'for' })] });
  const cand = candidates(emptyDiff({ added: [line('t1', [0, 0, 200, 16], 'Unsaved changes')] }), [], d);
  const report = await evaluate(c, cand, doc(), d);
  assert.equal(asked, 1, 'the cosine passed it on to triage');
  assert.deepEqual(report.watches, [{ id: 'w1', hit: false, mode: 'for' }]);
});

test('describeTarget names the largest visual candidate any watch but a plain rect watch needs', () => {
  const d = deps();
  const small: Dirty = { bbox: [10, 10, 50, 20], d: 0.3 };
  const large: Dirty = { bbox: [400, 300, 120, 90], d: 0.4 };
  const cand = candidates(emptyDiff({ visual: [small, large] }), [], d);
  const of = (spec: WatchSpec, mode: Watch['mode']): Consumer => consumer({ watches: [watch({ spec, mode })] });

  assert.deepEqual(describeTarget([of({ visual: true, triage: false }, 'visual')], cand), large.bbox);
  assert.deepEqual(describeTarget([of({ regex: 'done', visual: false, triage: false }, 'regex')], cand), large.bbox);
  assert.deepEqual(
    describeTarget([of({ regex: 'done', rect: [0, 0, 100, 100], visual: false, triage: false }, 'regex')], cand),
    small.bbox,
    'a watch rect selects among the candidates'
  );
  assert.equal(describeTarget([of({ rect: [0, 0, 100, 100], visual: false, triage: false }, 'rect')], cand), null);
  assert.equal(describeTarget([consumer()], cand), null, 'no watches, nothing to describe');
  assert.equal(describeTarget([of({ visual: true, triage: false }, 'visual')], candidates(emptyDiff(), [], d)), null);
});

test("a text watch reads the round's description from the document, and a visual watch quotes it", async () => {
  const d = deps({ embed: async (texts) => texts.map((t) => (t.includes('progress') ? [1, 0] : [0, 1])) });
  const bbox: Rect = [400, 300, 120, 90];
  const described = doc({
    regions: [{ bbox, kind: 'visual', interpreted: 'A progress bar reached 80 percent. Cancel button', ref: 'f-7-301', v: 12 }],
  });
  const cand = candidates(emptyDiff({ visual: [{ bbox, d: 0.4 }] }), [], d);

  const text = consumer({
    watches: [watch({ id: 'w1', spec: { for: 'a long task is running', visual: false, triage: false }, vector: [1, 0], mode: 'for' })],
  });
  const hit = await evaluate(text, cand, described, d);
  assert.deepEqual(hit.watches, [{ id: 'w1', hit: true, mode: 'for', evaluation: 'weak' }], 'each sentence is scored');

  const visual = consumer({ watches: [watch({ id: 'w2', spec: { visual: true, triage: false }, mode: 'visual' })] });
  assert.deepEqual((await evaluate(visual, cand, described, d)).watches, [{ id: 'w2', hit: true, mode: 'visual' }]);

  // The same round without a description: the text watch has nothing to read,
  // the visual watch still delivers the rectangle and says it is bare.
  const bare = doc();
  assert.deepEqual((await evaluate(text, cand, bare, d)).watches, [
    { id: 'w1', hit: false, mode: 'for', evaluation: 'unavailable' },
  ]);
  assert.deepEqual((await evaluate(visual, cand, bare, d)).watches, [
    { id: 'w2', hit: true, mode: 'visual', evaluation: 'rect-only' },
  ]);
});

test('a text watch with no describe reports unavailable on a visual-only change', async () => {
  const d = deps({ embed: async (t) => t.map(() => [1, 0]) });
  const c = consumer({
    watches: [watch({ spec: { regex: 'done', visual: false, triage: false }, mode: 'regex' })],
  });
  const cand = candidates(emptyDiff({ visual: [{ bbox: [400, 300, 120, 90], d: 0.4 }] }), [], d);
  const report = await evaluate(c, cand, doc(), d);
  assert.deepEqual(report.watches, [{ id: 'w1', hit: false, mode: 'regex', evaluation: 'unavailable' }]);
  assert.equal(report.deliver, false);
});

test('a changed RULE key is text a watch can read; the others only say which document this is', async () => {
  const d = deps();
  const reads = (pattern: string): Consumer =>
    consumer({ watches: [watch({ spec: { regex: pattern, visual: false, triage: false }, mode: 'regex' })] });
  const changed = doc({
    meta: {
      app: { value: 'Xcode (com.apple.dt.Xcode)' },
      sheet: { value: '"Save As"', bounds: [10, 20, 300, 200] },
      focus: { value: 'AXTextField "search" value="cannot find value"', bounds: [0, 32, 600, 384] },
    },
  });

  // `ruleKeys` is ['focus'] by default: that is the field whose text is read.
  assert.equal((await evaluate(reads('cannot find'), candidates(emptyDiff({ metaChanged: ['focus'] }), [], d), changed, d)).deliver, true);
  assert.equal((await evaluate(reads('cannot find'), candidates(emptyDiff({ metaChanged: [] }), [], d), changed, d)).deliver, false, 'the key has to have changed to be read');

  // `sheet` and `window` name the document, so a regex never matches on them —
  // `matchFilter` still reads every key by name (below).
  assert.equal((await evaluate(reads('Save As'), candidates(emptyDiff({ metaChanged: ['sheet'] }), [], d), changed, d)).deliver, false);
  const byName = consumer({
    watches: [watch({ spec: { filter: { sheet: 'Save As' }, visual: false, triage: false }, mode: 'filter' })],
  });
  assert.equal(
    (await evaluate(byName, candidates(emptyDiff({ metaChanged: ['focus'] }), [], d), changed, d)).deliver,
    true,
    'a filter names the field it reads'
  );
});

test('a visual watch fires on the pixels alone, no model needed', async () => {
  const d = deps();
  const c = consumer({ watches: [watch({ spec: { visual: true, triage: false }, mode: 'visual' })] });
  const cand = candidates(emptyDiff({ visual: [{ bbox: [400, 300, 120, 90], d: 0.4 }] }), [], d);
  const report = await evaluate(c, cand, doc(), d);
  assert.equal(report.deliver, true);
  assert.deepEqual(report.watches, [{ id: 'w1', hit: true, mode: 'visual', evaluation: 'rect-only' }]);

  const textOnly = candidates(emptyDiff({ added: [line('t1', [0, 0, 100, 16], 'hello')] }), [], d);
  assert.equal((await evaluate(c, textOnly, doc(), d)).deliver, false);
});
