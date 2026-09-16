import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { APIContext } from 'astro';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { activeConversation, activeConversationRow, addMessage, childConversation, copyTranscript, getConversation, stampConversationOwner, transcript } from '../src/lib/agent/conversations.ts';
import { setBusyForTest } from '../src/lib/agent/core.ts';
import { mergeInstance, moveLocalWardState } from '../src/lib/dev/instance.ts';
import { agentDirectoryAction, agentPlacement, agentPlacementAction, assertAgentRunsHere, newAgentConversation, recordLegacyAgentPlacement, remapLocalAgentRuntime, routeAgentPlacement } from '../src/lib/dev/agent-placement.ts';

function fixture() {
  const user = Number(getDb().prepare("INSERT INTO users(email,password_hash,role) VALUES(?,'x','admin')").run(`${randomUUID()}@placement.test`).lastInsertRowid);
  const layout = validateLayout([{ i: 'agent', type: 'agent', size: '2x4' }]); assert.ok(layout); saveDashboard(user, layout);
  const conv = activeConversation(user, 'agent', 'codex'); stampConversationOwner(conv.id, 'server');
  addMessage(conv, { role: 'user', text: 'Preserve this original conversation.' });
  return { user, conv };
}

test('fresh conversation preserves its predecessor and replaying the request creates nothing', async () => {
  const { user, conv } = fixture(), idempotencyKey = randomUUID();
  const input = { ward: 'agent', idempotencyKey, expectedConversation: conv.id, expectedOwnerRuntimeId: 'server' };
  const created = await newAgentConversation(user, input);
  assert.notEqual(created.conversation, conv.id); assert.equal(created.ownerRuntimeId, 'server');
  assert.equal(getConversation(conv.id)?.active, 0); assert.equal(transcript(conv.id)[0]?.text, 'Preserve this original conversation.');
  assert.equal(getConversation(created.conversation)?.owner_runtime_id, 'server');
  assert.deepEqual(await newAgentConversation(user, input), created);
  assert.equal(activeConversationRow(user, 'agent')?.id, created.conversation);
});

