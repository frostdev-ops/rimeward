import './_setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createUser } from '../src/lib/users.ts';
import { createSession, destroySession } from '../src/lib/auth.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { getDb } from '../src/lib/db.ts';
import { enroll, claimEnrollment, allowedRelayPath } from '../src/lib/dev/devices.ts';
import { authorizeDevice, saveDevicePolicy } from '../src/lib/dev/remote-desktop-policy.ts';
import { DEFAULT_REMOTE_POLICY, requireRemoteLayoutVersion, parseRemotePolicy } from '../src/lib/dev/remote-desktop-contract.ts';
import { createRemoteSession, remoteCapabilities, remoteSessionAction, remoteDesktopMetrics } from '../src/lib/dev/remote-desktop.ts';
import { mergeInstance, wardDevice } from '../src/lib/dev/instance.ts';
import { csrfBlocked } from '../src/lib/csrf.ts';
import { ALL as harness } from '../src/pages/api/devices/harness/[...action].ts';
import { relayAgentCaller } from '../src/lib/dev/tool-routing.ts';

test('remote desktop deployment routes retain relay privacy and backpressure settings', () => {
  const nginx = readFileSync(new URL('../ops/runtime-relay.nginx.conf', import.meta.url), 'utf8');
  const routes = [...nginx.matchAll(/location ~ (\S+) \{([^}]+)\}/g)];
  const route = routes.find(([, pattern]) => new RegExp(pattern).test('/api/remote-desktop/sessions'));
  assert.ok(route, 'remote desktop requests need a streaming proxy location');
  for (const setting of ['proxy_buffering off;', 'proxy_request_buffering off;', 'proxy_cache off;', 'proxy_max_temp_file_size 0;', 'access_log off;', 'error_log /dev/null crit;'])
    assert.ok(route[2].includes(setting), setting);
  const rulesets = JSON.parse(readFileSync(new URL('../ops/cloudflare-relay.json', import.meta.url), 'utf8'));
  for (const ruleset of rulesets) for (const rule of ruleset.rules)
    assert.ok(rule.expression.includes('starts_with(http.request.uri.path, "/api/remote-desktop/")'));
});

test('owner authorization, capability categories and policy compare-and-swap', () => {
  const user = createUser('remote-policy@example.com', null), other = createUser('remote-policy-other@example.com', null);
  const pair = claimEnrollment(enroll(user).code, 'Test host', 'darwin', 1);
  assert.deepEqual(authorizeDevice(user, pair.id, 'connect'), DEFAULT_REMOTE_POLICY);
  for (const operation of ['status', 'configure', 'connect', 'view', 'control', 'rime', 'clipboard', 'transfer', 'audio'] as const)
    assert.throws(() => authorizeDevice(other, pair.id, operation), /not found/);
  const policy = saveDevicePolicy(user, pair.id, { ...DEFAULT_REMOTE_POLICY, input: false, files: false, owner: other });
  assert.equal(policy.revision, 1); assert.equal('owner' in policy, false);
  assert.throws(() => authorizeDevice(user, pair.id, 'control'), /disabled/);
  assert.throws(() => authorizeDevice(user, pair.id, 'transfer'), /disabled/);
  assert.doesNotThrow(() => authorizeDevice(user, pair.id, 'view'));
  assert.throws(() => saveDevicePolicy(user, pair.id, DEFAULT_REMOTE_POLICY), /changed/);
  saveDevicePolicy(user, pair.id, { ...policy, connection: 'disabled' });
  assert.throws(() => authorizeDevice(user, pair.id, 'connect'), /disabled/);
  assert.doesNotThrow(() => authorizeDevice(user, pair.id, 'configure'));
  for (const bad of [null, [], {}, { ...DEFAULT_REMOTE_POLICY, screen: 'true' }, { ...DEFAULT_REMOTE_POLICY, revision: -1 }])
    assert.throws(() => parseRemotePolicy(bad));
});

