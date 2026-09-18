import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { createUser } from '../src/lib/users.ts';
import { sqliteStore, EVENT_CAP } from '../src/lib/lens/store.ts';
import type { Consumer, Delivery, Watch } from '../src/lib/lens/types.ts';

const alice = createUser('alice@example.com', 'pw-alice-1');
const bob = createUser('bob@example.com', 'pw-bob-1');

let ticks = 1_700_000_000_000;
const store = sqliteStore(alice, 'screen:local', () => ++ticks);

function consumer(id: string, over: Partial<Consumer> = {}): Consumer {
  return {
    id,
    kind: 'conv',
    cursor: null,
    delivered: null,
    baseline: null,
    deltas: 0,
    minIntervalMs: 0,
    lastSentAt: null,
    seenAt: null,
    nextDelivery: 0,
    watches: [],
    ...over,
  };
}

function delivery(n: number, over: Partial<Delivery> = {}): Delivery {
  return {
    delivery: `c1:${n}`,
    v: n,
    since: n - 1,
    epoch: 7,
    ref: `f-7-${n}`,
    kind: 'delta',
    text: `line ${n}`,
    ...over,
  };
}

test('a fresh consumer round trips through defaults', () => {
  store.saveConsumer(consumer('fresh'));
  const loaded = store.loadConsumers().find((c) => c.id === 'fresh');
  assert.deepEqual(loaded, consumer('fresh'));
  assert.equal(loaded?.cursor, null, 'no acked version reads back as null, not 0');
});

test('a consumer round trips with watches, delivered, baseline and the counter', () => {
  const watches: Watch[] = [
    { id: 'w1', spec: { for: 'the build finished', visual: false, triage: true, threshold: 0.42 }, mode: 'for', createdAt: 1_000 },
    { id: 'w2', spec: { regex: 'error: ', visual: false, triage: false }, mode: 'regex', createdAt: 1_001 },
    { id: 'w3', spec: { rect: [0, 0, 100, 50], visual: true, triage: false }, mode: 'visual', createdAt: 1_002 },
  ];
  const full = consumer('c1', {
    kind: 'monitor',
    cursor: 1841,
    delivered: { id: 'c1:17', v: 1842, kind: 'key', page: 2, pages: 3, truncated: false, pendingPage: 3 },
    baseline: { v: 1800, complete: false },
    deltas: 6,
    minIntervalMs: 2_000,
    lastSentAt: 1_700_000_000_123,
    seenAt: 1_700_000_000_456,
    nextDelivery: 17,
    watches,
  });

  store.saveConsumer(full);
  store.saveWatches('c1', watches);
  assert.deepEqual(store.loadConsumers().find((c) => c.id === 'c1'), full);

  // A truncated delta and a cleared baseline come back the same way.
  const after = consumer('c1', {
    kind: 'monitor',
    cursor: 1842,
    delivered: { id: 'c1:18', v: 1843, kind: 'delta', page: 1, pages: 1, truncated: true },
    baseline: { v: 1800, complete: true },
    deltas: 0,
    minIntervalMs: 2_000,
    lastSentAt: 1_700_000_000_999,
    seenAt: null,
    nextDelivery: 18,
    watches: [watches[0] as Watch],
  });
  store.saveConsumer(after);
  store.saveWatches('c1', [watches[0] as Watch]);
  assert.deepEqual(store.loadConsumers().find((c) => c.id === 'c1'), after);

  store.appendEvent('c1', delivery(9));
  assert.equal(store.events('c1').length, 1);

  store.deleteConsumer('c1');
  assert.equal(store.loadConsumers().some((c) => c.id === 'c1'), false);
  const count = (table: string): number =>
    (getDb().prepare(`SELECT count(*) n FROM ${table} WHERE consumer_id = ?`).get('c1') as { n: number }).n;
  assert.equal(count('lens_watches'), 0, 'watches cascade with the consumer');
  assert.equal(count('lens_events'), 0, 'and so does the event history');
});

