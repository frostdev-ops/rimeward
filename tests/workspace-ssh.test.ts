import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sftpServer, sshFixture } from './workspace-ssh-fixture.mjs';
import { configureSsh, sshConnections, sshExec } from '../src/lib/dev/workspace-ssh.ts';
import { registerRoot, rootOperation } from '../src/lib/dev/workspace-roots.ts';
import { workDb } from '../src/lib/dev/runtime.ts';

process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'fixture-only';
const vault = new Map<string, string>();
Object.assign(globalThis, { __nativeVault: async (op: string, value?: string) => {
  if (op === 'ssh-set') { vault.set('ssh', value!); return ''; }
  return op === 'ssh-get' ? vault.get('ssh') ?? '{}' : '[]';
} });

test('SSH verifies host identity, preserves paged bytes and mode, and reconciles patch receipts without replay', { skip: !sftpServer, timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-ssh-'));
  const server = await sshFixture(directory);
  try {
    const settings = { host: server.host, port: server.port, username: server.username, auth: 'password', password: server.password };
    const untrusted = await configureSsh(1, settings);
    assert.ok('requiresHostVerification' in untrusted); assert.equal(untrusted.hostFingerprint, server.fingerprint);
    assert.equal((await sshConnections(1)).length, 0, 'unverified host is not registered');
    const connection = await configureSsh(1, { ...settings, hostFingerprint: server.fingerprint, remember: true });
    if ('requiresHostVerification' in connection) throw Error('Verified fixture was refused');
    assert.equal(connection.remembered, true);
    assert.equal(JSON.stringify(await sshConnections(1)).includes(server.password), false, 'shared connection metadata contains no password');
    assert.equal(JSON.stringify(workDb().prepare('SELECT * FROM workspace_connections').all()).includes(server.password), false);
    const root = await registerRoot(1, { root: directory, connection: connection.id });
    const file = "quoted' file.txt", original = '\ufefffirst\r\nsecond\r\n';
    fs.writeFileSync(path.join(directory, file), original, { mode: 0o750 });
    const source = await rootOperation(1, root.id, 'read', { path: file }, 'agent:ssh') as { text: string; revision: number };
    assert.equal(source.text, 'first\nsecond\n');
    const operationId = randomUUID();
    const prepared = await rootOperation(1, root.id, 'patch-prepare', { operationId, patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-first\n+changed\n*** End Patch`, expected_revisions: { [file]: source.revision } }, 'agent:ssh') as { planId: string };
    const result = await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, 'agent:ssh') as { ok: boolean; error?: string };
    assert.equal(result.ok, true, result.error ?? 'SSH patch failed.');
    assert.deepEqual(fs.readFileSync(path.join(directory, file)), Buffer.from('\ufeffchanged\r\nsecond\r\n'));
    assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o750);
    const writes = server.commands.length;
    await rootOperation(1, root.id, 'patch-commit', { planId: prepared.planId }, 'agent:ssh');
    assert.equal(server.commands.length, writes, 'receipt lookup does not repeat remote publication');
    const long = '🙂'.repeat(6000) + 'tail'; fs.writeFileSync(path.join(directory, 'long.txt'), long);
    let from = 1, column = 0, text = '';
    for (;;) {
      const page = await rootOperation(1, root.id, 'read', { path: 'long.txt', from, column }, 'agent:ssh') as { text: string; next?: number; nextColumn?: number };
      text += page.text; if (page.next === undefined) break; from = page.next; column = page.nextColumn ?? 0;
    }
    assert.equal(text, long);
    assert.equal((await sshExec(1, connection.id, 'fixture:unicode')).stdout, '🙂 café\n');
    assert.equal((await sshExec(1, connection.id, 'fixture:no-status')).exitCode, null);
    assert.equal(server.commands.filter(command => command === 'fixture:no-status').length, 1);
    fs.writeFileSync(path.join(directory, 'editor.txt'), 'disk\n');
    const buffer = await rootOperation(1, root.id, 'read', { path: 'editor.txt' }, 'client:ssh-editor') as { revision: number };
    const dirty = await rootOperation(1, root.id, 'edit', { path: 'editor.txt', text: 'saved from recovery\n', revision: buffer.revision }, 'client:ssh-editor') as { revision: number; dirty: boolean };
    assert.equal(dirty.dirty, true); assert.equal(fs.readFileSync(path.join(directory, 'editor.txt'), 'utf8'), 'disk\n');
    await rootOperation(1, root.id, 'edit', { path: 'editor.txt', revision: dirty.revision, save: true }, 'client:ssh-editor');
    assert.equal(fs.readFileSync(path.join(directory, 'editor.txt'), 'utf8'), 'saved from recovery\n');
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SSH refuses unavailable write guarantees and hardlinked or symlinked sources before publication', { skip: !sftpServer, timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-ssh-readonly-'));
  const server = await sshFixture(directory, true);
  try {
    const connection = await configureSsh(2, { host: server.host, port: server.port, username: server.username, auth: 'password', password: server.password, hostFingerprint: server.fingerprint });
    if ('requiresHostVerification' in connection) throw Error('Verified fixture was refused');
    const root = await registerRoot(2, { root: directory, connection: connection.id });
    fs.writeFileSync(path.join(directory, 'file.txt'), 'original\n');
    const prepare = (file: string) => rootOperation(2, root.id, 'patch-prepare', { operationId: randomUUID(), patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-original\n+changed\n*** End Patch` }, 'agent:ssh-readonly');
    await assert.rejects(prepare('file.txt'), /fsync|extensions|durability/i);
    assert.equal(fs.readFileSync(path.join(directory, 'file.txt'), 'utf8'), 'original\n');
    fs.linkSync(path.join(directory, 'file.txt'), path.join(directory, 'alias.txt'));
    await assert.rejects(prepare('alias.txt'), /single.link|hard.link/i);
    fs.symlinkSync(path.join(directory, 'file.txt'), path.join(directory, 'link.txt'));
    await assert.rejects(prepare('link.txt'), /symlink/i);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['alias.txt', 'file.txt', 'link.txt'], 'failed preflight removes temporary probes');
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SSH terminals preserve ordered Unicode input, resize, and unknown exit state without reattachment', { skip: !sftpServer, timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-ssh-terminal-'));
  const server = await sshFixture(directory);
  try {
    const connection = await configureSsh(3, { host: server.host, port: server.port, username: server.username, auth: 'password', password: server.password, hostFingerprint: server.fingerprint });
    if ('requiresHostVerification' in connection) throw Error('Verified fixture was refused');
    const root = await registerRoot(3, { root: directory, connection: connection.id });
    const caps = await rootOperation(3, root.id, 'capabilities', {}, 'client:ssh') as { agents: { codex: boolean; claude: boolean } };
    assert.deepEqual(caps.agents, { codex: false, claude: false });
    const session = await rootOperation(3, root.id, 'terminal-start', { kind: 'shell', cols: 90, rows: 25 }, 'client:ssh') as { id: string };
    await rootOperation(3, root.id, 'terminal-resize', { session: session.id, cols: 111, rows: 33 }, 'client:ssh');
    await rootOperation(3, root.id, 'terminal-write', { session: session.id, data: 'printf "received:%s\\n" \'café 🙂\'; exit\r' }, 'client:ssh');
    const wait = async (id: string) => {
      let after = 0, value: { screen: string; session: { state: string; sequence: number; exitCode: number | null; terminationReason?: string } } | undefined;
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        value = await rootOperation(3, root.id, 'terminal-wait', { session: id, after, ms: 1000 }, 'client:ssh') as NonNullable<typeof value>;
        if (value.session.state !== 'running') return value;
        after = value.session.sequence;
      }
      throw Error(`SSH terminal never recorded its closed command channel: ${JSON.stringify(value)}`);
    };
    const finished = await wait(session.id);
    const rendered = await rootOperation(3, root.id, 'terminal-read', { session: session.id }, 'client:ssh') as { data: string };
    assert.equal(finished.session.exitCode, 0); assert.match(rendered.data, /received:café 🙂/);
    assert.ok(server.sizes.some(size => size.cols === 111 && size.rows === 33));
    const unknown = await rootOperation(3, root.id, 'terminal-exec', { kind: 'shell', command: '__fixture_missing_status__' }, 'client:ssh') as { id: string };
    const disconnected = await wait(unknown.id);
    assert.equal(disconnected.session.state, 'interrupted'); assert.equal(disconnected.session.exitCode, null);
    await assert.rejects(rootOperation(3, root.id, 'terminal-restart', { session: unknown.id }, 'client:ssh'), /new SSH session|never replayed|reattach/i);
    await assert.rejects(rootOperation(3, root.id, 'guard', {}, 'client:ssh'), /stop|interrupted|uncertain|resolve/i);
    await assert.rejects(rootOperation(3, root.id, 'terminal-reconcile', { session: unknown.id, confirmedStopped: true }, 'agent:ssh'), /human|person|user|client|confirm/i);
    await rootOperation(3, root.id, 'terminal-reconcile', { session: unknown.id, confirmedStopped: true }, 'client:ssh');
    await rootOperation(3, root.id, 'guard', {}, 'client:ssh');
    assert.equal(server.commands.filter(command => command.includes('__fixture_missing_status__')).length, 1);
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
