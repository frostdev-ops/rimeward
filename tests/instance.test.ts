import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { createUser } from '../src/lib/users.ts';
import { getDb } from '../src/lib/db.ts';
import { setSetting } from '../src/lib/settings.ts';
import { POST as backgroundPost } from '../src/pages/api/account/background.ts';
import { POST as themePost } from '../src/pages/api/account/theme.ts';
import type { APIContext } from 'astro';
import { getDashboard, getPages, saveDashboard } from '../src/lib/dashboard.ts';
import { DEFAULT_LAYOUT, DEFAULT_PAGES, validateLayout, validatePages } from '../src/lib/wards.ts';
import { normalizeTheme } from '../src/lib/theme.ts';
import { saveBackground, backgroundPath } from '../src/lib/backgrounds.ts';
import { INSTANCE_KEY, instanceDashboard, dashboardForSync, mergeInstance, wardDevice } from '../src/lib/dev/instance.ts';
import { captureRime, syncManifest, syncRecord, acceptRecord, installRecord } from '../src/lib/agent/sync-store.ts';
import { requestWard, routeInstance } from '../src/lib/dev/instance-routing.ts';

test('joining an instance keeps one Home, adds projects and preserves colliding custom wards', () => {
  const user = createUser('instance-join@x.dev', null), device = randomUUID();
  const server = instanceDashboard(user);
  server.layout.push({ i: 'remote-services', type: 'service-group', size: '2x2', config: { group: 'Remote infrastructure' } });
  server.catalog = { targets: [{ id: 'remote-db', label: 'Database', group: 'Remote infrastructure' }], titles: { 'Remote infrastructure': 'Production' } };
  const pages = [...DEFAULT_PAGES, { id: 'project', title: 'My project', project: 'opaque-project' }];
  const local = { ...server, pages, layout: validateLayout([...DEFAULT_LAYOUT, { i: 'editor', type: 'editor', size: '4x4', page: 'project' }], pages)! };
  const merged = mergeInstance(server, local, device).dashboard;
  assert.equal(merged.pages.filter(p => p.title === 'Home').length, 1);
  assert.equal(merged.layout.filter(w => w.i === 'editor').length, 1);
  assert.deepEqual(merged.catalog, server.catalog);
  assert.ok(validateLayout([{ i: 'one', type: 'calendar', size: '2x2' }, { i: 'two', type: 'calendar', size: '2x2', device }], DEFAULT_PAGES));
  assert.equal(merged.pages.find(p => p.id === 'project')?.device, device);
  saveDashboard(user, merged.layout, merged.pages);
  assert.equal(wardDevice(user, 'editor'), device);
  assert.equal(wardDevice(user, 'not-a-ward'), undefined);
  const custom = { ...server, layout: validateLayout(DEFAULT_LAYOUT, DEFAULT_PAGES)!.map((w, i) => i ? w : { ...w, title: 'My personal ward' }) };
  const both = mergeInstance(server, custom, device);
  assert.equal(both.dashboard.layout.length, server.layout.length + 1);
  assert.equal(both.dashboard.pages.find(p => p.title === 'Personal')?.device, device);
  assert.equal(new Set(both.dashboard.layout.map(w => w.i)).size, both.dashboard.layout.length);
  assert.equal(validatePages([{ id: 'x', title: 'Project', device }])?.[0]?.device, device);
});

