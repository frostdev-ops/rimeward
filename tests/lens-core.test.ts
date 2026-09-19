import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LensCore } from '../src/lib/lens/core.ts';
import type { Feed, Source } from '../src/lib/lens/core.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { createUser } from '../src/lib/users.ts';
import { FakeClock } from './fake-clock.ts';

// The fixtures all drive a source with a `keyframeOn` header; this is the
// other half of the epoch contract.
test('an epoch with no keyframeOn header still publishes one keyframe', async () => {
  const user = createUser('f2@example.com', 'pw-f2-123456');
  const clock = new FakeClock(1_000_000);
  let feed: Feed | null = null;
  const source: Source = {
    // no keyframeOn at all
    async connect(_u, _t, f) { feed = f; return () => {}; },
  };
  const core = new LensCore({
    user, target: 'x', source, clock,
    store: { ...sqliteStore(user, 'f2:x', () => clock.now()), loadConsumers: () => [] },
    settings: () => ({ settleMs: 750, minLines: 1 }),
  });
  const seen: string[] = [];
  core.on('delivery', (_id, d) => seen.push(`${d.kind} v=${d.v} ${d.text.split('\n').length} rows`));
  core.consumer('c');
  const wire = feed as Feed | null;
  assert.ok(wire, 'connected');
  wire.epoch(1, 1);
  wire.meta('title', 'a shell', 1);
  wire.replace([{ text: 'hello', src: 'x' }, { text: 'there', src: 'x' }], 1);
  assert.deepEqual(seen, [], 'nothing before the turn ends');
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1, `one keyframe, got ${JSON.stringify(seen)}`);
  assert.match(seen[0]!, /^key /);
  assert.equal(core.doc().lines.length, 2);
  core.close();
});

// A helper arriving (or going down) must not cost a core its cursors, so the
// decider is swapped on the live core and the stored watches are re-scored.
test('setDecider re-scores stored watches, in both directions, once per change', async () => {
  const user = createUser('f3@example.com', 'pw-f3-123456');
  const clock = new FakeClock(1_000_000);
  const source: Source = { async connect(_u, _t, _f) { return () => {}; } };
  const core = new LensCore({
    user, target: 'x', source, clock,
    store: { ...sqliteStore(user, 'f3:x', () => clock.now()), loadConsumers: () => [] },
    settings: () => ({ settleMs: 750, minLines: 1 }),
  });

  // Nothing can embed a `for` watch, so nothing can evaluate it: it is
  // registered and reports that it will deliver nothing.
  const first = await core.watch('c', { add: [{ for: 'a failing build', visual: false, triage: true }] });
  assert.equal(first.watches[0]?.mode, 'unavailable');
  assert.equal(first.watches[0]?.evaluation, 'unavailable');

  let embedded = 0;
  const fake = {
    embedderId: 'test-embedder',
    embed: async (texts: string[]) => {
      embedded += texts.length;
      return texts.map(() => [1, 0, 0]);
    },
    triage: async () => ({ yes: true }),
  };
  await core.setDecider(fake);
  assert.equal(embedded, 1, 'the stored watch was embedded once');
  const after = core.status().consumers[0];
  assert.equal(after?.watches, 1, 'the consumer kept its watch and its cursor');
  const scored = await core.watch('c');
  // Which path it lands on is the gate's business (embedding, triage, or both,
  // depending on what this embedder is calibrated for); what the swap owes is
  // that the watch can now be evaluated at all.
  assert.notEqual(scored.watches[0]?.mode, 'unavailable');
  assert.equal(scored.watches[0]?.evaluation, undefined, 'a path that can evaluate reports nothing');
  assert.equal(embedded, 1, 'an embedded watch is not embedded again');

  // The same instance is not a change: no re-sweep.
  await core.setDecider(fake);
  assert.equal(embedded, 1, 'the identity guard skips a re-sweep');

  // The helper goes down: the watch is still there, and says out loud that it
  // is degraded — `unavailable` if nothing is left to judge it, `weak` if all
  // that survives is the similarity of the vector it already has.
  await core.setDecider();
  const gone = await core.watch('c');
  assert.ok(gone.watches[0]?.evaluation !== undefined, `degraded, got ${JSON.stringify(gone.watches[0])}`);
  assert.equal(core.status().consumers[0]?.watches, 1);
  core.close();
});
