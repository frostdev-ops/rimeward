import test from 'node:test';
import assert from 'node:assert/strict';
import { insert, leaves, parseNode, reconcile, remove, swap, withRatio, type Node } from '../src/lib/dev/terminal-layout.ts';

test('insert splits beside the target leaf on the named side', () => {
  const right = insert('a', 'a', 'b', 'right');
  assert.deepEqual(right, { dir: 'row', a: 'a', b: 'b', ratio: 0.5 });
  const top = insert(right, 'b', 'c', 'top');
  assert.deepEqual(top, { dir: 'row', a: 'a', b: { dir: 'col', a: 'c', b: 'b', ratio: 0.5 }, ratio: 0.5 });
  assert.deepEqual(leaves(top), ['a', 'c', 'b']);
  assert.equal(insert(right, 'zzz', 'c', 'left'), right, 'an absent target leaves the tree alone');
});

test('remove collapses a split left with one side, all the way to null', () => {
  const tree: Node = { dir: 'row', a: 'a', b: { dir: 'col', a: 'c', b: 'b', ratio: 0.3 }, ratio: 0.5 };
  assert.deepEqual(remove(tree, 'c'), { dir: 'row', a: 'a', b: 'b', ratio: 0.5 });
  assert.deepEqual(remove(remove(tree, 'c')!, 'a'), 'b');
  assert.equal(remove('a', 'a'), null);
  assert.equal(remove(tree, 'nope'), tree, 'an absent id returns the same tree');
});

test('swap and withRatio touch only what they name', () => {
  const tree: Node = { dir: 'row', a: 'a', b: 'b', ratio: 0.5 };
  assert.deepEqual(swap(tree, 'a', 'b'), { dir: 'row', a: 'b', b: 'a', ratio: 0.5 });
  assert.deepEqual(withRatio(tree, tree as Exclude<Node, string>, 0.95), { dir: 'row', a: 'a', b: 'b', ratio: 0.9 });
});

test('parseNode accepts stored trees and refuses junk', () => {
  assert.deepEqual(parseNode({ dir: 'col', a: 'x', b: { dir: 'row', a: 'y', b: 'z' } }), { dir: 'col', a: 'x', b: { dir: 'row', a: 'y', b: 'z', ratio: 0.5 }, ratio: 0.5 });
  assert.equal(parseNode({ dir: 'diagonal', a: 'x', b: 'y' }), null);
  assert.equal(parseNode({ dir: 'row', a: 'x', b: 7 }), null);
  assert.equal(parseNode('has space'), null);
  assert.equal((parseNode({ dir: 'row', a: 'x', b: 'y', ratio: 5 }) as { ratio: number }).ratio, 0.9);
});

test('reconcile keeps groups in step with the visible sessions', () => {
  const groups: Node[] = [{ dir: 'row', a: 'a', b: 'gone', ratio: 0.5 }, 'b', { dir: 'col', a: 'a', b: 'c', ratio: 0.5 }];
  assert.deepEqual(reconcile(groups, ['a', 'b', 'c', 'new']), ['a', 'b', 'c', 'new'], 'vanished pruned, duplicates kept once, newcomers appended');
  assert.deepEqual(reconcile([], ['x', 'y']), ['x', 'y'], 'no stored groups = one tab per session');
  assert.deepEqual(reconcile(['x'], []), []);
  let big: Node = 'p0';
  for (let i = 1; i < 10; i++) big = insert(big, `p${i - 1}`, `p${i}`, 'right');
  const capped = reconcile([big], leaves(big), 8);
  assert.equal(leaves(capped[0]!).length, 8);
  assert.deepEqual(capped.slice(1), ['p9', 'p8']);
  assert.deepEqual(capped.flatMap(leaves).sort(), leaves(big).sort(), 'every session still shows once');
});
