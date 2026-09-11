// Updates: release picking, the cached lookup, the install swap and its
// rollback, the policy. The network is a stub; the checkout is a temp dir.
import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmpVersion, latestReleases, newer, pickReleases, setUpdatePolicy, swapTree, updatePolicy, installKind, SHIPPED } from '../src/lib/updates.ts';

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/frostdev-ops/rimeward/releases/tag/${tag}`,
  body: `notes for ${tag}`,
  published_at: '2026-09-10T00:00:00Z',
  assets: [{ name: 'latest.json', browser_download_url: `https://example.test/${tag}/latest.json` }],
  ...extra,
});

test('cmpVersion: numeric, a leading v is fine, a pre-release sorts below its release', () => {
  assert.ok(cmpVersion('1.2.10', '1.2.9') > 0);
  assert.ok(cmpVersion('v1.10.0', '1.9.9') > 0);
  assert.equal(cmpVersion('1.0.0', 'v1.0.0'), 0);
  assert.ok(cmpVersion('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(cmpVersion('1.0.0-beta.2', '1.0.0-beta.1') > 0);
  assert.ok(newer('1.0.1', '1.0.0'));
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('1.0.1', null), false);
  assert.equal(newer(undefined, '1.0.0'), false);
});

test('pickReleases: newest PUBLISHED server and desktop release each; drafts, pre-releases and odd tags skipped', () => {
  const r = pickReleases([
    rel('v1.0.1', { draft: true }),
    rel('v1.0.2', { prerelease: true }),
    rel('v0.9.0'),
    rel('desktop-v1.0.3'),
    rel('v1.0.0'),
    rel('desktop-v0.5.12'),
    rel('nightly-2026'),
    rel('v1.0.0-rc.1'),
  ], 5);
  assert.equal(r.checkedAt, 5);
  assert.equal(r.server?.version, '1.0.0');
  assert.equal(r.server?.tag, 'v1.0.0');
  assert.equal(r.server?.notes, 'notes for v1.0.0');
  assert.equal(r.desktop?.version, '1.0.3');
  assert.equal(r.desktop?.assets['latest.json'], 'https://example.test/desktop-v1.0.3/latest.json');
  assert.deepEqual(pickReleases({ message: 'rate limited' }), { checkedAt: pickReleases({}).checkedAt, server: null, desktop: null });
});

test('latestReleases: one fetch per TTL, refresh on demand, a failure keeps the last answer and records why', async () => {
  let calls = 0;
  let fail = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    calls++;
    assert.match(String(url), /\/releases\?per_page=30$/);
    if (fail) return new Response('nope', { status: 503 });
    return Response.json([rel('v9.9.9'), rel('desktop-v9.9.8')]);
  }) as typeof fetch;
  const a = await latestReleases({ refresh: true, fetchImpl });
  assert.equal(a.server?.version, '9.9.9');
  assert.equal(a.error, undefined);
  const b = await latestReleases({ fetchImpl });
  assert.equal(calls, 1); // fresh: served from the settings row
  assert.equal(b.desktop?.version, '9.9.8');
  fail = true;
  const c = await latestReleases({ refresh: true, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(c.server?.version, '9.9.9'); // the previous answer survives
  assert.match(c.error!, /HTTP 503/);
  assert.ok(c.checkedAt >= a.checkedAt); // the failed attempt is stamped, so the next read waits out the TTL
});

test('swapTree: shipped entries swap in, the old ones park in prev, data/.env stay, and swapping back restores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdupd-'));
  const root = path.join(dir, 'root'), stage = path.join(dir, 'stage'), prev = path.join(dir, 'prev');
  for (const d of [root, stage]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist/old.js'), 'old');
  fs.mkdirSync(path.join(root, 'ops')); // the new release dropped ops/
  fs.writeFileSync(path.join(root, 'server.mjs'), 'old server');
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data/homepage.db'), 'db');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(stage, 'dist')); fs.writeFileSync(path.join(stage, 'dist/new.js'), 'new');
  fs.writeFileSync(path.join(stage, 'server.mjs'), 'new server');
  fs.mkdirSync(path.join(stage, 'node_modules')); // what the stage's npm ci produced
  const names = ['dist', 'ops', 'server.mjs', 'node_modules', 'package.json'];
  const moved = swapTree(root, stage, prev, names);
  assert.deepEqual(moved, ['dist', 'ops', 'server.mjs', 'node_modules']); // package.json: in neither → untouched, unlisted
  assert.equal(fs.readFileSync(path.join(root, 'server.mjs'), 'utf8'), 'new server');
  assert.ok(fs.existsSync(path.join(root, 'dist/new.js')));
  assert.equal(fs.existsSync(path.join(root, 'dist/old.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'ops')), false);
  assert.ok(fs.existsSync(path.join(root, 'node_modules')));
  assert.equal(fs.readFileSync(path.join(prev, 'server.mjs'), 'utf8'), 'old server');
  assert.ok(fs.existsSync(path.join(prev, 'dist/old.js')) && fs.existsSync(path.join(prev, 'ops')));
  assert.equal(fs.readFileSync(path.join(root, 'data/homepage.db'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=1');
  // rollback = the same move with prev as the source; the current install goes to a trash dir
  const trash = path.join(dir, 'trash');
  swapTree(root, prev, trash, moved);
  assert.equal(fs.readFileSync(path.join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.ok(fs.existsSync(path.join(root, 'dist/old.js')) && fs.existsSync(path.join(root, 'ops')));
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  assert.equal(fs.readFileSync(path.join(trash, 'server.mjs'), 'utf8'), 'new server');
  assert.ok(!SHIPPED.includes('data') && !SHIPPED.includes('.env') && !SHIPPED.includes('.update'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('policy: notify by default, only the three values, and this test process is a node install', () => {
  assert.equal(updatePolicy(), 'notify');
  assert.equal(setUpdatePolicy('install'), 'install');
  assert.equal(updatePolicy(), 'install');
  assert.throws(() => setUpdatePolicy('yes'), /off, notify or install/);
  assert.equal(updatePolicy(), 'install');
  setUpdatePolicy('notify');
  assert.equal(installKind(), 'node');
});
