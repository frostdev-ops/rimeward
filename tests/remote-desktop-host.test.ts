import './_setup.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { remoteHostAction, approveRemoteSession, pendingRemoteApprovals, stopRemoteHostSessions, requireRimeApproval } from '../src/lib/dev/remote-desktop-host.ts';
import { DEFAULT_REMOTE_POLICY } from '../src/lib/dev/remote-desktop-contract.ts';
import type { RemoteRelayContext } from '../src/lib/dev/devices.ts';
import { invalidateComputerPolicy } from '../src/lib/dev/computer.ts';

process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-private-native-token';
let enabled = true, locked = false, captures = 0, activeTransfers = 0, textPermission = true;
let topology = 1, display = 2;
const calls: { op: string; value: unknown }[] = [];
const jpeg = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#000000' } }).jpeg().toBuffer();
const globals = globalThis as typeof globalThis & { __nativeDesktop?: (op: string, value?: unknown) => Promise<unknown> };
globals.__nativeDesktop = async (op, value) => {
  calls.push({ op, value });
  if (op === 'computer-status') return { enabled, locked, textPermission, suspended: !enabled, supported: true, platform: 'macos', permissions: '', controller: null,
    topology, displays: [{ display, x: -1920, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 }] };
  if (op === 'computer-frame') { captures++; return { image: jpeg.toString('base64'), imageWidth: 32, imageHeight: 20 }; }
  if (op === 'computer-acquire') return { ownership: 2, topology };
  if (op === 'computer-files') return { active: activeTransfers };
  return { sent: true };
};
after(stopRemoteHostSessions);
const grant = (): RemoteRelayContext => ({ protocol: 1, actor: 'a'.repeat(64), session: crypto.randomUUID(), device: crypto.randomUUID(),
  policy: { ...DEFAULT_REMOTE_POLICY }, expires: Date.now() + 30000 });