test('appearance and dashboard sync remap account IDs, preserve icons/scenes and reject stale writes', async () => {
  const source = createUser('instance-theme@x.dev', null), target = createUser('instance-theme-other@x.dev', null);
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#5797b9' } }).png().toBuffer();
  const name = await saveBackground(source, bytes);
  const theme = normalizeTheme({ iconSet: 'tabler', iconStyle: 'outline', background: 'image', bgImage: name, brandLogo: name, brandText: 'Shared Rime', hdrBg: 'scene' });
  getDb().prepare('UPDATE users SET theme=? WHERE id=?').run(JSON.stringify(theme), source);
  const sourceSnapshot = dashboardForSync(source);
  assert.ok(sourceSnapshot.theme?.includes('0-'));
  const manifest = syncManifest(source);
  for (const entry of manifest.filter(r => r.key.startsWith('appearance/image/'))) installRecord(target, syncRecord(source, entry.key)!);
  const dashboard = syncRecord(source, INSTANCE_KEY)!;
  installRecord(target, dashboard);
  assert.deepEqual({ ...dashboardForSync(target), name: sourceSnapshot.name }, dashboardForSync(source));
  const localTheme = JSON.parse(instanceDashboard(target).theme!);
  assert.equal(localTheme.iconSet, 'tabler');
  assert.ok(localTheme.bgImage.startsWith(`${target}-`));
  assert.deepEqual(fs.readFileSync(backgroundPath(target, localTheme.bgImage)!), fs.readFileSync(backgroundPath(source, name)!));
  assert.equal(backgroundPath(source, localTheme.bgImage), null, 'sync does not relax image ownership');
  saveDashboard(target, getDashboard(target).map((w, i) => i ? w : { ...w, title: 'Concurrent edit' }), getPages(target));
  const stale = { ...JSON.parse(dashboard.payload), name: 'Stale write' }, payload = JSON.stringify(stale);
  const result = acceptRecord(target, { key: INSTANCE_KEY, payload, hash: createHash('sha256').update(payload).digest('hex') }, dashboard.hash);
  assert.equal(result.ok, false);
  assert.equal(getDashboard(target)[0]?.title, 'Concurrent edit');
  captureRime(target);
  const env = { desktop: process.env.RIMEWARD_DESKTOP, token: process.env.RIMEWARD_NATIVE_TOKEN };
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test';
  setSetting(`instance:joined:${target}`, 'test-profile');
  try {
    const themeForm = new URLSearchParams({ preset: 'glass', background: 'image', bgImage: name, brandLogo: name });
    await themePost({ request: new Request('http://localhost/api/account/theme', { method: 'POST', body: themeForm }),
      locals: { user: { userId: target, theme: JSON.stringify(localTheme) } },
      redirect: (url: string, status: number) => new Response(null, { status, headers: { location: url } }),
    } as unknown as APIContext);
    const savedTheme = JSON.parse((getDb().prepare('SELECT theme FROM users WHERE id=?').get(target) as { theme: string }).theme);
    assert.equal(savedTheme.bgImage, localTheme.bgImage, 'connected Account saves keep the local image owner');
    assert.equal(savedTheme.brandLogo, localTheme.brandLogo);
    const form = new FormData(); form.set('delete', name);
    await backgroundPost({ request: new Request('http://localhost/api/account/background', { method: 'POST', body: form }),
      locals: { user: { userId: target, theme: JSON.stringify(localTheme) } },
      redirect: (url: string, status: number) => new Response(null, { status, headers: { location: url } }),
    } as unknown as APIContext);
    assert.equal(fs.existsSync(backgroundPath(target, localTheme.bgImage)!), false, 'the shared form deletes the local image');
    assert.equal(fs.existsSync(backgroundPath(source, name)!), true, 'the other account image stays intact');
  } finally {
    if (env.desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = env.desktop;
    if (env.token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = env.token;
  }
});

test('routing resolves explicit ward context for native actions, uploads, history and streams', () => {
  assert.equal(requestWard('/api/dev/input?_ward=terminal-one'), 'terminal-one');
  assert.equal(requestWard('/api/agent/files?_ward=rime-one'), 'rime-one');
  assert.equal(requestWard('/api/agent/history?_ward=rime-one&key=chat%2Ftest'), 'rime-one');
  assert.equal(requestWard('/api/browser/stream/browser-one'), 'browser-one');
  assert.equal(requestWard('/api/calendar?account=all'), undefined);
});

test('a /runtime/<device> request keeps its explicit target; the same ward call without it is relayed', async () => {
  const user = createUser('instance-runtime-route@x.dev', null), device = randomUUID();
  const pages = validatePages([...DEFAULT_PAGES, { id: 'project', title: 'Project', device }])!;
  saveDashboard(user, validateLayout([...DEFAULT_LAYOUT, { i: 'term', type: 'terminal', size: '3x2', page: 'project' }], pages)!, pages);
  const route = (path: string) => {
    const url = new URL(`https://rime.example${path}`);
    return routeInstance({ locals: { user: { userId: user } }, url, request: new Request(url), cookies: { get: () => undefined } } as unknown as APIContext);
  };
  for (const path of [`/runtime/${device}/api/dev/projects?_ward=term`, `/runtime/${device}/api/agent/history?_ward=term`, `/runtime/${device}/api/weather?ward=term`])
    assert.equal(await route(path), undefined, path);
  // Without /runtime the ward's page places it on the device: the relay is attempted (this device is not enrolled here).
  assert.equal((await route('/api/dev/projects?_ward=term'))?.status, 404);
});
