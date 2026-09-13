import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLayout, CATALOG } from '../src/lib/wards.ts';
import { workspaceFingerprint } from '../src/lib/dev/workspace-contract.ts';
import { normalizeEditorPaths } from '../src/lib/dev/editor-paths.ts';

const definition = { workspaceId: 'workspace-one', revision: 1, mounts: [
  { id: 'extra', mountPath: '/data', runtimeId: 'desktop-b', rootId: 'root-b', instructionsPath: 'CLAUDE.md' },
  { id: 'primary', mountPath: '/', runtimeId: 'desktop-a', rootId: 'root-a', instructionsPath: 'AGENTS.md' },
] };
const workspace = { i: 'workspace', type: 'workspace', size: '3x3', config: definition };

test('Workspace Leylines retain one explicit binding and never infer one from a page', () => {
  const layout = validateLayout([workspace, { i: 'editor', type: 'editor', size: '3x3', workspace: 'workspace' }, { i: 'terminal', type: 'terminal', size: '3x3' }], [{ id: 'home', title: 'Home', project: 'legacy-project' }]);
  assert.equal(layout?.[1]?.workspace, 'workspace');
  assert.equal(layout?.[2]?.workspace, undefined);
  assert.equal(CATALOG['project-files']?.title, 'Files');
});

test('Only filesystem wards accept Workspace links; missing references remain explicit', () => {
  assert.equal(validateLayout([workspace, { i: 'browser', type: 'browser', size: '3x3', workspace: 'workspace' }]), null);
  assert.equal(validateLayout([{ i: 'wrong', type: 'note', size: '3x3' }, { i: 'editor', type: 'editor', size: '3x3', workspace: 'wrong' }]), null);
  assert.equal(validateLayout([{ i: 'editor', type: 'editor', size: '3x3', workspace: 'missing' }])?.[0]?.workspace, 'missing');
});

test('Workspace config sync rebuilds opaque references and preserves explicit instruction selection', () => {
  const layout = validateLayout([{ ...workspace, config: { ...definition, root: '/private/path', password: 'never-sync', mounts: definition.mounts.map(mount => ({ ...mount, physicalPath: '/private/path', password: 'never-sync' })) } }]);
  assert.deepEqual(layout?.[0]?.config, definition);
  assert.equal(workspaceFingerprint(definition), workspaceFingerprint({ ...definition, mounts: [...definition.mounts].reverse() }));
  assert.notEqual(workspaceFingerprint(definition), workspaceFingerprint({ ...definition, mounts: definition.mounts.map(mount => ({ ...mount, instructionsPath: undefined })) }));
});

test('legacy editor tabs and checkpoint histories acquire virtual paths without duplicate tabs', () => {
  const state = { tabs: ['src/a.ts', '/src/a.ts', 'data/b.txt'], active: 'src/a.ts' };
  const checkpoint = { 'src/a.ts': { doc: 'older' }, '/src/a.ts': { doc: 'current' }, 'data/b.txt': { doc: 'other' } };
  assert.deepEqual(normalizeEditorPaths(state, checkpoint), { tabs: ['/src/a.ts', '/data/b.txt'], active: '/src/a.ts', files: { '/src/a.ts': { doc: 'current' }, '/data/b.txt': { doc: 'other' } } });
  assert.equal(state.active, 'src/a.ts'); assert.equal(checkpoint['src/a.ts'].doc, 'older');
  assert.throws(() => normalizeEditorPaths({ tabs: ['../outside'] }), /leaves the workspace/);
});
