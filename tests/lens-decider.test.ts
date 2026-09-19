import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getSetting } from '../src/lib/settings.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { agentWardConfig } from '../src/lib/agent/ward-config.ts';
import { LensCore, systemClock } from '../src/lib/lens/core.ts';
import type { Decider, LensSettings, Source } from '../src/lib/lens/core.ts';
import { deciderFor } from '../src/lib/lens/decider.ts';
import { calibration, calibrationKey, gateDefaults, saveCalibration, watchMode } from '../src/lib/lens/gate.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { trigramVector } from './lens-replay.ts';
import { calibrate } from '../ops/lens-calibrate.ts';
import { helperCapabilities } from '../src/lib/lens/runtime.ts';

let seq = 0;
function seedUser(wards: Record<string, unknown>[] = []): number {
  const email = `decider-${seq++}@x.dev`;
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  if (wards.length > 0) saveDashboard(id, validateLayout(wards as never)!);
  return id;
}

const helperLike = (): Decider => ({
  embedderId: 'helper:mobileclip-s0',
  embed: async (texts) => texts.map(trigramVector),
  triage: async () => ({ yes: true }),
  describe: async () => ({ json: null }),
});

// ------------------------------------------------------------- composition

test('the helper is preferred for embed, triage and describe', () => {
  const user = seedUser();
  const helper = helperLike();
  const composed = deciderFor(user, helper);
  assert.equal(composed.embedderId, 'helper:mobileclip-s0', 'the id follows the embed provider');
  assert.equal(composed.embed, helper.embed);
  assert.equal(composed.triage, helper.triage);
  assert.equal(composed.describe, helper.describe);
  assert.equal(deciderFor(user, helper), composed, 'the same parts compose to the same instance');
});

test('without the helper the local embedder answers, and nothing describes', () => {
  const user = seedUser();
  const composed = deciderFor(user);
  assert.ok(composed.embedderId?.startsWith('local:'), `local embedder id, got ${composed.embedderId}`);
  assert.ok(composed.embed, 'the local embedder is the embed path');
  assert.equal(composed.triage, undefined, 'no on-device triage without the helper (D2 adds the local one)');
  assert.equal(composed.describe, undefined, 'describe is the helper alone');
});

test('cloud triage is composed only when an agent ward turned it on', () => {
  const off = seedUser([{ i: 'ag1', type: 'agent', size: '2x2', config: {} }]);
  assert.equal(deciderFor(off).cloudTriage, undefined, 'off by default');

  const on = seedUser([{ i: 'ag1', type: 'agent', size: '2x2', config: { lensCloudTriage: true } }]);
  assert.ok(deciderFor(on).cloudTriage, 'the switch is what composes it');
  // The switch is the ward's, so turning it off takes the path away again.
  saveDashboard(on, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: {} }] as never)!);
  assert.equal(deciderFor(on).cloudTriage, undefined);
});

test('the agent ward config parses and validates the switch', () => {
  const user = seedUser([
    { i: 'ag1', type: 'agent', size: '2x2', config: { lensCloudTriage: true } },
    { i: 'ag2', type: 'agent', size: '2x2', config: { lensCloudTriage: 'yes' } },
  ]);
  assert.equal(agentWardConfig(user, 'ag1')?.lensCloudTriage, true);
  assert.equal(agentWardConfig(user, 'ag2')?.lensCloudTriage, undefined, 'only a real true is stored');
});

// ------------------------------------------------------------- calibration

test('an unmeasured embedder is missing, a stored row is not', () => {
  assert.equal(calibration('local:never-measured').missing, true);
  assert.equal(calibration('helper:mobileclip-s0').missing, false, 'the helper is seeded from the file');
  assert.equal(calibration().missing, false, 'a decider that names no embedder keeps the fallback numbers');

  saveCalibration('local:measured', { forThreshold: 0.72, visualThreshold: 0.2, liveThreshold: 0.06, score: 'template' });
  const cal = calibration('local:measured');
  assert.deepEqual(
    { ...cal },
    { forThreshold: 0.72, visualThreshold: 0.2, liveThreshold: 0.06, score: 'template', missing: false }
  );
  assert.equal(gateDefaults({ embedderId: 'local:measured' }).forThreshold, 0.72);
  assert.equal(gateDefaults({ embedderId: 'local:never-measured' }).calibrated, false);
});

