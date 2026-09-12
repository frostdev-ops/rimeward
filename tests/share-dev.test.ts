import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerFrame, viewerSession, type TerminalScope } from '../src/lib/share-dev.ts';

const frame = (ev: object, id = 7) => `id: ${id}\ndata: ${JSON.stringify(ev)}`;
const parse = (out: string) => JSON.parse(out.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) as { type: string; id: string; data?: Record<string, unknown> };

test('viewerFrame: the reset, the shared project’s sessions and their output — nothing of the rest of the desktop', () => {
  const scope: TerminalScope = { project: 'p1', sessions: new Set(['s1']), at: Date.now() };
  assert.equal(viewerFrame(': heartbeat', scope), ': heartbeat');
  assert.equal(viewerFrame(frame({ sequence: 1, type: 'reset', id: '' }), scope), frame({ sequence: 1, type: 'reset', id: '' }));
  assert.ok(viewerFrame(frame({ sequence: 2, type: 'output', id: 's1', data: { sequence: 9, data: 'ls\r\n' } }), scope));
  assert.equal(viewerFrame(frame({ sequence: 3, type: 'output', id: 's2', data: { sequence: 1, data: 'secret' } }), scope), null, 'another session’s output');
  for (const type of ['project', 'buffer', 'ward']) assert.equal(viewerFrame(frame({ sequence: 4, type, id: 'p1', data: { path: '/Users/me/x' } }), scope), null, type);
  assert.equal(viewerFrame(frame({ sequence: 5, type: 'session', id: '' }), scope), frame({ sequence: 5, type: 'session', id: '' }), 'the list-changed signal');
  // A new session of the shared project joins the scope as it is announced; its evidence never leaves.
  const announced = viewerFrame(frame({ sequence: 6, type: 'session', id: 's3', data: { id: 's3', project: 'p1', title: 'zsh', evidence: { diff: '--- a' }, review: 'x' } }), scope);
  assert.ok(announced && scope.sessions.has('s3'));
  assert.deepEqual(parse(announced!).data, { id: 's3', project: 'p1', title: 'zsh' });
  assert.ok(viewerFrame(frame({ sequence: 7, type: 'output', id: 's3', data: { sequence: 1, data: 'x' } }), scope));
  assert.equal(viewerFrame(frame({ sequence: 8, type: 'session', id: 's9', data: { id: 's9', project: 'p2' } }), scope), null, 'another project’s session');
  assert.equal(viewerFrame(frame({ sequence: 9, type: 'session', id: 's9' }), scope), null);
  assert.equal(viewerFrame('data: not json', scope), null);
  assert.equal(viewerFrame('id: 3', scope), null);
});

test('viewerSession: a session without its review evidence', () => {
  assert.deepEqual(viewerSession({ id: 's1', title: 'zsh', evidence: { files: [{ path: '/Users/me/secret.ts', hash: null }] }, review: 'r' }), { id: 's1', title: 'zsh' });
  assert.deepEqual(viewerSession({ id: 's1', owner: 'client:abc' }), { id: 's1', owner: 'client:abc' });
});
