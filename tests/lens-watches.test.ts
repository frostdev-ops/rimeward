// D4: the Lens watches list behind the agent ward's ⚙ — every watch this user
// has across every source, and the one control that takes one off. The rows are
// the real stored ones; the live core is the real one, so what the route
// enriches with is a real evaluation.
import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';

import { createUser } from '../src/lib/users.ts';
import { SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source } from '../src/lib/lens/core.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import type { Consumer } from '../src/lib/lens/types.ts';
import { DELETE, GET } from '../src/pages/api/lens-watches.ts';

interface Watch {
  source: string;
  consumer: string;
  id: string;
  mode: string;
  evaluation?: string;
  spec: Record<string, unknown>;
  created_at: number;
}

const ctx = (userId: number, body?: unknown): APIContext =>
  ({
    locals: { user: { userId } },
    request: new Request('https://rimeward.invalid/api/lens-watches', {
      method: body === undefined ? 'GET' : 'DELETE',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    url: new URL('https://rimeward.invalid/api/lens-watches'),
  }) as unknown as APIContext;

async function list(userId: number): Promise<Watch[]> {
  const res = await GET(ctx(userId));
  assert.equal(res.status, 200);
  return ((await res.json()) as { watches: Watch[] }).watches;
}

const remove = (userId: number, body: unknown): Promise<Response> => Promise.resolve(DELETE(ctx(userId, body)));

/** A source that connects and paints, the way lens/screen.ts does. */
function fakeScreen(): { source: Source; paint(rows: string[]): void } {
  let feed: Feed | null = null;
  let seq = 0;
  return {
    source: {
      async connect(_user, _target, f): Promise<() => void> {
        feed = f;
        seq += 1;
        f.epoch(1, seq);
        f.ref('frame-1');
        f.meta('app', 'com.apple.Safari "Safari" pid=812', seq);
        return (): void => {
          feed = null;
        };
      },
    },
    paint(rows: string[]): void {
      seq += 1;
      feed?.replace(rows.map((text) => ({ text, src: 'ax' as const })), seq);
    },
  };
}

async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A stored watch on a source with no core running: the state after a restart. */
function storedWatch(userId: number, source: string, consumer: string, id: string, spec: Record<string, unknown>): void {
  const store = sqliteStore(userId, source);
  const row: Consumer = {
    id: consumer,
    kind: consumer.startsWith('mon-') ? 'monitor' : 'conv',
    cursor: null,
    delivered: null,
    baseline: null,
    deltas: 0,
    minIntervalMs: 0,
    lastSentAt: null,
    seenAt: null,
    nextDelivery: 0,
    watches: [],
  };
  store.saveConsumer(row);
  store.saveWatches(consumer, [{ id, spec: spec as never, mode: 'regex', createdAt: 1_700_000_000_000 }]);
}

test('the list spans every source, enriched only where a core is live', async (t) => {
  const user = createUser('lens-watches@example.com', 'pw-lens-watches-1');
  const other = createUser('lens-watches-other@example.com', 'pw-lens-watches-1');

  // Source one: a terminal nobody is reading — the row is all there is.
  storedWatch(user, 'terminal:s1', 'cli-abc', 'cli-abc:w1', { regex: 'error: ', visual: false, triage: false });
  // Another user's watch on the same source, to prove the scope.
  storedWatch(other, 'terminal:s1', 'mon-xyz', 'mon-xyz:w1', { regex: 'theirs', visual: false, triage: false });

  // Source two: a live screen core with a `for` watch no decider can evaluate.
  const screen = fakeScreen();
  const real = SOURCES.screen;
  SOURCES.screen = (): Source => screen.source;
  t.after(() => {
    releaseLens(user, 'screen:local');
    if (real) SOURCES.screen = real;
    else delete SOURCES.screen;
  });
  const core = lens(user, 'screen:local', (): LensSettings => ({ settleMs: 0, minLines: 1 }))!;
  const added = await core.watch('conv-c1', { add: [{ for: 'a build error', visual: false, triage: false }] });
  assert.equal(added.watches[0]?.mode, 'unavailable', 'no decider: nothing can evaluate a `for`');
  // `connect` resolves on a microtask; the header it writes is the first
  // keyframe, and an unclaimed delivery makes a consumer ineligible — so this
  // reader acknowledges the way a conversation does before the change lands.
  await until('the source to connect', () => core.status().v > 0);
  const ack = (): void => {
    const pending = core.status().consumers.find((c) => c.id === 'conv-c1')?.delivered;
    if (pending) core.look('conv-c1', { ack: pending });
  };
  ack();
  screen.paint(['npm run build', 'error TS2345: nope']);
  await until('the core to evaluate the watch', () => {
    ack();
    return core.reports('conv-c1').length > 0;
  });

  const watches = await list(user);
  assert.equal(watches.length, 2);
  const terminal = watches.find((w) => w.source === 'terminal:s1')!;
  assert.equal(terminal.consumer, 'cli-abc');
  assert.equal(terminal.mode, 'regex');
  assert.equal(terminal.evaluation, undefined, 'no core, so nothing has evaluated it');
  assert.equal(terminal.spec.regex, 'error: ');
  assert.equal(terminal.created_at, 1_700_000_000_000);

  const live = watches.find((w) => w.source === 'screen:local')!;
  assert.equal(live.consumer, 'conv-c1');
  assert.equal(live.mode, 'unavailable');
  assert.equal(live.evaluation, 'unavailable', "the live core's report is what says so");

  // The other user sees their own row and no more.
  const theirs = await list(other);
  assert.deepEqual(theirs.map((w) => w.consumer), ['mon-xyz']);

  // A live core removes the watch in memory too, not just under itself.
  const gone = await remove(user, { source: 'screen:local', consumer: 'conv-c1', id: live.id });
  assert.equal(gone.status, 200);
  assert.deepEqual((await core.watch('conv-c1', {})).watches, []);
  assert.deepEqual((await list(user)).map((w) => w.source), ['terminal:s1']);

  // With no core, the row goes straight from the table.
  assert.equal((await remove(user, { source: 'terminal:s1', consumer: 'cli-abc', id: terminal.id })).status, 200);
  assert.deepEqual(await list(user), []);
  assert.deepEqual((await list(other)).length, 1, "another user's watch was never touched");
});

test('a leyline\'s and a monitor\'s watches are read-only here', async () => {
  const user = createUser('lens-watches-managed@example.com', 'pw-lens-watches-1');
  storedWatch(user, 'terminal:s3', 'edge-e1', 'edge-e1:w1', { regex: 'deployed', visual: false, triage: false });
  storedWatch(user, 'browser:br1', 'mon-5', 'mon-5:w1', { regex: 'failed', visual: false, triage: false });

  for (const [source, consumer, owner] of [
    ['terminal:s3', 'edge-e1', 'leyline'],
    ['browser:br1', 'mon-5', 'monitor'],
  ] as const) {
    const res = await remove(user, { source, consumer, id: `${consumer}:w1` });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, new RegExp(`remove the ${owner} instead`));
  }
  assert.equal((await list(user)).length, 2, 'both watches are still there');
});

test('a delete names a watch that exists, or says so', async () => {
  const user = createUser('lens-watches-404@example.com', 'pw-lens-watches-1');
  storedWatch(user, 'terminal:s2', 'cli-9', 'cli-9:w1', { regex: 'boom', visual: false, triage: false });

  assert.equal((await remove(user, { source: 'terminal:s2', consumer: 'cli-9' })).status, 400);
  assert.equal((await remove(user, { source: 'terminal:s2', consumer: 'cli-9', id: 'cli-9:w7' })).status, 404);
  // Another user's watch is not theirs to remove.
  const thief = createUser('lens-watches-thief@example.com', 'pw-lens-watches-1');
  assert.equal((await remove(thief, { source: 'terminal:s2', consumer: 'cli-9', id: 'cli-9:w1' })).status, 404);
  assert.equal((await list(user)).length, 1);
});