function coreFor(user: number, decider: Decider): LensCore {
  const source: Source = { connect: async () => () => {} };
  return new LensCore({
    user,
    target: 't1',
    source,
    clock: systemClock,
    store: sqliteStore(user, 'terminal:t1'),
    settings: (): LensSettings => ({ settleMs: 750, minLines: 1 }),
    decider,
  });
}

test('a `for` watch on an uncalibrated embedder runs triage-only, and says so', async () => {
  const user = seedUser();
  const embedder: Decider = {
    embedderId: 'local:uncalibrated',
    embed: async (texts) => texts.map(trigramVector),
    triage: async () => ({ yes: true }),
  };
  const core = coreFor(user, embedder);
  const out = await core.watch('conv-1', { add: [{ for: 'a build error appeared', visual: false, triage: true }] });
  assert.equal(out.watches[0]!.mode, 'triage-only');
  assert.equal(out.watches[0]!.calibration, 'missing');
  assert.match(out.calibrate ?? '', /ops\/lens-calibrate\.ts --user \d+/);

  // The same watch, once the embedder has been measured: the cosine is allowed,
  // and the reply says the threshold was measured rather than leaving a
  // calibrated watch and a fallback one looking the same.
  saveCalibration('local:uncalibrated', { forThreshold: 0.6, visualThreshold: 0.15, liveThreshold: 0.05, score: 'raw' });
  const after = await core.watch('conv-1');
  assert.equal(after.watches[0]!.mode, 'for');
  assert.equal(after.watches[0]!.calibration, 'measured');
  assert.equal(after.calibrate, undefined);
});

test('without triage an uncalibrated `for` watch is unavailable', async () => {
  const user = seedUser();
  const core = coreFor(user, {
    embedderId: 'local:alone',
    embed: async (texts) => texts.map(trigramVector),
  });
  const out = await core.watch('conv-1', { add: [{ for: 'a build error appeared', visual: false, triage: true }] });
  assert.equal(out.watches[0]!.mode, 'unavailable');
  assert.equal(out.watches[0]!.evaluation, 'unavailable');
  assert.equal(out.watches[0]!.calibration, 'missing');
});

test('watchMode reads an uncalibrated embedder as no embedder', () => {
  const spec = { for: 'a build error appeared', visual: false, triage: true };
  assert.equal(watchMode(spec, { embed: true, triage: true, describe: false, cloud: false }), 'for');
  assert.equal(watchMode(spec, { embed: false, triage: true, describe: false, cloud: false }), 'triage-only');
  assert.equal(watchMode(spec, { embed: false, triage: false, describe: false, cloud: true }), 'triage-only');
  assert.equal(watchMode(spec, { embed: false, triage: false, describe: false, cloud: false }), 'unavailable');
});

test('the calibrate script measures whatever embeds and writes that embedder’s row', async () => {
  const user = seedUser();
  await calibrate(user, { embedderId: 'fake:trigram', embed: async (texts) => texts.map(trigramVector) });
  const row = JSON.parse(getSetting(calibrationKey('fake:trigram')) ?? 'null') as Record<string, unknown>;
  assert.ok(row, 'the row is the whole output');
  assert.equal(typeof row.forThreshold, 'number');
  assert.ok((row.forThreshold as number) >= 0.5 && (row.forThreshold as number) <= 0.98);
  // The FN <= 5 % rule only binds when the embedder can actually separate the
  // corpus; a trigram stand-in cannot, so the scan falls back to its best FN
  // and the row still records what it measured.
  assert.equal(typeof row.fn, 'number');
  assert.equal(row.n, 2616);
  assert.equal(calibration('fake:trigram').missing, false);
});

// A status read that failed is not an answer. Only an explicit reply takes the
// helper away: a dropped tunnel (`nativeDesktop` throwing, which `syncDecider`
// catches into null) would otherwise disarm every `for` watch on the machine.
test('the helper is only removed by a status reply that says so', () => {
  assert.equal(helperCapabilities(null), null, 'a failed read');
  assert.equal(helperCapabilities(undefined), null);
  assert.equal(helperCapabilities('nope'), null);
  assert.equal(helperCapabilities({ state: 'running' }), null, 'a reply with no capabilities at all');
  assert.deepEqual(helperCapabilities({ capabilities: { embed: true } }), { embed: true });
  assert.deepEqual(helperCapabilities({ capabilities: { embed: false } }), { embed: false });
  assert.deepEqual(helperCapabilities({ capabilities: {} }), { embed: false }, 'a helper that cannot embed');
});
