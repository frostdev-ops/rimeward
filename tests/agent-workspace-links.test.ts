import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';

test('agent layout tools report persistent Workspace links and reject stale or destructive edits', async () => {
  const db = getDb();
  const userId = Number(db.prepare("INSERT INTO users(email,password_hash,role) VALUES('workspace-tools@fixture.local','x','admin')").run().lastInsertRowid);
  const definition = { workspaceId: 'fixture-workspace', revision: 1, mounts: [{ id: 'primary', mountPath: '/', runtimeId: 'unavailable-runtime', rootId: 'retained-root' }] };
  const layout = validateLayout([{ i: 'space', type: 'workspace', size: '3x3', config: definition }, { i: 'editor', type: 'editor', size: '3x3', workspace: 'space' }]);
  assert.ok(layout);
  // Seed an offline restored record without registering any native runtime or touching a user's folders.
  db.prepare('INSERT INTO dashboards(user_id,layout_json,pages_json) VALUES(?,?,?)').run(userId, JSON.stringify(layout), JSON.stringify([{ id: 'home', title: 'Home' }]));
  const ctx = { userId, ward: 'fixture-agent', conv: 0 } as Parameters<NonNullable<typeof TOOLS.get_layout>['run']>[1];
  const view = await TOOLS.get_layout?.run({}, ctx) as { layout: { ward: string; workspace?: string; workspaceFingerprint?: string }[] };
  assert.equal(view.layout.find(w => w.ward === 'editor')?.workspace, 'space');
  assert.ok(view.layout.find(w => w.ward === 'space')?.workspaceFingerprint);
  const graph = await TOOLS.get_logic_graph?.run({}, ctx) as { workspaces: unknown[] };
  assert.deepEqual(graph.workspaces, [{ type: 'workspace', source: 'space', target: 'editor' }]);
  assert.throws(() => TOOLS.configure_ward?.run({ ward: 'editor', workspace: null }, ctx), /expected value is missing/);
  assert.throws(() => TOOLS.configure_ward?.run({ ward: 'space', config: definition }, ctx), /revision\/fingerprint is missing/);
  assert.throws(() => TOOLS.remove_ward?.run({ ward: 'space' }, ctx), /Disconnect the linked wards/);
  assert.deepEqual(getDashboard(userId), layout);
  await TOOLS.configure_ward?.run({ ward: 'space', title: 'Offline workspace' }, ctx);
  assert.equal(getDashboard(userId).find(w => w.i === 'space')?.title, 'Offline workspace', 'cosmetic edits do not require an online file host');
});
