import './_setup.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDashboard } from '../src/lib/dashboard.ts';
import { localOwner } from '../src/lib/dev/native.ts';
import { addProject } from '../src/lib/dev/projects.ts';
import { assertWorkspaceBinding, beginWorkspaceRun, currentRuntimeId, endWorkspaceRun, resolveWorkspaceForWard, saveWorkspaceDashboard, workspaceContext, workspaceOperation } from '../src/lib/dev/workspaces.ts';

process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'fixture-only';
Object.assign(globalThis, { __nativeVault: async () => '[]' });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-workspace-contract-'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const user = localOwner(); let sequence = 0;
async function fixture() {
  const id = ++sequence, ward = `consumer-${id}`, workspace = `workspace-${id}`;
  const left = path.join(directory, `${id}-left`), right = path.join(directory, `${id}-right`);
  fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(path.join(left, 'same.txt'), 'primary\n'); fs.writeFileSync(path.join(right, 'same.txt'), 'secondary\n');
  const primary = addProject(user, left), secondary = addProject(user, right), runtimeId = await currentRuntimeId(user);
  await saveWorkspaceDashboard(user, [...getDashboard(user),
    { i: workspace, type: 'workspace', size: '3x3', config: { workspaceId: workspace, revision: 1, mounts: [
      { id: 'primary', mountPath: '/', runtimeId, rootId: primary.id }, { id: 'secondary', mountPath: '/data', runtimeId, rootId: secondary.id },
    ] } }, { i: ward, type: 'agent', size: '2x2', workspace },
  ]);
  return { ward, workspace, left, right, primary, secondary, binding: await resolveWorkspaceForWard(user, ward) };
}

test('workspace file replies preserve virtual mount paths and isolate primary and secondary outages', async () => {
  const f = await fixture(), owner = `agent:${f.ward}`;
  const primary = await workspaceOperation(user, f.binding, 'read', { path: '/same.txt' }, owner);
  const secondary = await workspaceOperation(user, f.binding, 'read', { path: '/data/same.txt' }, owner);
  assert.equal(primary.text, 'primary\n'); assert.equal(secondary.text, 'secondary\n');
  assert.equal(secondary.path, '/data/same.txt', 'a following editor save must still select the secondary mount');
  assert.ok(Object.isFrozen(f.binding)); assert.ok(Object.isFrozen(f.binding.mounts)); assert.ok(Object.isFrozen(f.binding.mounts[0]));
  await assert.rejects(workspaceOperation(user, f.binding, 'read', { path: '/../../outside' }, owner));
  fs.renameSync(f.right, `${f.right}-offline`);
  try {
    assert.equal((await workspaceOperation(user, f.binding, 'read', { path: '/same.txt' }, owner)).text, 'primary\n');
    const context = await workspaceContext(user, f.ward);
    assert.equal(context.status, 'partial'); assert.equal(context.mounts.find((m: { mountPath: string }) => m.mountPath === '/data')?.status, 'offline');
  } finally { fs.renameSync(`${f.right}-offline`, f.right); }
  fs.renameSync(f.left, `${f.left}-offline`);
  try { await assert.rejects(workspaceOperation(user, f.binding, 'read', { path: '/data/same.txt' }, owner)); }
  finally { fs.renameSync(`${f.left}-offline`, f.left); }
  fs.mkdirSync(path.join(f.left, 'data'));
  await assert.rejects(workspaceOperation(user, f.binding, 'tree', { path: '/' }, owner), /hides|collision/i);
});

test('active work and dirty buffers block workspace changes; a resolved change invalidates the old binding', async () => {
  const f = await fixture(), next = structuredClone(getDashboard(user));
  const config = next.find(w => w.i === f.workspace)!.config!;
  config.revision = 2; (config.mounts as { rootId: string }[])[0]!.rootId = f.secondary.id;
  const lease = await beginWorkspaceRun(user, f.binding);
  try { await assert.rejects(saveWorkspaceDashboard(user, next), /active|run|stop/i); }
  finally { await endWorkspaceRun(user, lease); }
  const current = await workspaceOperation(user, f.binding, 'read', { path: '/same.txt' }, 'client:fixture');
  const dirty = await workspaceOperation(user, f.binding, 'edit', { path: '/same.txt', revision: current.revision, text: 'unsaved\n' }, 'client:fixture');
  await assert.rejects(saveWorkspaceDashboard(user, next), /dirty|unsaved|resolve/i);
  assert.equal(getDashboard(user).find(w => w.i === f.workspace)?.config?.revision, 1);
  await workspaceOperation(user, f.binding, 'edit', { path: '/same.txt', revision: dirty.revision, save: true }, 'client:fixture');
  await saveWorkspaceDashboard(user, next);
  await assert.rejects(assertWorkspaceBinding(user, f.binding), /changed|stale/i);
  assert.equal((await resolveWorkspaceForWard(user, f.ward)).revision, 2);
});

test('cross-root moves and a later root preflight failure never publish the earlier file', async () => {
  const f = await fixture(), owner = `agent:${f.ward}`;
  await assert.rejects(workspaceOperation(user, f.binding, 'patch', { patch: '*** Begin Patch\n*** Update File: /same.txt\n*** Move to: /data/moved.txt\n@@\n-primary\n+changed\n*** End Patch' }, owner), /Cross-root|cross-root|workspace_transfer/);
  let result: { ok?: boolean; error?: string } | undefined, failure = '';
  try { result = await workspaceOperation(user, f.binding, 'patch', { patch: '*** Begin Patch\n*** Update File: /same.txt\n@@\n-primary\n+changed\n*** Delete File: /data/missing.txt\n*** End Patch' }, owner); }
  catch (error) { failure = (error as Error).message; }
  assert.notEqual(result?.ok, true);
  assert.match(failure || result?.error || '', /missing|does not exist|not found/i);
  assert.equal(fs.readFileSync(path.join(f.left, 'same.txt'), 'utf8'), 'primary\n');
  assert.equal(fs.existsSync(path.join(f.right, 'moved.txt')), false);
});

test('overlapping physical roots cannot publish two patches through different virtual aliases', async () => {
  const f = await fixture(), nested = path.join(f.left, 'nested');
  fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'value.txt'), 'before\n');
  const aliasRoot = addProject(user, nested), layout = structuredClone(getDashboard(user));
  const config = layout.find(w => w.i === f.workspace)!.config!;
  config.revision = 2;
  const mount = (config.mounts as { rootId: string; mountPath: string }[])[1]!;
  mount.rootId = aliasRoot.id; mount.mountPath = '/alias';
  await saveWorkspaceDashboard(user, layout);
  const binding = await resolveWorkspaceForWard(user, f.ward);
  let result: { ok?: boolean; applied?: unknown[]; error?: string } | undefined, failure = '';
  try { result = await workspaceOperation(user, binding, 'patch', { patch: '*** Begin Patch\n*** Update File: /nested/value.txt\n@@\n-before\n+first\n*** Update File: /alias/value.txt\n@@\n-before\n+second\n*** End Patch' }, `agent:${f.ward}`); }
  catch (error) { failure = (error as Error).message; }
  assert.notEqual(result?.ok, true);
  assert.match(failure || result?.error || '', /alias|same|another mutation|collid|duplicate|prepared/i);
  assert.equal(result?.applied?.length ?? 0, 0);
  assert.equal(fs.readFileSync(path.join(nested, 'value.txt'), 'utf8'), 'before\n');
});
