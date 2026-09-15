import './_setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { registerRoot, rootWriteBytes, rootRemove, rootOperation } from '../src/lib/dev/workspace-roots.ts';
import { readBuffer, editBuffer, hash, bufferCopies } from '../src/lib/dev/projects.ts';
import { workDb } from '../src/lib/dev/runtime.ts';

process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-mutations-'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
let count = 0;
async function fixture() {
  const dir = path.join(directory, String(++count)); fs.mkdirSync(dir);
  return { dir, root: await registerRoot(1, { root: dir }) };
}
const patch = (file: string, before = 'old', after = 'new') => `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`;

test('byte writes share patch safety, preserve mode and retain original raw recovery', async () => {
  const { dir, root } = await fixture(), old = Buffer.from([0, 1, 2, 255]), next = Buffer.from([0, 4, 5, 255]);
  fs.writeFileSync(path.join(dir, 'data.bin'), old, { mode: 0o640 });
  const originalMode = fs.statSync(path.join(dir, 'data.bin')).mode & 0o777;
  const receipt = await rootWriteBytes(1, root, 'data.bin', next, 'agent:bytes', hash(old));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'data.bin')), next);
  assert.equal(fs.statSync(path.join(dir, 'data.bin')).mode & 0o777, originalMode);
  assert.equal(receipt.revision, 1);
  const recovery = workDb().prepare('SELECT raw,mode FROM buffer_copies WHERE id=?').get(receipt.recovery) as { raw: Buffer; mode: number };
  assert.deepEqual(recovery.raw, old); assert.equal(recovery.mode & 0o777, originalMode);
  await assert.rejects(rootWriteBytes(1, root, 'data.bin', old, 'agent:bytes', hash(old)), /changed/);
  fs.linkSync(path.join(dir, 'data.bin'), path.join(dir, 'alias.bin'));
  await assert.rejects(rootWriteBytes(1, root, 'data.bin', old, 'agent:bytes', hash(next)), /single-link/);
  await assert.rejects(rootRemove(1, root, 'alias.bin', 'agent:bytes', hash(next)), /single-link/);
  fs.symlinkSync('data.bin', path.join(dir, 'symlink.bin'));
  await assert.rejects(rootWriteBytes(1, root, 'symlink.bin', old, 'agent:bytes', hash(next)), /symlinks/);
});

test('byte writes refuse dirty or other-owned buffers through overlapping registered roots', async () => {
  const { dir, root } = await fixture(); fs.mkdirSync(path.join(dir, 'nested')); fs.writeFileSync(path.join(dir, 'nested', 'file.txt'), 'old\n');
  const child = await registerRoot(1, { root: path.join(dir, 'nested') });
  const buffer = readBuffer(1, root.id, 'nested/file.txt');
  editBuffer(1, root.id, 'nested/file.txt', 'human:editor', { text: 'unsaved\n', revision: buffer.revision });
  await assert.rejects(rootWriteBytes(1, child, 'file.txt', Buffer.from('new\n'), 'agent:other', hash(Buffer.from('old\n'))), /controls|dirty/);
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'file.txt'), 'utf8'), 'old\n');
});

test('prepared patch reserves aliases, rejects stale identity, and can be inspected without replay', async () => {
  const { dir, root } = await fixture(); fs.mkdirSync(path.join(dir, 'nested')); const file = path.join(dir, 'nested', 'file.txt'); fs.writeFileSync(file, 'old\n');
  const child = await registerRoot(1, { root: path.join(dir, 'nested') });
  const operationId = randomUUID(), owner = 'agent:prepared';
  const prepared = await rootOperation(1, root.id, 'patch-prepare', { operationId, patch: patch('nested/file.txt') }, owner) as { planId: string };
  const buffer = readBuffer(1, child.id, 'file.txt');
  assert.throws(() => editBuffer(1, child.id, 'file.txt', 'human:editor', { text: 'conflict', revision: buffer.revision, takeover: true }), /prepared workspace mutation/);
  fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'old\n');
  const result = await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, owner) as { ok: boolean; error: string; operationId: string };
  assert.equal(result.ok, false); assert.match(result.error, /identity changed/); assert.equal(result.operationId, operationId);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
  const status = await rootOperation(1, root.id, 'patch-status', { operationId }, owner) as { state: string; uncertain: boolean };
  assert.equal(status.state, 'uncertain'); assert.equal(status.uncertain, true);
  const again = await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, owner) as { ok: boolean };
  assert.equal(again.ok, false); assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
});

