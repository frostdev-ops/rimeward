import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateProjectWorkspaces, requireWorkspaceLayoutVersion } from '../src/lib/dev/workspace-migration.ts';
import { MAX_WARDS_PER_PAGE, validateLayout, type WardInstance } from '../src/lib/wards.ts';

const runtimeId = '11111111-1111-1111-1111-111111111111';
const pages = [{ id: 'home', title: 'Home', project: 'page-root', device: runtimeId }];
const editor: WardInstance = { i: 'editor', type: 'editor', size: '3x3' };
const layout: WardInstance[] = [editor, { i: 'agent', type: 'agent', size: '2x4' }];
const owner = { runtimeId, online: true, projects: [{ id: 'page-root', name: 'Page folder' }, { id: 'editor-root', name: 'Editor folder' }], views: { editor: { project: 'editor-root' } } };

test('migration prefers saved consumer selection, reuses identities, and is idempotent', () => {
  const migrated = migrateProjectWorkspaces(layout, pages, [owner], runtimeId);
  const rootFor = (id: string) => (migrated.layout.find(w => w.i === migrated.layout.find(c => c.i === id)?.workspace)?.config?.mounts as {rootId: string}[] | undefined)?.[0]?.rootId;
  assert.equal(rootFor('editor'), 'editor-root'); assert.equal(rootFor('agent'), 'page-root');
  assert.equal(migrated.pages[0]?.project, undefined); assert.equal(migrated.pages[0]?.device, runtimeId);
  assert.deepEqual(migrateProjectWorkspaces(migrated.layout, migrated.pages, [owner], runtimeId).layout, migrated.layout);
  assert.equal(layout[0]?.workspace, undefined); assert.equal(pages[0]?.project, 'page-root');
});

test('offline selections and full pages are preserved for a later migration', () => {
  const offline = migrateProjectWorkspaces(layout, pages, [{ runtimeId, online: false }], runtimeId);
  assert.equal(offline.pending.length, 2); assert.equal(offline.pages[0]?.project, 'page-root'); assert.equal(offline.layout[0]?.workspace, undefined);
  const full: WardInstance[] = [editor, ...Array.from({ length: MAX_WARDS_PER_PAGE - 1 }, (_, i) => ({ i: `note-${i}`, type: 'note', size: '2x2' as const }))];
  const deferred = migrateProjectWorkspaces(full, pages, [owner], runtimeId);
  assert.equal(deferred.layout.length, full.length); assert.match(deferred.pending[0]?.reason ?? '', /Make room/);
});

test('unconfigured consumers never inherit the first registered folder; old sync peers are refused', () => {
  const migration = migrateProjectWorkspaces([editor], [{ id: 'home', title: 'Home' }], [{ ...owner, views: {} }], runtimeId);
  assert.equal(migration.layout[0]?.workspace, undefined); assert.equal(migration.pending.length, 0);
  assert.throws(() => requireWorkspaceLayoutVersion([{ type: 'workspace' }], null), { status: 426 });
  assert.throws(() => requireWorkspaceLayoutVersion([{ workspace: 'missing' }], '0'), { status: 426 });
  assert.doesNotThrow(() => requireWorkspaceLayoutVersion([{ type: 'workspace' }], '1'));
});

test('projectless agent ownership and unrelated pages/documents survive migration', () => {
  const unrelatedPages = [{ id: 'home', title: 'Home', device: runtimeId }, { id: 'writing', title: 'Writing' }];
  const source = validateLayout([{ i: 'agent', type: 'agent', size: '2x4' }, { i: 'book', type: 'notebook', size: '3x3', page: 'writing', config: { notebook: 'saved-book' } }], unrelatedPages);
  assert.ok(source);
  const result = migrateProjectWorkspaces(source, unrelatedPages, [{ ...owner, views: {} }], 'another-runtime');
  assert.equal(result.changed, true);
  assert.deepEqual(result.layout, source.map(w => w.type === 'agent' ? { ...w, workspaceVersion: 1 } : w)); assert.deepEqual(result.pages, unrelatedPages);
  assert.deepEqual(result.owners, [{ ward: 'agent', runtimeId }]);
  const selected = migrateProjectWorkspaces(source, unrelatedPages, [{ ...owner, views: { agent: { project: 'editor-root' } } }], runtimeId);
  assert.ok(selected.layout.find(w => w.i === 'agent')?.workspace, 'authoritative agent selection is used even without a page project');
  assert.deepEqual(selected.layout.find(w => w.i === 'book'), source.find(w => w.i === 'book'));
});
