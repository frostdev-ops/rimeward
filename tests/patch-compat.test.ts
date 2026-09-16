import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, patchPath, patchText } from '../src/lib/dev/patch.ts';

// Codex seek_sequence.rs at 21aa552e8727c03189d0f7d18bbd6e7583e88f88;
// Rimeward intentionally preserves source context and final-newline state.
const apply = (source: string, hunks: string) => {
  const operation = parsePatch(`*** Begin Patch\n*** Update File: example.txt\n${hunks}\n*** End Patch`)[0]!;
  assert.equal(operation.kind, 'update');
  return patchText(source, operation as Extract<typeof operation, { kind: 'update' }>);
};

test('matching chooses first match in the strongest complete pass', () => {
  assert.equal(apply('  old\nold\nold\n', '@@\n-old\n+new'), '  old\nnew\nold\n');
  assert.equal(apply('  old\nold  \n', '@@\n-old\n+new'), '  old\nnew\n');
  assert.equal(apply('  old\n  old\n', '@@\n-old\n+new'), 'new\n  old\n');
});

test('anchors use the same tolerance and replacement text remains literal', () => {
  assert.equal(apply('  anchor\n\told\n', '@@ anchor\n-old\n+ new  '), '  anchor\n new  \n');
  assert.equal(apply(' “context”\n  old\n tail\n', '@@\n "context"\n-old\n+new\n tail'), ' “context”\nnew\n tail\n');
});

test('Unicode normalization is limited and matches Rust whitespace semantics', () => {
  assert.equal(apply('“x”—\u00a0y\n', '@@\n-"x"- y\n+new'), 'new\n');
  assert.equal(apply('\u0085old\u0085\n', '@@\n-old\n+new'), 'new\n');
  assert.throws(() => apply('\ufeffold\n', '@@\n-old\n+new'), /context not found/);
  assert.throws(() => apply('café\n', '@@\n-cafe\n+new'), /context not found/);
});

test('insertion-only hunks append in order without becoming later context', () => {
  assert.equal(apply('old\n', '@@\n+first\n@@\n+second\n@@\n-old\n+new'), 'new\nfirst\nsecond\n');
  assert.equal(apply('anchor\nold\n', '@@ anchor\n+new'), 'anchor\nold\nnew\n');
  assert.throws(() => apply('old\n', '@@\n+new\n@@\n-new\n+changed'), /context not found/);
});

test('trailing empty context and EOF preserve the source final newline contract', () => {
  assert.equal(apply('old\n', '@@\n-old\n+new\n '), 'new\n');
  assert.equal(apply('old', '@@\n-old\n+new\n '), 'new');
  assert.equal(apply('', '@@\n+new'), 'new\n');
  assert.throws(() => apply('old\ntail\n', '@@\n-old\n+new\n*** End of File'), /context not found/);
});

test('paths are virtual and portable; traversal and Git metadata remain forbidden', () => {
  assert.equal(patchPath('/named/file.ts'), '/named/file.ts');
  for (const path of ['/../secret', '//file', 'C:/file', 'folder/.git/config', 'con.txt', 'a\\b']) assert.throws(() => patchPath(path));
});
