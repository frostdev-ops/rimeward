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