test('private dispatch cannot be reached by public relay routing, including encoded paths', () => {
  assert.equal(allowedRelayPath('/api/dev/agent-tools'), false);
  assert.equal(allowedRelayPath('/api/dev/agent-tools', false, true), true);
  for (const path of ['/api/remote-desktop/host', '/api/remote-desktop/sessions', '/api/remote-desktop/%68ost'])
    assert.equal(allowedRelayPath(path), false);
  assert.equal(allowedRelayPath('/api/remote-desktop/host', true), true);
  assert.equal(allowedRelayPath('/api/remote-desktop/sessions', true), false);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal(csrfBlocked(new Request('https://rime.example/api/remote-desktop/sessions', {
    method, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
  })), true);
});

test('agent relay source comes from the paired session and owned ward, never caller JSON', async () => {
  const user = createUser('agent-source@example.com', null), other = createUser('agent-source-other@example.com', null);
  const device = claimEnrollment(enroll(user).code, 'Source desktop', 'darwin', 1), session = createSession(user);
  getDb().prepare('INSERT INTO device_sessions(device_id,session_id) VALUES(?,?)').run(device.id, session.id);
  saveDashboard(user, [{ i: 'rime-source', type: 'agent', size: '3x2', device: device.id }, { i: 'server-agent', type: 'agent', size: '3x2' }]);
  const request = (ward: string) => new Request('https://rime.example/api/dev/agent-tools', { method: 'POST', body: JSON.stringify({ ward, caller: 'f'.repeat(64) }) });
  assert.equal(await relayAgentCaller(user, session.id, request('rime-source')), createHash('sha256').update(`${device.id}:rime-source`).digest('hex'));
  await assert.rejects(() => relayAgentCaller(user, session.id, request('server-agent')), /source must match/);
  await assert.rejects(() => relayAgentCaller(user, createSession(user).id, request('rime-source')), /source must match/);
  await assert.rejects(() => relayAgentCaller(other, session.id, request('rime-source')), /Sign in/);
  destroySession(session.id);
  await assert.rejects(() => relayAgentCaller(user, session.id, request('rime-source')), /Sign in/);
});

test('session IDs are not bearer credentials and a client-supplied account is ignored', async () => {
  const user = createUser('remote-viewer@example.com', null), other = createUser('remote-viewer-other@example.com', null);
  const pair = claimEnrollment(enroll(user).code, 'Test host', 'darwin', 1), auth = createSession(user);
  await assert.rejects(() => remoteCapabilities(other, auth.id, pair.id), /Sign in/);
  await assert.rejects(() => createRemoteSession(other, createSession(other).id, {
    protocol: 1, device: pair.id, ward: 'rd', owner: user, capabilities: ['screen'],
  }), /not found/);
  await assert.rejects(() => createRemoteSession(user, auth.id, {
    protocol: 1, device: pair.id, ward: 'missing', capabilities: ['screen'],
  }), /target changed/);
  await assert.rejects(() => remoteSessionAction(user, auth.id, crypto.randomUUID(), { action: 'acquire' }), /not found/);
  destroySession(auth.id);
  await assert.rejects(() => remoteCapabilities(user, auth.id, pair.id), /Sign in/);
});

test('old sync reads and writes receive an upgrade requirement before changing stored layout', async () => {
  const user = createUser('remote-layout@example.com', null), pair = claimEnrollment(enroll(user).code, 'Test host', 'darwin', 1);
  const layout = [{ i: 'rd', type: 'remote-desktop', size: '6x4' as const, device: pair.id }];
  saveDashboard(user, layout);
  const before = JSON.stringify(getDashboard(user));
  for (const method of ['GET', 'POST']) {
    const request = new Request('https://rime.example/api/devices/harness', { method,
      headers: { authorization: `Bearer ${pair.token}` }, ...(method === 'POST' ? { body: JSON.stringify({ record: { key: 'instance/dashboard', payload: '{}' } }) } : {}) });
    const response = await harness({ params: {}, request, url: new URL(request.url), locals: {} } as Parameters<typeof harness>[0]);
    assert.equal(response.status, 426);
    assert.match((await response.json()).error, /preserved/);
    assert.equal(JSON.stringify(getDashboard(user)), before);
  }
  assert.throws(() => requireRemoteLayoutVersion(layout, null));
  assert.doesNotThrow(() => requireRemoteLayoutVersion(layout, '1'));
  assert.doesNotThrow(() => requireRemoteLayoutVersion([{ type: 'agent' }], null));
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM remote_desktop_audit').get() && true, true);
});

