import './_setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFailure } from '../src/lib/agent/diagnostics.ts';
import { getSetting } from '../src/lib/settings.ts';

test('model diagnostics distinguish causes, preserve references and exclude payloads', () => {
  for (const [error, aborted, category] of [
    [Object.assign(new Error('secret payload'), { status: 503 }), false, 'provider-unavailable'],
    [Object.assign(new Error('secret payload'), { name: 'TimeoutError' }), false, 'timeout'],
    [new Error('secret payload'), false, 'connection-lost'],
    [new Error('secret payload'), true, 'cancelled'],
  ] as const) {
    const failure = modelFailure(1, error, 'test-reference', aborted);
    assert.equal(failure.category, category);
    assert.match(failure.message, /test-reference/);
  }
  for (let i = 0; i < 105; i++) modelFailure(1, new Error('secret payload'));
  const saved = getSetting('agent_diagnostics:1')!;
  assert.equal(JSON.parse(saved).length, 100);
  assert.doesNotMatch(saved, /secret payload/);
});