test('active work and stale New chat requests cannot create a second writer', async () => {
  const { user, conv } = fixture(); setBusyForTest(user, 'agent', true);
  await assert.rejects(newAgentConversation(user, { ward: 'agent', idempotencyKey: randomUUID(), expectedConversation: conv.id }), /Finish the active response/);
  setBusyForTest(user, 'agent', false);
  const results = await Promise.allSettled([1, 2].map(() => newAgentConversation(user, { ward: 'agent', idempotencyKey: randomUUID(), expectedConversation: conv.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM agent_conversations WHERE user_id=? AND ward=? AND active=1').get(user, 'agent') as { n: number }).n, 1);
});

test('a run admitted after the idle snapshot prevents retirement in the final transaction', async t => {
  const { user, conv } = fixture(), db = getDb(), prepare = db.prepare;
  let armed = true;
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare.call(db, sql);
    if (sql.includes('SELECT * FROM agent_conversations WHERE user_id = ? AND ward = ? AND active = 1')) {
      const get = statement.get.bind(statement) as (...args: unknown[]) => unknown;
      t.mock.method(statement, 'get', (...args: unknown[]) => {
        const row = get(...args);
        if (armed && args[0] === user) { armed = false; queueMicrotask(() => setBusyForTest(user, 'agent', true)); }
        return row;
      });
    }
    return statement;
  });
  try {
    await assert.rejects(newAgentConversation(user, { ward: 'agent', idempotencyKey: randomUUID(), expectedConversation: conv.id }), /Finish the active response/);
    assert.equal(getConversation(conv.id)?.active, 1);
    assert.equal(activeConversationRow(user, 'agent')?.id, conv.id);
  } finally { setBusyForTest(user, 'agent', false); }
});

test('retirement blocks unknown transitions; confirmed forwarding refuses a stale local wake', async () => {
  const { user, conv } = fixture(), target = randomUUID(), idempotencyKey = randomUUID();
  const retired = await agentPlacementAction(user, { action: 'retire', ward: 'agent', idempotencyKey, expectedConversation: conv.id, targetRuntimeId: target });
  assert.equal(retired.phase, 'retired'); assert.equal(activeConversationRow(user, 'agent'), null);
  await assert.rejects(assertAgentRunsHere(user, 'agent'), /being reconciled/);
  const request = new Request('https://rimeward.invalid/api/agent/agent');
  const blocked = await routeAgentPlacement({ locals: { user: { userId: user } }, request, url: new URL(request.url) } as APIContext, 'agent');
  assert.equal(blocked?.status, 409);
  assert.deepEqual(await agentPlacementAction(user, { action: 'retire', ward: 'agent', idempotencyKey, expectedConversation: conv.id, targetRuntimeId: target }), retired);
  await agentPlacementAction(user, { action: 'complete', ward: 'agent', idempotencyKey, targetRuntimeId: target, conversation: 100 });
  await assert.rejects(assertAgentRunsHere(user, 'agent'), /original runtime must handle/);
  assert.equal(activeConversationRow(user, 'agent'), null);
});

test('history copies acquire their own owner; migration never overwrites an established owner', () => {
  const { user, conv } = fixture(), copy = childConversation(user, 'agent', 'codex', null, randomUUID());
  copyTranscript(conv.id, copy.id); assert.equal(getConversation(copy.id)?.owner_runtime_id, null);
  stampConversationOwner(copy.id, 'another-runtime');
  assert.equal(getConversation(conv.id)?.owner_runtime_id, 'server');
  assert.throws(() => stampConversationOwner(conv.id, 'another-runtime'), /cannot change/);
  recordLegacyAgentPlacement(user, 'agent', 'server'); recordLegacyAgentPlacement(user, 'agent', randomUUID());
  assert.equal((getDb().prepare('SELECT runtime_id FROM agent_placements WHERE user_id=? AND ward=?').get(user, 'agent') as { runtime_id: string }).runtime_id, 'server');
});

test('a trusted pairing alias changes routing without rewriting conversation ownership', () => {
  const { user } = fixture(), oldRuntime = randomUUID(), pairedRuntime = randomUUID();
  const child = childConversation(user, 'agent', 'codex', null, randomUUID());
  stampConversationOwner(child.id, oldRuntime);
  remapLocalAgentRuntime(user, oldRuntime, pairedRuntime);
  assert.doesNotThrow(() => stampConversationOwner(child.id, pairedRuntime));
  assert.equal(getConversation(child.id)?.owner_runtime_id, oldRuntime);
  assert.throws(() => stampConversationOwner(child.id, randomUUID()), /cannot change/);
});

test('pairing remaps Workspace references and its local route without copying roots', () => {
  const own = randomUUID(), device = randomUUID(), remote = randomUUID();
  const server = { name: 'Server', theme: null, pages: [{ id: 'home', title: 'Home' }], layout: [{ i: 'space', type: 'note', size: '2x2' as const }] };
  const local = { ...server, layout: [
    { i: 'space', type: 'workspace', size: '3x3' as const, config: { workspaceId: 'stable-workspace', revision: 1, mounts: [{ id: 'primary', mountPath: '/', runtimeId: own, rootId: 'same-root' }, { id: 'data', mountPath: '/data', runtimeId: remote, rootId: 'remote-root' }] } },
    { i: 'editor', type: 'editor', size: '3x3' as const, workspace: 'space' },
  ] };
  const result = mergeInstance(server, local, device, new Set(), own);
  const workspace = result.dashboard.layout.find(w => w.type === 'workspace'); assert.ok(workspace);
  assert.notEqual(workspace.i, 'space'); assert.equal(result.dashboard.layout.find(w => w.i === 'editor')?.workspace, workspace.i);
  const config = workspace.config as { revision: number; workspaceId: string; mounts: { runtimeId: string; rootId: string }[] };
  assert.equal(config.revision, 2); assert.equal(config.workspaceId, 'stable-workspace');
  assert.deepEqual(config.mounts.map(m => [m.runtimeId, m.rootId]), [[device, 'same-root'], [remote, 'remote-root']]);
});

test('pairing refuses to rekey a running agent before changing any stored identity', async () => {
  const { user, conv } = fixture(); setBusyForTest(user, 'agent', true);
  try { await assert.rejects(moveLocalWardState(user, new Map([['agent', 'paired-agent']])), /Finish active agent work/); }
  finally { setBusyForTest(user, 'agent', false); }
  assert.equal(getConversation(conv.id)?.ward, 'agent');
});

test('the canonical directory replaces stale foreign hints only after a confirmed transition', async () => {
  const { user, conv } = fixture(), target = randomUUID(), idempotencyKey = randomUUID(), db = getDb();
  db.prepare("INSERT INTO devices(id,user_id,name,platform,protocol,token_hash) VALUES(?,?,'Another computer','darwin',1,'fixture')").run(target, user);
  await agentPlacementAction(user, { action: 'retire', ward: 'agent', idempotencyKey, expectedConversation: conv.id, targetRuntimeId: target });
  await assert.rejects(agentDirectoryAction(user, { action: 'directory-publish', ward: 'agent', idempotencyKey, sourceRuntimeId: 'server' }), /has not confirmed/);
  assert.equal((await agentDirectoryAction(user, { action: 'directory-read', ward: 'agent' })).runtime_id, 'server');
  await agentPlacementAction(user, { action: 'complete', ward: 'agent', idempotencyKey, targetRuntimeId: target, conversation: 100 });
  const directory = await agentDirectoryAction(user, { action: 'directory-publish', ward: 'agent', idempotencyKey, sourceRuntimeId: 'server' });
  assert.equal(directory.runtime_id, target); assert.equal(directory.version, 2);
  assert.deepEqual(await agentDirectoryAction(user, { action: 'directory-publish', ward: 'agent', idempotencyKey, sourceRuntimeId: 'server' }), directory);
  db.prepare('UPDATE agent_placements SET runtime_id=?,directory_version=1 WHERE user_id=? AND ward=?').run(randomUUID(), user, 'agent');
  assert.equal((await agentPlacement(user, 'agent')).runtime_id, target, 'a third viewer discards its stale foreign-owner hint');
  const request = new Request('https://rimeward.invalid/api/agent/agent');
  await assert.rejects(routeAgentPlacement({ locals: { user: { userId: user } }, request, url: new URL(request.url) } as APIContext, 'agent'), /offline/);
  assert.equal(activeConversationRow(user, 'agent'), null, 'an offline target never creates a fallback writer');
  await assert.rejects(agentDirectoryAction(user, { action: 'directory-birth', ward: 'agent', runtimeId: 'server' }), /already belongs/);
});