test('successful patch receipt is durable and duplicate commit does not make another recovery copy', async () => {
  const { dir, root } = await fixture(); fs.writeFileSync(path.join(dir, 'file.txt'), 'old\n');
  const operationId = randomUUID(), owner = 'agent:durable';
  const prepared = await rootOperation(1, root.id, 'patch-prepare', { operationId, patch: patch('file.txt') }, owner) as { planId: string };
  const result = await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, owner) as { ok: boolean };
  assert.equal(result.ok, true); const copies = bufferCopies(1, root.id, 'file.txt').length;
  const repeated = await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, owner) as { ok: boolean; state: string };
  assert.equal(repeated.ok, true); assert.equal(repeated.state, 'completed');
  assert.equal(bufferCopies(1, root.id, 'file.txt').length, copies);
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'new\n');
  await assert.rejects(rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, 'agent:different'), /Not your patch/);
});

test('byte transfer phases retain receipts without replay and revoked grants cannot publish', async () => {
  const { dir, root } = await fixture(), operationId = randomUUID(), owner = 'agent:transfer';
  fs.writeFileSync(path.join(dir, 'source.txt'), 'source');
  const copy = { operationId, path: 'copy.txt', data: Buffer.from('source').toString('base64'), expectedHash: null };
  await rootOperation(1, root.id, 'write-bytes', copy, owner);
  fs.writeFileSync(path.join(dir, 'copy.txt'), 'later edit');
  const repeated = await rootOperation(1, root.id, 'write-bytes', copy, owner) as { state: string };
  assert.equal(repeated.state, 'completed'); assert.equal(fs.readFileSync(path.join(dir, 'copy.txt'), 'utf8'), 'later edit');
  await rootOperation(1, root.id, 'remove', { operationId, path: 'source.txt', expectedHash: hash(Buffer.from('source')) }, owner);
  const status = await rootOperation(1, root.id, 'patch-status', { operationId }, owner) as { state: string; phases: { state: string }[] };
  assert.equal(status.state, 'transfer'); assert.equal(status.phases.length, 2); assert.ok(status.phases.every(p => p.state === 'completed'));
  const recent = await rootOperation(1, root.id, 'patch-recent', {}, owner) as { recent: { operationId: string }[] };
  assert.ok(recent.recent.some(r => r.operationId === operationId));
  workDb().prepare('UPDATE projects SET archived=1 WHERE id=?').run(root.id);
  await assert.rejects(rootWriteBytes(1, root, 'copy.txt', Buffer.from('bad'), owner, hash(Buffer.from('later edit'))), /not found/);
  assert.equal(fs.readFileSync(path.join(dir, 'copy.txt'), 'utf8'), 'later edit');
});

test('receipts survive process restart and running commits stay uncertain without replay', async () => {
  const { dir, root } = await fixture(); fs.writeFileSync(path.join(dir, 'file.txt'), 'old\n');
  const operationId = randomUUID(), owner = 'agent:restart';
  const prepared = await rootOperation(1, root.id, 'patch-prepare', { operationId, patch: patch('file.txt') }, owner) as { planId: string };
  workDb().prepare("UPDATE workspace_operations SET state='running' WHERE id=?").run(prepared.planId);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'new\n'); // Publication happened before the simulated crash.
  const module = new URL('../src/lib/dev/workspace-roots.ts', import.meta.url).href;
  const script = `import { rootOperation } from ${JSON.stringify(module)};
    const status = await rootOperation(1, ${JSON.stringify(root.id)}, 'patch-status', {operationId:${JSON.stringify(operationId)}}, ${JSON.stringify(owner)});
    const retry = await rootOperation(1, ${JSON.stringify(root.id)}, 'patch-commit', {planId:${JSON.stringify(prepared.planId)}}, ${JSON.stringify(owner)});
    process.stdout.write(JSON.stringify({status,retry}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: process.env });
  assert.equal(child.status, 0, child.stderr);
  const { status, retry } = JSON.parse(child.stdout);
  assert.equal(status.state, 'uncertain'); assert.equal(status.uncertain, true);
  assert.equal(retry.state, 'uncertain'); assert.equal(retry.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'new\n');
  // Finish the simulated run so this test does not retain a reservation.
  workDb().prepare("UPDATE workspace_operations SET state='prepared' WHERE id=?").run(prepared.planId);
  await rootOperation(1, root.id, 'patch-release', { planId: prepared.planId }, owner);
});