const request = (context: RemoteRelayContext) => new Request('http://127.0.0.1/api/remote-desktop/host', { method: 'POST', headers: {
  'x-rimeward-native-token': process.env.RIMEWARD_NATIVE_TOKEN!, 'x-rimeward-remote-context': Buffer.from(JSON.stringify(context)).toString('base64url'),
} });
test('host dispatch rejects forged, expired and replayed grants; view frames do not acquire input', async () => {
  const c = grant();
  await assert.rejects(() => remoteHostAction(new Request('http://localhost'), { action: 'connect' }), /Private native/);
  await assert.rejects(() => remoteHostAction(request({ ...c, expires: Date.now() - 1 }), { action: 'connect' }), /Expired/);
  const connected = await remoteHostAction(request(c), { action: 'connect', owner: 'forged', capabilities: ['screen', 'input'] });
  assert.equal((await connected.json()).transport, 'compatibility');
  assert.equal(calls.some(v => v.op === 'computer-acquire'), false);
  await assert.rejects(() => remoteHostAction(request(c), { action: 'connect', capabilities: ['screen'] }), /already used/);
  const image = await remoteHostAction(request(c), { action: 'frame', ack: 0 });
  assert.equal(image.headers.get('x-rimeward-frame'), '1'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal(captures, 1);
  await assert.rejects(() => remoteHostAction(request(c), { action: 'frame', ack: 0 }), /Acknowledge/);
  assert.equal(captures, 1);
  await assert.rejects(() => remoteHostAction(request({ ...c, actor: 'b'.repeat(64) }), { action: 'frame', ack: 1 }), /expired/);
  await remoteHostAction(request(c), { action: 'disconnect' });
  await assert.rejects(() => remoteHostAction(request(c), { action: 'connect', capabilities: ['screen'] }), /closed/);
});
test('local approval, input permission, monitor handoff and local Stop fail closed', async () => {
  const c = grant(); c.policy.connection = 'approval';
  await remoteHostAction(request(c), { action: 'connect', capabilities: ['screen', 'input'] });
  assert.equal(pendingRemoteApprovals()[0]?.id, c.session);
  await assert.rejects(() => remoteHostAction(request(c), { action: 'acquire' }), /Approve/);
  await approveRemoteSession(c.session, true);
  await remoteHostAction(request(c), { action: 'acquire' });
  await assert.rejects(() => remoteHostAction(request(c), { action: 'input', ownership: 1, topology: 1, sequence: 1 }), /Acquire/);
  await remoteHostAction(request(c), { action: 'monitor', display: 2 });
  assert.ok(calls.some(v => v.op === 'computer-release'));
  await remoteHostAction(request(c), { action: 'acquire' });
  enabled = false;
  await assert.rejects(() => remoteHostAction(request(c), { action: 'frame', ack: 0 }), /stopped locally/);
  enabled = true;
  await assert.rejects(() => remoteHostAction(request(c), { action: 'connect', capabilities: ['screen'] }), /closed/);
  const view = grant();
  await remoteHostAction(request(view), { action: 'connect', capabilities: ['screen'] });
  await assert.rejects(() => remoteHostAction(request(view), { action: 'acquire' }), /not allowed/);
  await remoteHostAction(request(view), { action: 'disconnect' });
});
test('clipboard limits, malformed PNG, sync ownership and permission denial', async () => {
  const c = grant();
  await remoteHostAction(request(c), { action: 'connect', capabilities: ['screen', 'clipboard'] });
  await assert.rejects(() => remoteHostAction(request(c), { action: 'clipboard', direction: 'send', mime: 'text/plain', text: 'x'.repeat(1024 * 1024 + 1) }), /1 MiB/);
  await assert.rejects(() => remoteHostAction(request(c), { action: 'clipboard', direction: 'send', mime: 'image/png', data: jpeg.toString('base64') }), /must be PNG/);
  await assert.rejects(() => remoteHostAction(request(c), { action: 'clipboard', direction: 'send', mime: 'text/plain', text: 'text', sync: true }), /current controller/);
  await remoteHostAction(request(c), { action: 'clipboard', direction: 'send', mime: 'text/plain', text: 'explicit exchange' });
  assert.ok(calls.some(v => v.op === 'computer-clipboard'));
  await remoteHostAction(request(c), { action: 'disconnect' });
  const view = grant(); view.policy.clipboard = false;
  await remoteHostAction(request(view), { action: 'connect', capabilities: ['screen', 'clipboard'] });
  await assert.rejects(() => remoteHostAction(request(view), { action: 'clipboard', direction: 'receive', mime: 'text/plain' }), /not allowed/);
  await remoteHostAction(request(view), { action: 'disconnect' });
});

test('unplugging a selected monitor releases input and selects the remaining display', async () => {
  const c = grant();
  try {
    await remoteHostAction(request(c), { action: 'connect', capabilities: ['screen', 'input'] });
    await remoteHostAction(request(c), { action: 'acquire' });
    const released = calls.filter(c => c.op === 'computer-release').length;
    topology++; display = 3;
    const status = await (await remoteHostAction(request(c), { action: 'status' })).json();
    assert.equal(status.display, 3); assert.equal(status.topology, 2);
    assert.equal(calls.filter(c => c.op === 'computer-release').length, released + 1);
    await assert.rejects(() => remoteHostAction(request(c), { action: 'input', ownership: 2, topology: 1, sequence: 1 }), /Acquire control/);
  } finally { topology = 1; display = 2; await remoteHostAction(request(c), { action: 'disconnect' }); }
});

test('account policy notification immediately closes sessions and revokes native ownership', async () => {
  const c = grant();
  await remoteHostAction(request(c), { action: 'connect', capabilities: ['screen', 'input', 'files'] });
  await remoteHostAction(request(c), { action: 'acquire' });
  const before = calls.length;
  await invalidateComputerPolicy();
  assert.ok(calls.slice(before).some(c => c.op === 'computer-revoke'));
  assert.ok(calls.slice(before).some(c => c.op === 'computer-release'));
  assert.ok(calls.slice(before).some(c => c.op === 'computer-files'));
  await assert.rejects(() => remoteHostAction(request(c), { action: 'input', ownership: 2, topology: 1 }), /closed/);
});

test('Rime approval is single-use, revision-bound and cleared by lock or Stop', async () => {
  const owner = 'test-rime-owner';
  assert.throws(() => requireRimeApproval(owner, 1), /Approve Rime/);
  let pending = pendingRemoteApprovals().find(s => s.capabilities.includes('rime'))!;
  await approveRemoteSession(pending.id, true);
  assert.doesNotThrow(() => requireRimeApproval(owner, 1));
  assert.throws(() => requireRimeApproval(owner, 1), /Approve Rime/);
  pending = pendingRemoteApprovals().find(s => s.capabilities.includes('rime'))!;
  await approveRemoteSession(pending.id, true);
  assert.throws(() => requireRimeApproval(owner, 2), /Approve Rime/);
  const context = grant();
  await remoteHostAction(request(context), { action: 'connect', capabilities: ['screen'] });
  locked = true;
  const status = await (await remoteHostAction(request(grant()), { action: 'status' })).json();
  assert.equal(status.state, 'locked');
  assert.ok(Object.values(status.features).every(value => value === false));
  assert.equal(pendingRemoteApprovals().length, 0);
  locked = false;
  await assert.rejects(() => remoteHostAction(request(context), { action: 'connect', capabilities: ['screen'] }), /closed/);
  await stopRemoteHostSessions();
});

test('hidden transfers release viewer slots; returning rechecks the limit and starts without control', async () => {
  const contexts = Array.from({ length: 5 }, grant);
  try {
    activeTransfers = 1; textPermission = false;
    const result = await (await remoteHostAction(request(contexts[0]!), { action: 'connect', capabilities: ['screen', 'input', 'files'] })).json();
    assert.equal(result.features.input, true); assert.equal(result.textInput.available, false);
    await remoteHostAction(request(contexts[0]!), { action: 'acquire' });
    await remoteHostAction(request(contexts[0]!), { action: 'pause' });
    assert.equal((await (await remoteHostAction(request(contexts[0]!), { action: 'detach' })).json()).state, 'transfer-only');
    for (const c of contexts.slice(1)) await remoteHostAction(request(c), { action: 'connect', capabilities: ['screen'] });
    await assert.rejects(() => remoteHostAction(request(contexts[0]!), { action: 'resume' }), /four viewers/);
    await assert.rejects(() => remoteHostAction(request(contexts[0]!), { action: 'acquire' }), /Viewing ended/);
    await remoteHostAction(request(contexts[0]!), { action: 'files', command: 'inspect', id: 'test-transfer' });
    await remoteHostAction(request(contexts[1]!), { action: 'disconnect' });
    await remoteHostAction(request(contexts[0]!), { action: 'resume' });
    await assert.rejects(() => remoteHostAction(request(contexts[0]!), { action: 'input', ownership: 2, topology: 1 }), /Acquire control/);
    activeTransfers = 0;
    await remoteHostAction(request(contexts[0]!), { action: 'pause' });
    assert.equal((await (await remoteHostAction(request(contexts[0]!), { action: 'detach' })).json()).closed, true);
  } finally { activeTransfers = 0; textPermission = true; await stopRemoteHostSessions(); }
});
