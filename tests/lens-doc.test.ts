import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DocState } from '../src/lib/lens/doc.ts';
import type { Draft } from '../src/lib/lens/doc.ts';
import type { Line, Rect } from '../src/lib/lens/types.ts';

// The generic half of BlackIce tests/scene.test.ts: the screen's signal
// translation (and the frame ring it pins) lives in lens/screen.ts.

function draft(text: string, bbox: Rect, src = 'ax'): Draft {
  return { text, bbox, src, conf: src === 'ax' ? 1 : 0.9 };
}

/** The screen source's own claim rule: half the line's height, any horizontal touch. */
const claims =
  (rect: Rect) =>
  (line: Line): boolean => {
    const b = line.bbox;
    if (!b) return true;
    const y = Math.min(b[1] + b[3], rect[1] + rect[3]) - Math.max(b[1], rect[1]);
    const x = Math.min(b[0] + b[2], rect[0] + rect[2]) - Math.max(b[0], rect[0]);
    return x > 0 && y >= b[3] / 2;
  };

/** An epoch-1 document with an app and a window header. */
function started(): DocState {
  const doc = new DocState();
  doc.epoch(1, 1);
  doc.meta('app', { value: 'com.apple.dt.Xcode "Xcode" pid=123' }, 1);
  doc.meta('window', { value: '5375 "main.rs" bounds=195,92,656,422' }, 2);
  return doc;
}

test('an epoch that is not newer is discarded', () => {
  const state = started();
  state.replace([draft('hello', [0, 0, 100, 16])], 3, claims([0, 0, 600, 100]));

  assert.equal(state.epoch(0, 9), false);
  assert.equal(state.epoch(1, 12), false);
  assert.equal(state.current().epoch, 1);
  assert.deepEqual(state.current().lines.map((l) => l.text), ['hello']);
});

test('a new epoch clears everything the old one produced', () => {
  const state = started();
  state.replace([draft('hello', [0, 0, 100, 16])], 3, claims([0, 0, 600, 100]));
  state.meta('focus', { value: 'AXTextArea "editor" value="x"' }, 4);
  state.current().dirty = [{ bbox: [0, 0, 10, 10], d: 0.4 }];
  state.current().live = [[0, 0, 10, 10]];
  state.markIncomplete();

  assert.equal(state.epoch(2, 1), true);
  const doc = state.current();
  assert.equal(doc.epoch, 2);
  assert.deepEqual(doc.lines, []);
  assert.deepEqual(doc.dirty, []);
  assert.deepEqual(doc.live, []);
  assert.deepEqual(doc.meta, {});
  assert.equal(doc.incomplete, false);
  assert.equal(doc.ref, null);
  assert.equal(state.lastSeq(), 1);

  // The seq guard resets with the epoch: the new epoch's own header applies.
  assert.equal(state.meta('window', { value: '7 "Start Page"' }, 2), true);
  assert.equal(state.current().meta.window?.value, '7 "Start Page"');
});

test('meta applies in ascending seq and reports what changed', () => {
  const state = started();
  assert.equal(state.meta('window', { value: '5375 "main.rs — edited"', bounds: [195, 92, 656, 422] }, 6), true);
  // An older write never overwrites the newer value.
  assert.equal(state.meta('window', { value: '5375 "main.rs"' }, 4), false);
  assert.equal(state.current().meta.window?.value, '5375 "main.rs — edited"');

  // Same value, new bounds: the field moved, which is not a change.
  assert.equal(state.meta('window', { value: '5375 "main.rs — edited"', bounds: [200, 92, 656, 422] }, 7), false);
  assert.deepEqual(state.current().meta.window?.bounds, [200, 92, 656, 422], 'the move is stored all the same');
  assert.equal(state.meta('focus', undefined, 8), false, 'dropping a key that was never set changes nothing');
  assert.equal(state.meta('focus', { value: 'AXTextArea "editor" value="later"' }, 9), true);
  assert.equal(state.meta('focus', undefined, 10), true);
  assert.deepEqual(Object.keys(state.current().meta), ['app', 'window']);
  assert.equal(state.lastSeq(), 10);
});

