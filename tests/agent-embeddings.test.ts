import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { embed } from '../src/lib/agent/embeddings.ts';
import { parseEmbeddingConfig, embeddingProfile, DEFAULT_EMBEDDING } from '../src/lib/agent/embedding-profiles.ts';
import { embeddingRuntimeStatus } from '../src/lib/agent/embedding-local.ts';

test('embedding config: legacy shapes read as a priority list, invalid lists are refused', () => {
  const legacy = parseEmbeddingConfig({ provider: 'device', device: '2b6a6a7e-1d0e-4b7f-9c1e-3f1b2c4d5e6f' });
  assert.equal(legacy.provider, 'local');
  assert.deepEqual(legacy.runtimes, ['2b6a6a7e-1d0e-4b7f-9c1e-3f1b2c4d5e6f']);
  assert.deepEqual(parseEmbeddingConfig({ provider: 'local' }).runtimes, ['local'], 'an old local row means this runtime');
  assert.deepEqual(parseEmbeddingConfig({ provider: 'local', runtimes: ['server', 'local', 'local'] }).runtimes, ['server', 'local'], 'deduplicated, order kept');
  assert.deepEqual(parseEmbeddingConfig({ provider: 'openai', runtimes: ['local'] }).runtimes, [], 'cloud providers carry no runtime list');
  assert.throws(() => parseEmbeddingConfig({ provider: 'local', runtimes: ['nope'] }), /Runtimes must list/);
  // The vector profile depends on the model variant only, never on which computer served it.
  assert.equal(embeddingProfile(legacy).id, embeddingProfile({ ...DEFAULT_EMBEDDING, runtimes: ['local', 'server'] }).id);
});

test('failover reports every runtime it skipped and why', async () => {
  delete process.env.RIMEWARD_DESKTOP;
  await assert.rejects(embed(1, ['hello'], true, undefined, { ...DEFAULT_EMBEDDING, runtimes: [] }), /No embedding runtime is chosen/);
  // This test runtime has no llama.cpp binary and the device is not paired: both are named, nothing hangs.
  await assert.rejects(embed(1, ['hello'], true, undefined, { ...DEFAULT_EMBEDDING, runtimes: ['local', '2b6a6a7e-1d0e-4b7f-9c1e-3f1b2c4d5e6f'] }),
    /this server: no model set up; an unpaired desktop: Desktop not found/);
});

test('the pinned llama.cpp manifest covers this platform or says so', () => {
  const s = embeddingRuntimeStatus();
  assert.equal(typeof s.version, 'string');
  assert.equal(s.installable, ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].includes(`${process.platform}-${process.arch}`));
});
