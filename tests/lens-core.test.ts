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

/** A core with no source of its own: the decider is what these tests move. */
function bare(email: string, decider?: Parameters<LensCore['setDecider']>[0]) {
  const user = createUser(email, 'pw-bare-123456');
  const clock = new FakeClock(1_000_000);
  const source: Source = { async connect(_u, _t, _f) { return () => {}; } };
  return new LensCore({
    user, target: 'x', source, clock,
    store: { ...sqliteStore(user, `bare:${user}`, () => clock.now()), loadConsumers: () => [] },
    settings: () => ({ settleMs: 750, minLines: 1 }),
    ...(decider ? { decider } : {}),
  });
}

test('a change of embedder re-embeds every stored watch; the same one never does', async () => {
  const counted = (embedderId: string, dims: number) => {
    const calls: string[][] = [];
    return {
      calls,
      decider: {
        embedderId,
        embed: async (texts: string[]) => {
          calls.push(texts);
          return texts.map(() => new Array<number>(dims).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
        },
        triage: async () => ({ yes: true }),
      },
    };
  };
  const helper = counted('helper-clip', 3);
  const local = counted('local-qwen', 4);

  const core = bare('f4@example.com', helper.decider);
  await core.watch('c', { add: [{ for: 'a failing build', visual: false, triage: true }] });
  assert.equal(helper.calls.length, 1, 'the helper embedded it');

  // The helper goes down. Nothing re-embeds: its vectors are still its own.
  await core.setDecider();
  assert.equal(helper.calls.length, 1);

  // A different embedder takes over: a vector from another space means nothing,
  // so every stored watch is embedded again.
  await core.setDecider(local.decider);
  assert.equal(local.calls.length, 1, 'the new embedder embedded the stored watch');
  assert.deepEqual(local.calls[0], helper.calls[0], 'the same watch text');

  // Another instance of the SAME embedder is not a change of space.
  const again = counted('local-qwen', 4);
  await core.setDecider(again.decider);
  assert.equal(again.calls.length, 0, 'the stored vectors are still this embedder\'s');

  // And back to the helper: its own vectors are gone, so it embeds again.
  await core.setDecider(helper.decider);
  assert.equal(helper.calls.length, 2);
  assert.equal(core.status().consumers[0]?.watches, 1, 'through all of it, one watch and one cursor');
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
  // can no longer be evaluated. The vector it already has is not a capability —
  // nothing can embed the NEXT line to score against it — so a `for` watch
  // reports `unavailable` rather than reading as one that still works.
  await core.setDecider();
  const gone = await core.watch('c');
  assert.equal(gone.watches[0]?.mode, 'unavailable', JSON.stringify(gone.watches[0]));
  assert.equal(gone.watches[0]?.evaluation, 'unavailable');
  assert.equal(core.status().consumers[0]?.watches, 1);
  core.close();
});