test('a read finishing after a newer one is discarded as stale', () => {
  const state = started();
  const rect: Rect = [0, 0, 600, 40];
  state.replace([draft('newer text', [0, 0, 300, 16], 'ocr')], 51, claims(rect));

  const late = state.replace([draft('older text', [0, 0, 300, 16], 'ocr')], 50, claims(rect));
  assert.equal(late.changed, 'none');
  assert.deepEqual(state.current().lines.map((l) => l.text), ['newer text']);
});

test('an edit at the end of a long line replaces only that line', () => {
  const state = started();
  state.replace(
    [
      draft('the first line of the paragraph', [0, 0, 560, 16]),
      draft('the second line of the paragraph', [0, 20, 580, 16]),
      draft('the third line of the paragraph', [0, 40, 550, 16]),
    ],
    3,
    claims([0, 0, 600, 100])
  );
  const before = state.current().lines.map((l) => l.id);

  // The source widened the region of interest to the whole line it overlapped.
  const result = state.replace(
    [draft('the second line of the paragraph!', [0, 20, 592, 16], 'ocr')],
    5,
    claims([0, 20, 600, 16])
  );
  assert.equal(result.changed, 'bump');
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(result.moved.length, 0);
  assert.equal(result.added[0]?.text, 'the second line of the paragraph!');

  const after = state.current().lines;
  assert.equal(after.length, 3);
  assert.equal(after[0]?.id, before[0], 'the line above is untouched');
  assert.equal(after[2]?.id, before[2], 'the line below is untouched');
  assert.notEqual(after[1]?.id, before[1]);
});

test('duplicate labels keep separate ids and a move of one keeps both', () => {
  const state = started();
  const rect: Rect = [0, 0, 600, 100];
  state.replace([draft('Total', [0, 0, 80, 16]), draft('Total', [0, 40, 80, 16])], 3, claims(rect));
  const ids = state.current().lines.map((l) => l.id);
  assert.equal(new Set(ids).size, 2, 'duplicates survive as two lines');

  const result = state.replace([draft('Total', [0, 0, 80, 16]), draft('Total', [0, 46, 80, 16])], 4, claims(rect));
  assert.equal(result.changed, 'moved');
  assert.equal(result.moved.length, 1);
  assert.deepEqual(state.current().lines.map((l) => l.id), ids);
  assert.deepEqual(state.current().lines.map((l) => l.bbox?.[1]), [0, 46]);
});

test('scrolling moves every line and bumps nothing', () => {
  const state = started();
  const rect: Rect = [0, 0, 600, 200];
  const texts = ['alpha', 'bravo', 'charlie', 'delta'];
  state.replace(texts.map((t, i) => draft(t, [0, i * 20, 300, 16])), 3, claims(rect));
  const ids = state.current().lines.map((l) => l.id);

  const result = state.replace(texts.map((t, i) => draft(t, [0, i * 20 + 12, 300, 16])), 4, claims(rect));
  assert.equal(result.changed, 'moved');
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.moved.length, 4);
  assert.deepEqual(state.current().lines.map((l) => l.id), ids);
});

test('two readers replace each other cleanly inside one rect', () => {
  const state = started();
  const rect: Rect = [0, 0, 600, 100];
  const lines = [draft('Save changes?', [0, 0, 200, 16]), draft('Discard', [0, 40, 100, 16])];
  state.replace(lines, 3, claims(rect));
  const ids = state.current().lines.map((l) => l.id);

  const toOcr = state.replace(lines.map((l) => ({ ...l, src: 'ocr', conf: 0.9 })), 4, claims(rect));
  assert.equal(toOcr.changed, 'none', 'same text in the same place is not a change');
  assert.equal(state.current().lines.length, 2);
  assert.deepEqual(state.current().lines.map((l) => l.src), ['ocr', 'ocr']);
  assert.deepEqual(state.current().lines.map((l) => l.id), ids);

  state.replace(lines, 5, claims(rect));
  assert.deepEqual(state.current().lines.map((l) => l.src), ['ax', 'ax']);
  assert.deepEqual(state.current().lines.map((l) => l.id), ids);
  assert.deepEqual(state.current().lines.map((l) => l.conf), [1, 1]);
});

