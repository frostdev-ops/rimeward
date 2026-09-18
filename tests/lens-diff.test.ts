import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DocState } from '../src/lib/lens/doc.ts';
import { diffDocs } from '../src/lib/lens/diff.ts';
import type { Draft } from '../src/lib/lens/doc.ts';
import type { Line, Rect } from '../src/lib/lens/types.ts';

function draft(text: string, bbox: Rect): Draft {
  return { text, bbox, src: 'ax', conf: 1 };
}

const claims =
  (rect: Rect) =>
  (line: Line): boolean => {
    const b = line.bbox;
    if (!b) return true;
    const y = Math.min(b[1] + b[3], rect[1] + rect[3]) - Math.max(b[1], rect[1]);
    const x = Math.min(b[0] + b[2], rect[0] + rect[2]) - Math.max(b[0], rect[0]);
    return x > 0 && y >= b[3] / 2;
  };

function docs(): DocState {
  const state = new DocState();
  state.epoch(1, 1);
  state.meta('app', 'com.apple.dt.Xcode "Xcode" pid=123', 1);
  state.meta('window', '5375 "main.rs" bounds=0,0,656,422', 2);
  return state;
}

test('a diff from nothing is everything added', () => {
  const state = docs();
  state.replace([draft('one', [0, 0, 100, 16])], 3, claims([0, 0, 600, 100]));
  const v1 = state.freeze();

  const diff = diffDocs(null, v1);
  assert.equal(diff.from, null);
  assert.equal(diff.to, 1);
  assert.equal(diff.added.length, 1);
  assert.deepEqual([diff.removed.length, diff.moved.length], [0, 0]);
  assert.equal(diff.epoch, true);
  assert.deepEqual(diff.metaChanged, ['app', 'window']);
});

test('added, removed, moved and visual are separated', () => {
  const state = docs();
  const rect: Rect = [0, 0, 600, 200];
  state.replace(
    [draft('alpha', [0, 0, 100, 16]), draft('bravo', [0, 40, 100, 16]), draft('charlie', [0, 80, 100, 16])],
    3,
    claims(rect)
  );
  const v1 = state.freeze();

  // alpha stays, bravo moves, charlie is replaced by delta.
  state.replace(
    [draft('alpha', [0, 0, 100, 16]), draft('bravo', [0, 44, 100, 16]), draft('delta', [0, 80, 100, 16])],
    4,
    claims(rect)
  );
  // One dirty rectangle sits on the replaced line, one over an empty area.
  state.current().dirty = [
    { bbox: [0, 72, 200, 32], d: 0.6 },
    { bbox: [400, 300, 120, 90], d: 0.31 },
  ];
  const v2 = state.freeze();

  const diff = state.diff(v1.v, v2.v);
  assert.equal(diff.from, 1);
  assert.equal(diff.to, 2);
  assert.deepEqual(diff.added.map((l) => l.text), ['delta']);
  assert.deepEqual(diff.removed.map((l) => l.text), ['charlie']);
  assert.deepEqual(diff.moved.map((l) => l.text), ['bravo']);
  assert.deepEqual(
    diff.visual.map((d) => d.bbox),
    [[400, 300, 120, 90]],
    'the dirty rect explained by a text change drops out'
  );
  assert.equal(diff.epoch, false);
  assert.deepEqual(diff.metaChanged, []);
});

test('metaChanged names every key that moved, and a dropped key too', () => {
  const state = docs();
  const v1 = state.freeze();

  state.meta('focus', 'AXTextArea "editor" value="fn main"', 3);
  state.freeze();
  assert.deepEqual(state.diff(1, 2).metaChanged, ['focus']);

  state.meta('sheet', '"Save As" bounds=10,10,200,100', 4);
  state.meta('focus', undefined, 5);
  state.freeze();
  assert.deepEqual(state.diff(2, 3).metaChanged, ['sheet', 'focus'], 'the dropped key is reported last');

  // A window switch opens an epoch, which clears the rest.
  state.epoch(2, 1);
  state.meta('window', '90 "lib.rs" bounds=0,0,656,422', 1);
  const v4 = state.freeze();
  const across = state.diff(3, 4);
  assert.equal(across.epoch, true);
  assert.deepEqual(across.metaChanged, ['window', 'app', 'sheet']);
  assert.equal(v4.v, 4);
});