test('page moves and joining an account preserve the explicitly selected remote target', () => {
  const user = createUser('remote-placement@example.com', null), target = crypto.randomUUID(), pageDevice = crypto.randomUUID();
  const pages = [{ id: 'home', title: 'Home', device: pageDevice }];
  saveDashboard(user, [{ i: 'rd', type: 'remote-desktop', size: '6x4' }], pages);
  assert.equal(wardDevice(user, 'rd'), undefined);
  saveDashboard(user, [{ i: 'rd', type: 'remote-desktop', size: '6x4', device: target }], pages);
  assert.equal(wardDevice(user, 'rd'), target);
  const local = { layout: getDashboard(user), pages, theme: null, name: 'Local' };
  const server = { layout: [{ i: 'note', type: 'note', size: '2x2' as const }], pages: [{ id: 'home', title: 'Home' }], theme: null, name: 'Shared' };
  assert.equal(mergeInstance(server, local, pageDevice).dashboard.layout.find(w => w.i === 'rd')?.device, target);
});

test('TURN credentials expire quickly, bind the account/session and keep the shared secret server-side', async () => {
  const { remoteTurn } = await import('../src/lib/dev/remote-turn.ts');
  const { createHmac } = await import('node:crypto');
  delete process.env.RIMEWARD_TURN_SECRET;
  assert.equal(remoteTurn(1, 'a').available, false);
  const secret = 'test-only-turn-secret-32-characters'; process.env.RIMEWARD_TURN_SECRET = secret;
  try {
    const result = remoteTurn(1, 'a'), server = result.iceServers[0];
    const expires = Number(server.username.split(':')[0]);
    assert.ok(expires > Date.now() / 1000 && expires <= Date.now() / 1000 + 301);
    assert.equal(server.credential, createHmac('sha1', secret).update(server.username).digest('base64'));
    assert.notEqual(remoteTurn(2, 'a').iceServers[0].username, server.username);
    assert.notEqual(remoteTurn(1, 'b').iceServers[0].username, server.username);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(server.urls.every(url => /^turns?:turn\.frostdev\.io:/.test(url)));
  } finally { delete process.env.RIMEWARD_TURN_SECRET; }
});

test('operational counters are owner-scoped, retain no contents and exclude expired audit rows', () => {
  const user = createUser('remote-metrics@example.com', null), other = createUser('remote-metrics-other@example.com', null);
  const insert = getDb().prepare('INSERT INTO remote_desktop_audit(id,user_id,device_id,actor,started_at,ended_at,capabilities,relay_bytes,media_bytes,rtt_ms_sum,rtt_samples,webrtc_failures,termination_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(crypto.randomUUID(), user, 'test-device', 'test-actor', Date.now(), Date.now(), '["screen"]', 1024, 4096, 120, 2, 1, 'viewer_disconnected');
  insert.run(crypto.randomUUID(), other, 'other-device', 'other-actor', Date.now(), Date.now(), '["screen"]', 9999, 9999, 5000, 1, 8, 'connection_failed');
  insert.run(crypto.randomUUID(), user, 'old-device', 'test-actor', Date.now() - 31 * 86400000, Date.now(), '["screen"]', 9999, 9999, 5000, 1, 8, 'connection_failed');
  assert.deepEqual(remoteDesktopMetrics(user), { sessions: 1, active: 0, connectionFailures: 0, webRtcFailures: 1, relayBytes: 1024, reportedMediaBytes: 4096, reportedMeanRttMs: 60 });
});
