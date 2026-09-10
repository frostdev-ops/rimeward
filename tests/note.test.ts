import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout, noteConfig } from '../src/lib/wards.ts';
import { NOTE_HTML_MAX, getNote, noteWard, plainText, sanitizeHtml, saveNote, textToHtml } from '../src/lib/note.ts';

test('sanitizeHtml: allowlisted tags survive, everything else is text or gone', () => {
  assert.equal(sanitizeHtml('<p onclick="x()">a</p><script>alert(1)</script>'), '<p>a</p>alert(1)');
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)><iframe src="//evil"></iframe>hi'), 'hi');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="https://e.com/?a=1&b=2" class="c">y</a>'), '<a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noreferrer">y</a>');
  assert.equal(sanitizeHtml('<p style="color:red;text-align: center">c</p>'), '<p style="color:red;text-align:center">c</p>');
  assert.equal(sanitizeHtml('a < b and c > d'), 'a &lt; b and c &gt; d');
  assert.equal(sanitizeHtml('<!-- <script>x</script> -->t<!'), 't'); // a bogus comment is markup to a browser too
  assert.equal(sanitizeHtml('<?php echo 1 ?>x</ nope>y'), 'xy');
  assert.equal(sanitizeHtml('<b><i>x</b></i>'), '<b><i>x</i></b>');
  assert.equal(sanitizeHtml('<ul><li>one<li>two</ul>'), '<ul><li>one<li>two</li></li></ul>');
  assert.equal(sanitizeHtml('<p>x<br>y<hr></p></br>'), '<p>x<br>y<hr></p>');
  assert.equal(sanitizeHtml('</p>stray'), 'stray');
  assert.equal(sanitizeHtml('<P>Up</P>'), '<p>Up</p>');
  assert.equal(sanitizeHtml('&amp;&nbsp;&lt;'), '&amp;&nbsp;&lt;'); // entities pass through untouched
});

test('plainText and textToHtml round the document into and out of text', () => {
  assert.equal(plainText('<h1>T</h1><p>a<br>b</p><ul><li>x</li><li>y &amp; z</li></ul>'), 'T\na\nb\nx\ny & z');
  assert.equal(textToHtml('one\ntwo\n\nthree <b>'), '<p>one<br>two</p><p>three &lt;b&gt;</p>');
});

test('note wards: ownership, legacy text seeds the first read, saves sanitize and cap', () => {
  const uid = createUser('note@test.io', 'pw');
  const other = createUser('other@test.io', 'pw');
  saveDashboard(uid, validateLayout([{ i: 'n1', type: 'note', size: '2x2', config: { text: 'old\nnote' } }, { i: 'w', type: 'weather', size: '2x1' }])!);
  saveDashboard(other, validateLayout([{ i: 'n1', type: 'note', size: '2x2' }])!);

  assert.equal(noteWard(uid, 'w'), null, 'not a note');
  assert.equal(noteWard(uid, 'nope'), null);
  assert.equal(noteWard(uid, 42), null);
  const w = noteWard(uid, 'n1')!;
  assert.ok(w);
  // Seeded from the pre-store config text, one paragraph per line, no row yet.
  assert.deepEqual(getNote(uid, w), { html: '<p>old</p><p>note</p>', ink: '[]', updated: null });
  assert.deepEqual(getNote(other, noteWard(other, 'n1')!), { html: '', ink: '[]', updated: null });

  const updated = saveNote(uid, w, { html: '<p>hi<script>x</script></p>' });
  assert.match(updated, /^\d{4}-\d{2}-\d{2} /);
  assert.equal(getNote(uid, w).html, '<p>hix</p>');
  // Each half saves on its own; the other is kept.
  saveNote(uid, w, { ink: '[{"c":"#000","w":2,"p":[[1,2,0.5]]}]' });
  assert.equal(getNote(uid, w).html, '<p>hix</p>');
  assert.equal(getNote(uid, w).ink, '[{"c":"#000","w":2,"p":[[1,2,0.5]]}]');
  // The other user's same ward id is a different document.
  assert.equal(getNote(other, noteWard(other, 'n1')!).html, '');

  assert.throws(() => saveNote(uid, w, { ink: '{"not":"a list"}' }), /bad ink/);
  assert.throws(() => saveNote(uid, w, { ink: 'nope' }), /bad ink/);
  assert.throws(() => saveNote(uid, w, { html: 'x'.repeat(NOTE_HTML_MAX + 1) }), /too large/);
});

test('validateLayout: the notepad knobs default, clamp and keep the legacy text', () => {
  const one = (config: Record<string, unknown>) => validateLayout([{ i: 'n', type: 'note', size: '2x2', config }])![0]!;
  assert.deepEqual(one({}).config, { paper: 'plain', ink: true, transcribe: 'manual', keepInk: false, provider: 'openrouter' });
  assert.deepEqual(one({ paper: 'dots', ink: false, transcribe: 'live', keepInk: true, provider: 'codex', model: ' gpt-x ', text: 'seed' }).config, {
    paper: 'dots', ink: false, transcribe: 'live', keepInk: true, provider: 'codex', model: 'gpt-x', text: 'seed',
  });
  assert.deepEqual(one({ paper: 'velvet', transcribe: 'sometimes', provider: 'gemini', model: 'x'.repeat(101) }).config, {
    paper: 'plain', ink: true, transcribe: 'manual', keepInk: false, provider: 'openrouter',
  });
  assert.equal(noteConfig({ i: 'n', type: 'note', size: '1x1' }).transcribe, 'manual');
  // A note ward never fails the layout — it is what schedules hang off.
  assert.ok(validateLayout([{ i: 'n', type: 'note', size: '2x1', config: { text: 42, paper: null } }]));
});