test('a source with no geometry keeps its own order and its own keys', () => {
  const state = new DocState();
  state.epoch(1, 1);
  const rows = (texts: string[]): Draft[] =>
    texts.map((text, i) => ({ text, src: 'pty', key: `r${i}` }));

  state.replace(rows(['$ npm test', 'ok 1', 'ok 2']), 1);
  assert.deepEqual(state.current().lines.map((l) => l.text), ['$ npm test', 'ok 1', 'ok 2']);
  assert.equal(state.current().lines[0]?.bbox, undefined);
  const ids = state.current().lines.map((l) => l.id);

  // The same row keys, one row rewritten in place: the ids hold.
  const result = state.replace(rows(['$ npm test', 'ok 1', 'ok 2 — done']), 2);
  assert.equal(result.changed, 'none', 'a keyed row rewritten in place is not added or removed');
  assert.deepEqual(state.current().lines.map((l) => l.id), ids);
  assert.deepEqual(state.current().lines.map((l) => l.text), ['$ npm test', 'ok 1', 'ok 2 — done']);
});

test('a snapshot rebuilds the document and clears incomplete', () => {
  const state = started();
  state.replace([draft('kept line', [0, 0, 200, 16])], 3, claims([0, 0, 600, 100]));
  const kept = state.current().lines[0]?.id;
  state.markIncomplete();

  state.snapshot({
    epoch: 1,
    seq: 40,
    meta: {
      app: { value: 'com.apple.dt.Xcode "Xcode" pid=123' },
      window: { value: '5375 "lib.rs" bounds=10,20,656,422' },
    },
    lines: [draft('kept line', [0, 0, 200, 16]), draft('recognised line', [0, 40, 260, 16], 'ocr')],
    ref: 'f-1-38',
  });

  const doc = state.current();
  assert.equal(doc.incomplete, false);
  assert.equal(state.lastSeq(), 40);
  assert.equal(doc.meta.window?.value, '5375 "lib.rs" bounds=10,20,656,422');
  assert.equal(doc.ref, 'f-1-38');
  assert.deepEqual(doc.lines.map((l) => l.text), ['kept line', 'recognised line']);
  assert.deepEqual(doc.lines.map((l) => l.src), ['ax', 'ocr']);
  assert.equal(doc.lines[0]?.id, kept, 'text that survived the gap keeps its id');
  assert.equal(doc.lines[1]?.conf, 0.9);
  assert.deepEqual(doc.live, []);
});

test('freeze pins the ref, stamps the clock, rings 32 versions and hands out immutable copies', () => {
  let ticks = 1_000;
  const state = new DocState({ now: () => (ticks += 10) });
  const first = state.freeze('f-1-3');
  assert.equal(first.v, 1);
  assert.equal(first.ref, 'f-1-3');
  assert.equal(first.at, 1_010, 'the version is stamped when it is frozen');

  // A newer ref never moves the ref a version was pinned to.
  state.freeze('f-1-4');
  assert.equal(state.version(1)?.ref, 'f-1-3');
  assert.equal(state.version(2)?.ref, 'f-1-4');

  assert.throws(() => {
    (first.lines as unknown as { push: (v: unknown) => void }).push({});
  }, TypeError);
  assert.throws(() => {
    (first as { v: number }).v = 99;
  }, TypeError);

  for (let i = 3; i <= 40; i++) state.freeze();
  assert.equal(state.current().v, 40);
  assert.equal(state.version(8), undefined, 'evicted beyond the ring');
  assert.equal(state.version(9)?.v, 9);
  assert.equal(state.version(40)?.v, 40);

  // A cursor that fell out of the ring diffs as if from nothing.
  assert.equal(state.diff(8, 40).from, null);
  assert.throws(() => state.diff(null, 999));
});

test('the ring size is configurable', () => {
  const state = new DocState({ ring: 2 });
  state.freeze();
  state.freeze();
  state.freeze();
  assert.equal(state.version(1), undefined);
  assert.equal(state.version(3)?.v, 3);
});