test('a broken watch row is skipped, not thrown', () => {
  store.saveConsumer(consumer('broken'));
  getDb()
    .prepare(
      'INSERT INTO lens_watches (user_id, source, id, consumer_id, spec_json, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(alice, 'screen:local', 'bad', 'broken', '{not json', 'regex', 1);
  assert.deepEqual(store.loadConsumers().find((c) => c.id === 'broken')?.watches, []);
});

test('two users and two sources never see each other, even on the same consumer id', () => {
  const mine = sqliteStore(alice, 'terminal:s1', () => ++ticks);
  const theirs = sqliteStore(bob, 'screen:local', () => ++ticks);
  const watch: Watch = { id: 'w9', spec: { regex: 'mine', visual: false, triage: false }, mode: 'regex', createdAt: 5 };

  store.saveConsumer(consumer('conv-7', { cursor: 10 }));
  mine.saveConsumer(consumer('conv-7', { cursor: 20 }));
  theirs.saveConsumer(consumer('conv-7', { cursor: 30 }));
  mine.saveWatches('conv-7', [watch]);
  store.appendEvent('conv-7', delivery(1, { text: 'alice screen' }));
  mine.appendEvent('conv-7', delivery(1, { text: 'alice terminal' }));
  theirs.appendEvent('conv-7', delivery(1, { text: 'bob screen' }));

  assert.equal(store.loadConsumers().find((c) => c.id === 'conv-7')?.cursor, 10);
  assert.equal(mine.loadConsumers().find((c) => c.id === 'conv-7')?.cursor, 20);
  assert.equal(theirs.loadConsumers().find((c) => c.id === 'conv-7')?.cursor, 30);
  assert.deepEqual(store.loadConsumers().find((c) => c.id === 'conv-7')?.watches, [], 'another source’s watches stay there');
  assert.deepEqual(mine.loadConsumers().find((c) => c.id === 'conv-7')?.watches, [watch]);
  assert.deepEqual(store.events('conv-7').map((d) => d.text), ['alice screen']);
  assert.deepEqual(mine.events('conv-7').map((d) => d.text), ['alice terminal']);
  assert.deepEqual(theirs.events('conv-7').map((d) => d.text), ['bob screen']);

  // Deleting one leaves the other two, rows and all.
  mine.deleteConsumer('conv-7');
  assert.equal(mine.loadConsumers().some((c) => c.id === 'conv-7'), false);
  assert.equal(store.loadConsumers().some((c) => c.id === 'conv-7'), true);
  assert.equal(theirs.events('conv-7').length, 1);
});

test('events round trip, page strings survive, and history is trimmed to the cap', () => {
  store.saveConsumer(consumer('c2'));
  store.appendEvent('c2', delivery(1, { kind: 'key', page: '1/3', v: 1, since: null }));
  store.appendEvent('c2', delivery(2, { truncated: true }));

  const both = store.events('c2', undefined, 10);
  assert.deepEqual(both.map((d) => d.delivery), ['c1:1', 'c1:2']);
  assert.deepEqual(both[0], { delivery: 'c1:1', v: 1, since: null, epoch: 7, ref: 'f-7-1', kind: 'key', page: '1/3', text: 'line 1' });
  assert.deepEqual(both[1], { delivery: 'c1:2', v: 2, since: 1, epoch: 7, ref: 'f-7-2', kind: 'delta', truncated: true, text: 'line 2' });

  assert.deepEqual(store.events('c2', 1, 10).map((d) => d.v), [2], 'since is a version');
  assert.deepEqual(store.events('c2', undefined, 1).map((d) => d.v), [2], 'limit keeps the newest');

  for (let n = 3; n <= EVENT_CAP + 100; n++) store.appendEvent('c2', delivery(n));
  const rows = getDb()
    .prepare('SELECT count(*) n, min(v) oldest, max(v) newest FROM lens_events WHERE user_id = ? AND source = ?')
    .get(alice, 'screen:local') as { n: number; oldest: number; newest: number };
  assert.deepEqual(rows, { n: EVENT_CAP, oldest: 101, newest: EVENT_CAP + 100 });
  assert.equal(
    (getDb().prepare('SELECT count(*) n FROM lens_events WHERE user_id = ?').get(bob) as { n: number }).n,
    1,
    'the trim is per (user, source)'
  );
});
