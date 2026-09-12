import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { APIContext } from 'astro';
import { getDb } from '../src/lib/db.ts';
import { createUser } from '../src/lib/users.ts';
import { saveDashboard, getDashboard } from '../src/lib/dashboard.ts';
import { deleteSetting, setSetting } from '../src/lib/settings.ts';
import { createNote, ensureNotebook } from '../src/lib/notebook.ts';
import { writeNote } from '../src/lib/note.ts';
import type { Session } from '../src/lib/auth.ts';
import {
  SHARE_NOTEBOOK_OPS, SHARE_TOKEN_RE, createShare, findShareByToken, joinPresence, listShares, resolveShare, revokeShare, setShareRole, shareAllows, shareEvent,
  shareOwnerName, shareScope, shareSnapshot, shareStatusScope, shareStillAllows, shareWards, sharedWithMe, verifyShareToken, shareLocals, sharePrincipal, type ShareScope,
} from '../src/lib/shares.ts';
import { GET as notebookGet } from '../src/pages/api/notebook/[ward].ts';
import { shareNotionBlock, shareNotionPage, shareNotionWard } from '../src/lib/share-notion.ts';
import { POST as browserPost } from '../src/pages/api/browser/[ward].ts';
import { GET as meGet } from '../src/pages/api/me.ts';
import { GET as notesGet } from '../src/pages/api/notes.ts';
import { GET as sharesGet, POST as sharesPost } from '../src/pages/api/share/index.ts';
import { DELETE as shareDelete, GET as shareGet } from '../src/pages/api/share/[id].ts';
import { PUT as dashboardPut } from '../src/pages/api/dashboard.ts';
import { createSession } from '../src/lib/auth.ts';
import { principalAlive, upgradeSession } from '../src/lib/live-stream.ts';
import type http from 'node:http';

const owner = createUser('owner@example.com', 'pw-owner-1');
const viewer = createUser('viewer@example.com', 'pw-viewer-1');
const stranger = createUser('stranger@example.com', 'pw-stranger-1');
const session = (userId: number, displayName: string): Session => ({ userId, email: '', role: 'member', displayName, theme: null });
const viewerS = session(viewer, 'Vera Viewer'), strangerS = session(stranger, 'Sam'), ownerS = session(owner, 'Olive Owner');

saveDashboard(owner, [
  { i: 'pad', type: 'note', size: '2x2' },
  { i: 'book', type: 'notebook', size: '2x2' },
  { i: 'web', type: 'browser', size: '2x2', config: { url: 'https://example.com' } },
  { i: 'svc', type: 'service-group', size: '2x2', config: { services: ['site'] } },
  { i: 'mail', type: 'mail', size: '1x1' },
  { i: 'grp', type: 'container', size: '2x2' },
  { i: 'w2', type: 'weather', size: '1x1', in: 'grp' },
  { i: 'flow1', type: 'flow', size: '2x1', page: 'ops' },
  { i: 'inc', type: 'incidents', size: '2x1', page: 'ops' },
  { i: 'btn', type: 'button', size: '1x1', page: 'ctl' },
  { i: 'tmr', type: 'timer', size: '1x1', page: 'ctl' },
  { i: 'cal', type: 'calendar', size: '2x2', page: 'ctl' },
  { i: 'ndb', type: 'notion-db', size: '3x2', page: 'ctl', config: { db: '0123456789abcdef0123456789abcdef' } },
  { i: 'npg', type: 'notion-page', size: '2x2', page: 'ctl', config: { page: 'fedcba9876543210fedcba9876543210' } },
  { i: 'term', type: 'terminal', size: '3x3', page: 'ctl', device: '11111111-2222-3333-4444-555555555555' },
], [{ id: 'home', title: 'Home' }, { id: 'ops', title: 'Ops' }, { id: 'ctl', title: 'Controls' }]);
assert.ok(getDashboard(owner).some((w) => w.i === 'web'), 'the browser ward survived validation');
ensureNotebook(owner, 'book', 'Book');
const inBook = createNote(owner, { notebook: 'book', title: 'Filed' }).id;
writeNote(owner, 'loose', { html: '<p>unfiled</p>' });

const ctx = (userId: number, url: string, init?: RequestInit, share?: ReturnType<typeof shareLocals>) =>
  ({ locals: { user: session(userId, 'x'), ...(share ? { share } : {}) }, url: new URL(url), request: new Request(url, init), params: { id: url.split('/api/share/')[1]?.split(/[/?]/)[0] } }) as unknown as APIContext;
const scopeOf = (id: string, s: Session | null = viewerS, token?: string): ShareScope => {
  const scope = shareScope(id, s, token);
  assert.equal(typeof scope, 'object', `scope for ${id}`);
  return scope as ShareScope;
};
const allows = (scope: ShareScope, method: string, path: string) => shareAllows(scope, method, new URL(path, 'https://x.invalid'));

test('shareWards: the ceiling per type, groups carry their children, pages carry their wards', () => {
  assert.throws(() => createShare(owner, { kind: 'ward', target: 'mail', email: 'viewer@example.com' }), /nothing there/);
  assert.deepEqual(shareWards({ owner, kind: 'ward', target: 'grp' }).map((w) => w.i), ['grp', 'w2']);
  assert.deepEqual(shareWards({ owner, kind: 'page', target: 'ops' }).map((w) => w.i), ['flow1', 'inc']);
  assert.deepEqual(shareWards({ owner, kind: 'page', target: 'home' }).map((w) => w.i), ['pad', 'book', 'web', 'svc', 'grp', 'w2']);
  assert.deepEqual(shareWards({ owner, kind: 'ward', target: 'nope' }), []);
});

test('a person share: by exact email, re-shared = re-roled, never yourself, edit only where the type allows', () => {
  const { share, token } = createShare(owner, { kind: 'ward', target: 'pad', email: 'viewer@example.com', role: 'edit' });
  assert.equal(token, undefined);
  assert.equal(share.grantee, viewer);
  assert.equal(share.role, 'edit');
  const mine = sharedWithMe(viewer);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.type, 'note');
  assert.equal(mine[0]!.owner, 'owner');
  assert.equal(listShares(owner)[0]!.grantee?.email, 'viewer@example.com');
  const again = createShare(owner, { kind: 'ward', target: 'pad', email: 'VIEWER@example.com', role: 'view' });
  assert.equal(again.share.id, share.id, 'one row per (target, person)');
  assert.equal(resolveShare(share.id)!.role, 'view');
  assert.throws(() => createShare(owner, { kind: 'ward', target: 'pad', email: 'nobody@example.com' }), /no account/);
  assert.throws(() => createShare(owner, { kind: 'ward', target: 'pad', email: 'owner@example.com' }), /that is you/);
  assert.throws(() => createShare(owner, { kind: 'ward', target: 'svc', email: 'viewer@example.com', role: 'edit' }), /view-only/);
  assert.equal(setShareRole(owner, share.id, 'edit').role, 'edit');
  assert.throws(() => setShareRole(viewer, share.id, 'view'), /no such share/);
});

test('shareScope: the grantee, the owner previewing, nobody else', () => {
  const id = listShares(owner)[0]!.id;
  assert.equal(typeof shareScope(id, viewerS, undefined), 'object');
  assert.equal(typeof shareScope(id, ownerS, undefined), 'object');
  assert.equal(shareScope(id, strangerS, undefined), 403);
  assert.equal(shareScope(id, null, undefined), 403);
  assert.equal(shareScope('nope00000000', viewerS, undefined), 404);
  assert.equal(shareScope('../etc', viewerS, undefined), 404);
  const p = sharePrincipal(scopeOf(id), 'owner');
  assert.equal(p.userId, owner);
  assert.equal(p.role, 'member');
  assert.equal(p.email, '');
  const l = shareLocals(scopeOf(id));
  assert.equal(l.viewer, viewer);
  assert.equal(l.viewerName, 'Vera Viewer');
});

test('shareAllows: only the shared documents and browser, only what the role permits', () => {
  const pad = scopeOf(listShares(owner)[0]!.id); // pad, edit
  assert.ok(allows(pad, 'GET', '/api/note/pad?ward=pad'));
  assert.ok(allows(pad, 'PUT', '/api/note/pad?ward=pad'));
  assert.ok(allows(pad, 'POST', '/api/note/pad?ward=pad'));
  assert.ok(!allows(pad, 'GET', '/api/note/loose?ward=pad'), 'another document through the shared notepad');
  assert.ok(!allows(pad, 'GET', '/api/note/pad'), 'no host ward = no scope');
  assert.ok(!allows(pad, 'GET', '/api/dashboard'));
  assert.ok(!allows(pad, 'PUT', '/api/dashboard'));
  assert.ok(!allows(pad, 'GET', '/api/logic/stream'));
  assert.ok(!allows(pad, 'GET', '/api/agent/pad'));
  assert.ok(!allows(pad, 'GET', '/api/notes'), 'no notebook in this share');
  assert.ok(!allows(pad, 'POST', '/api/browser/web'), 'not in this share');
  assert.ok(allows(pad, 'GET', '/api/me'));
  assert.ok(allows(pad, 'GET', `/api/share/${pad.share.id}/stream`));
  assert.ok(!allows(pad, 'GET', '/api/share/other0000000/stream'));
  setShareRole(owner, pad.share.id, 'view');
  const padView = scopeOf(pad.share.id);
  assert.ok(allows(padView, 'GET', '/api/note/pad?ward=pad'));
  assert.ok(!allows(padView, 'PUT', '/api/note/pad?ward=pad'));
  assert.ok(!allows(padView, 'POST', '/api/note/pad?ward=pad'));

  const book = scopeOf(createShare(owner, { kind: 'ward', target: 'book', email: 'viewer@example.com', role: 'edit' }).share.id);
  assert.ok(allows(book, 'GET', `/api/note/${inBook}?ward=book`));
  assert.ok(allows(book, 'PUT', `/api/note/${inBook}?ward=book`));
  assert.ok(!allows(book, 'GET', '/api/note/loose?ward=book'), 'a document outside the notebook');
  assert.ok(allows(book, 'GET', '/api/notebook/book'));
  assert.ok(allows(book, 'POST', '/api/notebook/book'));
  assert.ok(allows(book, 'GET', '/api/notes'));
  assert.ok(!SHARE_NOTEBOOK_OPS.has('link') && !SHARE_NOTEBOOK_OPS.has('purge') && SHARE_NOTEBOOK_OPS.has('create'));

  const web = scopeOf(createShare(owner, { kind: 'ward', target: 'web', email: 'viewer@example.com', role: 'edit' }).share.id);
  assert.ok(allows(web, 'POST', '/api/browser/web'));
  assert.ok(allows(web, 'POST', '/api/browser/web?share=' + web.share.id));
  assert.ok(!allows(web, 'POST', '/api/browser/web?extension=restart'));
  assert.ok(!allows(web, 'GET', '/api/browser/web?download=abc'));
  assert.ok(allows(web, 'GET', '/api/browser/stream/web'));
  assert.ok(allows(web, 'GET', '/api/browser/ws/web'));
  assert.ok(!allows(web, 'GET', '/api/status'), 'no status ward in this share');

  const home = scopeOf(createShare(owner, { kind: 'page', target: 'home', email: 'viewer@example.com' }).share.id);
  assert.ok(allows(home, 'GET', '/api/status'));
  assert.ok(allows(home, 'GET', '/api/weather?ward=w2'));
  assert.ok(!allows(home, 'GET', '/api/weather?ward=flow1'));
  assert.ok(allows(home, 'GET', '/api/bg/1-photo.webp'));
  assert.ok(!allows(home, 'POST', '/api/browser/web'), 'a view share never drives');
});

test('links: view-only, token verified by hash, expiry ends them, off on the desktop or by the admin', () => {
  assert.throws(() => createShare(owner, { kind: 'ward', target: 'svc', role: 'edit' }), /view-only/);
  const { share, token } = createShare(owner, { kind: 'ward', target: 'svc', expiresIn: 3600 });
  assert.ok(token && SHARE_TOKEN_RE.test(token));
  assert.equal(share.grantee, null);
  assert.ok(share.expiresAt);
  assert.equal(findShareByToken(token)?.id, share.id);
  assert.equal(findShareByToken('x'.repeat(43)), null);
  assert.ok(verifyShareToken(share, token));
  assert.ok(!verifyShareToken(share, token!.slice(0, 42) + (token!.endsWith('A') ? 'B' : 'A')));
  assert.equal(typeof shareScope(share.id, null, token), 'object');
  assert.equal(shareScope(share.id, null, undefined), 403);
  assert.equal(shareScope(share.id, viewerS, undefined), 403, 'a signed-in stranger still needs the token');
  assert.equal(typeof shareScope(share.id, ownerS, undefined), 'object', 'the owner previews');
  assert.equal(sharedWithMe(viewer).some((s) => s.id === share.id), false, 'links are nobody’s');
  assert.ok(listShares(owner).find((s) => s.id === share.id)?.link);
  getDb().prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', share.id);
  assert.equal(resolveShare(share.id), null, 'expired on first look');
  assert.equal(findShareByToken(token), null);

  setSetting('share_links', '0');
  try { assert.throws(() => createShare(owner, { kind: 'ward', target: 'svc' }), /turned off/); } finally { deleteSetting('share_links'); }
  const env = { desktop: process.env.RIMEWARD_DESKTOP, token: process.env.RIMEWARD_NATIVE_TOKEN };
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test';
  try { assert.throws(() => createShare(owner, { kind: 'ward', target: 'svc' }), /need a server/); } finally {
    if (env.desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = env.desktop;
    if (env.token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = env.token;
  }
  assert.ok(createShare(owner, { kind: 'ward', target: 'svc' }).token, 'a person share and a link share on one target coexist');
});

test('status inside a share: only the services its wards show, host and incidents only when asked for', () => {
  const svc = shareWards({ owner, kind: 'ward', target: 'svc' });
  const scope = shareStatusScope(svc);
  assert.deepEqual([...scope.services], ['site']);
  assert.equal(scope.host, false);
  assert.equal(scope.incidents, false);
  assert.equal(shareStatusScope(shareWards({ owner, kind: 'page', target: 'ops' })).incidents, true);
  const snap = { at: 'now', baselineAt: 'now', alerts: ['site is down'], host: { disk: { usedPct: 40, freeGb: 10 }, mem: { usedPct: 50 }, load: [1], cores: 4 },
    services: [{ id: 'site', label: 'a', group: 'g', kind: 'http' as const, ok: true, latencyMs: 1, detail: '', since: null }, { id: 'self', label: 'b', group: 'g', kind: 'http' as const, ok: false, latencyMs: 1, detail: '', since: null }] };
  const out = shareSnapshot(snap, svc);
  assert.deepEqual(out.services.map((s) => s.id), ['site']);
  assert.deepEqual(out.alerts, []);
  assert.equal(out.host.cores, 0);
});

test('shareEvent: the share’s wards and documents only; a layout change is a reload', () => {
  const pad = scopeOf(listShares(owner).find((s) => s.target === 'pad')!.id);
  const book = scopeOf(listShares(owner).find((s) => s.target === 'book')!.id);
  assert.ok(shareEvent(pad, 'note', { ward: 'pad', note: 'pad', rev: 2 }));
  assert.equal(shareEvent(pad, 'note', { ward: 'other', note: 'other' }), undefined);
  assert.ok(shareEvent(book, 'note', { note: inBook }));
  assert.equal(shareEvent(book, 'note', { note: 'loose' }), undefined);
  assert.ok(shareEvent(book, 'notebook', { notebook: 'book' }));
  assert.equal(shareEvent(pad, 'notebook', { notebook: 'book' }), undefined);
  assert.deepEqual(shareEvent(pad, 'refresh', { type: 'note', link: 'google' }), { event: 'refresh', data: { type: 'note' } });
  assert.equal(shareEvent(pad, 'refresh', { link: 'google' }), undefined);
  // The owner rearranged: a reload only when what THIS share shows changed — a collaborator mid-sentence is not interrupted for a page rename.
  assert.equal(shareEvent(pad, 'layout', { layout: [] }), undefined, 'nothing of the share moved');
  const layout = getDashboard(owner);
  saveDashboard(owner, layout.map((w) => (w.i === 'pad' ? { ...w, size: '3x2' as const } : w)));
  assert.deepEqual(shareEvent(pad, 'layout', {}), { event: 'reload', data: {} }, 'the shared ward changed');
  assert.equal(shareEvent(pad, 'layout', {}), undefined, 'and the scope followed it');
  saveDashboard(owner, layout);
  for (const ev of ['agent', 'agent-live', 'act', 'packets', 'runs', 'theme']) assert.equal(shareEvent(pad, ev, { ward: 'pad' }), undefined, ev);
});

test('a stream re-checks its share on every beat: revoke, role change or the ward leaving end it; the mux is allowed in', async () => {
  const { share } = createShare(owner, { kind: 'ward', target: 'pad', email: 'stranger@example.com', role: 'edit' });
  const url = new URL('https://x.invalid/api/note/pad?ward=pad');
  const scope = scopeOf(share.id, strangerS);
  assert.ok(allows(scope, 'GET', '/api/live/stream'), 'the socket mux; each subscription inside it is checked on its own');
  assert.ok(!allows(scope, 'POST', '/api/live/stream'));
  assert.ok(shareStillAllows(share, 'GET', url));
  setShareRole(owner, share.id, 'view');
  assert.ok(!shareStillAllows(share, 'GET', url), 'the role it was opened with is gone');
  assert.ok(shareStillAllows({ id: share.id, role: 'view' }, 'GET', url));
  const layout = getDashboard(owner);
  saveDashboard(owner, layout.filter((w) => w.i !== 'pad'));
  assert.ok(!shareStillAllows({ id: share.id, role: 'view' }, 'GET', url), 'the ward left the layout');
  saveDashboard(owner, layout);
  assert.ok(shareStillAllows({ id: share.id, role: 'view' }, 'GET', url));
  revokeShare(owner, share.id);
  assert.ok(!shareStillAllows({ id: share.id, role: 'view' }, 'GET', url));
  // What the SSE routes re-check carries the grantee's session; a link holder's does not.
  const granted = createShare(owner, { kind: 'ward', target: 'pad', email: 'stranger@example.com', role: 'view' }).share;
  assert.equal(shareLocals(scopeOf(granted.id, strangerS), 'sid-1').principal, `share:${granted.id}:sid-1`);
  setSetting('share_links', '1');
  const link = createShare(owner, { kind: 'ward', target: 'pad' });
  const anon = scopeOf(link.share.id, null, link.token);
  assert.equal(shareLocals(anon, 'sid-1').principal, `share:${link.share.id}`);
  // A link holder learns no email local part and no viewer names; a signed-in viewer and the owner do.
  assert.equal(shareOwnerName(owner), 'owner');
  assert.equal(shareOwnerName(owner, true), 'Someone');
  assert.equal(shareLocals(anon).owner, 'Someone');
  const seenByVera: unknown[] = [], seenByGuest: unknown[] = [];
  const leaveVera = joinPresence(anon, 'Vera Viewer', (d) => seenByVera.push(d));
  const leaveGuest = joinPresence(anon, 'Guest', (d) => seenByGuest.push(d), true);
  assert.deepEqual((seenByVera.at(-1) as { viewers: string[] }).viewers, ['Vera Viewer', 'Guest']);
  assert.deepEqual((seenByGuest.at(-1) as { viewers: string[] }).viewers, ['Viewer', 'Viewer']);
  leaveVera(); leaveGuest();
  revokeShare(owner, granted.id); revokeShare(owner, link.share.id);
});

test('inside a share the routes narrow: no browser actions in the body, no other notepads on offer', async () => {
  const web = createShare(owner, { kind: 'ward', target: 'web', email: 'stranger@example.com', role: 'edit' }).share;
  const webCtx = (body: unknown) => ({ locals: { user: sharePrincipal(scopeOf(web.id, strangerS), 'owner'), share: shareLocals(scopeOf(web.id, strangerS)) }, params: { ward: 'web' }, url: new URL('https://x.invalid/api/browser/web'), request: new Request('https://x.invalid/api/browser/web', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }) as unknown as APIContext;
  const refused = await browserPost(webCtx({ action: 'download', args: { url: 'https://example.com/x' } }));
  assert.equal(refused.status, 403, 'an action on the owner’s behalf, even under edit');
  const book = createShare(owner, { kind: 'ward', target: 'book', email: 'stranger@example.com', role: 'edit' }).share;
  const res = await notebookGet({ locals: { user: sharePrincipal(scopeOf(book.id, strangerS), 'owner'), share: shareLocals(scopeOf(book.id, strangerS)) }, params: { ward: 'book' }, url: new URL('https://x.invalid/api/notebook/book') } as unknown as APIContext);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).linkable, [], 'the owner’s unshared notepads stay unnamed');
  revokeShare(owner, web.id); revokeShare(owner, book.id);
});

test('routes: /api/me and /api/notes inside a share, the share CRUD as owner, grantee and stranger', async () => {
  const book = scopeOf(listShares(owner).find((s) => s.target === 'book')!.id);
  const me = await (await meGet(ctx(owner, 'https://x.invalid/api/me', undefined, shareLocals(book)))).json();
  assert.equal(me.id, viewer);
  assert.equal(me.displayName, 'Vera Viewer');
  assert.deepEqual(Object.values(me.links), [false, false, false, false, false, false]);
  assert.equal(me.share.role, 'edit');
  const notes = await (await notesGet(ctx(owner, 'https://x.invalid/api/notes', undefined, shareLocals(book)))).json();
  assert.deepEqual(notes.notes.map((n: { id: string }) => n.id), [inBook]);
  const all = await (await notesGet(ctx(owner, 'https://x.invalid/api/notes'))).json();
  assert.ok(all.notes.some((n: { id: string }) => n.id === 'loose'), 'the owner still sees everything');

  const created = await (await sharesPost(ctx(owner, 'https://x.invalid/api/share', { method: 'POST', body: JSON.stringify({ kind: 'ward', target: 'grp', email: 'viewer@example.com' }) }))).json();
  assert.equal(created.share.kind, 'ward');
  assert.equal(created.token, undefined);
  const incoming = await (await sharesGet(ctx(viewer, 'https://x.invalid/api/share?incoming=1'))).json();
  assert.ok(incoming.shares.some((s: { id: string }) => s.id === created.share.id));
  const listed = await (await sharesGet(ctx(owner, 'https://x.invalid/api/share'))).json();
  assert.equal(typeof listed.links, 'boolean');
  assert.equal((await shareGet(ctx(stranger, `https://x.invalid/api/share/${created.share.id}`))).status, 404);
  const info = await (await shareGet(ctx(viewer, `https://x.invalid/api/share/${created.share.id}`))).json();
  assert.equal(info.type, 'container');
  assert.equal(info.owner, 'owner');
  assert.equal((await shareDelete(ctx(stranger, `https://x.invalid/api/share/${created.share.id}`, { method: 'DELETE' }))).status, 404);
  assert.equal((await shareDelete(ctx(owner, `https://x.invalid/api/share/${created.share.id}`, { method: 'DELETE' }))).status, 200);
  assert.equal(resolveShare(created.share.id), null);
  assert.equal((await sharesPost(ctx(owner, 'https://x.invalid/api/share', { method: 'POST', body: '{"kind":"ward","target":"mail"}' }))).status, 400);
  assert.equal((await sharesGet(ctx(owner, 'https://x.invalid/api/share', undefined, shareLocals(book)))).status, 403, 'never from inside a share');
  assert.ok(revokeShare(owner, book.share.id));
  assert.equal(shareScope(book.share.id, viewerS, undefined), 404);
});

test('PUT /api/dashboard: a shared ward or page must be one of MY shares; a vanished one keeps its card', async () => {
  const { share } = createShare(owner, { kind: 'ward', target: 'svc', email: 'viewer@example.com' });
  const put = (user: number, layout: unknown, pages?: unknown) =>
    dashboardPut(ctx(user, 'https://x.invalid/api/dashboard', { method: 'PUT', body: JSON.stringify({ layout, pages }) }));
  const shared = [{ i: 's1', type: 'shared', size: '2x2', config: { share: share.id } }];
  assert.equal((await put(viewer, shared)).status, 200);
  assert.equal((await put(stranger, shared)).status, 400, 'somebody else’s share');
  const pages = [{ id: 'home', title: 'Home' }, { id: 'p', title: 'Theirs', share: share.id }];
  assert.equal((await put(viewer, [{ i: 'w', type: 'weather', size: '1x1' }], pages)).status, 200);
  assert.equal((await put(stranger, [{ i: 'w', type: 'weather', size: '1x1' }], pages)).status, 400);
  assert.equal((await put(viewer, [{ i: 's1', type: 'shared', size: '2x2', config: { share: 'gone00000000' } }])).status, 200, 'revoked: the card says so, the layout still saves');
});

test('socket upgrades inside a share: the owner as principal on the server, forwarded from a desktop', () => {
  const { share } = createShare(owner, { kind: 'ward', target: 'web', email: 'viewer@example.com', role: 'edit' });
  const sid = createSession(viewer).id;
  const req = (url: string, cookie?: string) => ({ headers: { origin: 'http://localhost:4321', host: 'localhost:4321', cookie }, url }) as unknown as http.IncomingMessage;
  const ok = upgradeSession(req(`/api/browser/ws/web?share=${share.id}`, `rimeward_session=${sid}`));
  assert.equal(typeof ok, 'object');
  assert.equal((ok as { userId: number }).userId, owner, 'the principal is the owner');
  assert.equal((ok as { id: string }).id, `share:${share.id}:${sid}`);
  assert.ok(principalAlive((ok as { id: string }).id));
  assert.equal(upgradeSession(req(`/api/browser/ws/web?share=${share.id}`)), 403, 'a grantee share needs the grantee');
  assert.equal(upgradeSession(req(`/api/browser/ws/pad?share=${share.id}`, `rimeward_session=${sid}`)), 403, 'not this share’s ward');
  assert.equal(upgradeSession(req('/api/browser/ws/web?share=nope00000000', `rimeward_session=${sid}`)), 404);
  const env = { desktop: process.env.RIMEWARD_DESKTOP, token: process.env.RIMEWARD_NATIVE_TOKEN };
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test';
  try {
    const fwd = upgradeSession(req(`/api/live/stream?share=${share.id}`, `rimeward_session=${sid}`));
    assert.equal((fwd as { forward?: string }).forward, share.id, 'a desktop forwards instead of judging');
    assert.equal((fwd as { userId: number }).userId, viewer);
    assert.equal(upgradeSession(req(`/api/live/stream?share=${share.id}`)), 401);
  } finally {
    if (env.desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = env.desktop;
    if (env.token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = env.token;
  }
  revokeShare(owner, share.id);
  assert.ok(!principalAlive(`share:${share.id}:${sid}`), 'a revoked share ends its sockets');
});

test('controls and Notion inside a share: button and timer under edit, the agenda no wider than five days, Notion pinned to the wards’ own pages and lists', async () => {
  assert.ok(getDashboard(owner).some((w) => w.i === 'npg') && getDashboard(owner).some((w) => w.i === 'ndb'), 'the Notion wards survived validation');
  const ctl = scopeOf(createShare(owner, { kind: 'page', target: 'ctl', email: 'viewer@example.com', role: 'edit' }).share.id);
  assert.ok(allows(ctl, 'POST', '/api/button/btn'));
  assert.ok(!allows(ctl, 'POST', '/api/button/pad'), 'not a button');
  assert.ok(allows(ctl, 'GET', '/api/timers/tmr') && allows(ctl, 'POST', '/api/timers/tmr'));
  assert.ok(allows(ctl, 'GET', '/api/calendar?days=5') && allows(ctl, 'GET', '/api/calendar'));
  assert.ok(!allows(ctl, 'GET', '/api/calendar?days=31'), 'no wider than the wards read it');
  assert.ok(allows(ctl, 'GET', '/api/notion/source?ward=ndb&rows=1'));
  assert.ok(!allows(ctl, 'GET', '/api/notion/source?ward=ndb&db=0123456789abcdef0123456789abcdef'), 'never a database the caller names');
  assert.ok(!allows(ctl, 'GET', '/api/notion/source?ward=npg'), 'not through a page ward');
  assert.ok(allows(ctl, 'GET', '/api/checklist?ward=ndb') && allows(ctl, 'POST', '/api/checklist') && allows(ctl, 'PATCH', '/api/checklist/abc'));
  assert.ok(allows(ctl, 'GET', '/api/notion/page?id=x') && allows(ctl, 'PATCH', '/api/notion/page') && allows(ctl, 'POST', '/api/notion/block') && allows(ctl, 'POST', '/api/notion/capture'));
  assert.ok(allows(ctl, 'GET', '/api/notion/users'), 'the people picker, for an editor');
  assert.ok(!allows(ctl, 'GET', '/api/notion/search?q=x') && !allows(ctl, 'GET', '/api/notion/recent') && !allows(ctl, 'GET', '/api/notion/config'), 'never the whole workspace');
  assert.deepEqual(shareEvent(ctl, 'refresh', { link: 'notion' }), { event: 'refresh', data: { link: 'notion' } });
  assert.equal(shareEvent(scopeOf(listShares(owner).find((s) => s.target === 'pad')!.id), 'refresh', { link: 'notion' }), undefined);
  // The per-id questions the routes ask (share-notion.ts): the wards' own page and nothing else; a page the
  // config names costs no Notion call, and with no Notion link here every other lookup fails closed.
  const locals = shareLocals(ctl);
  assert.equal(await shareNotionPage(locals, owner, 'fedcba98-7654-3210-fedc-ba9876543210'), true);
  assert.equal(await shareNotionPage(locals, owner, 'FEDCBA9876543210FEDCBA9876543210'), true, 'however the id is spelled');
  assert.equal(await shareNotionPage(locals, owner, '00000000-0000-0000-0000-000000000000'), false);
  assert.equal(await shareNotionBlock(locals, owner, '00000000-0000-0000-0000-000000000000'), false);
  assert.equal(await shareNotionBlock(locals, owner, 'fedcba9876543210fedcba9876543210'), true, 'the page itself is a block parent');
  assert.ok(shareNotionWard(locals, 'ndb') && !shareNotionWard(locals, 'npg') && !shareNotionWard(locals, 'pad'));
  setShareRole(owner, ctl.share.id, 'view');
  const view = scopeOf(ctl.share.id);
  assert.ok(!allows(view, 'POST', '/api/button/btn') && !allows(view, 'POST', '/api/timers/tmr') && !allows(view, 'GET', '/api/notion/users'));
  assert.ok(allows(view, 'GET', '/api/timers/tmr') && allows(view, 'GET', '/api/notion/source?ward=ndb&rows=1') && allows(view, 'GET', '/api/calendar'));
  revokeShare(owner, ctl.share.id);
});

test('a shared terminal: its own view, its sessions and their stream, the runtime’s capabilities — every call pinned to the ward, never a write', () => {
  assert.equal(getDashboard(owner).find((w) => w.i === 'term')?.device, '11111111-2222-3333-4444-555555555555', 'the ward keeps its desktop');
  const ctl = scopeOf(createShare(owner, { kind: 'page', target: 'ctl', email: 'viewer@example.com', role: 'edit' }).share.id);
  for (const path of ['/api/dev/events?_ward=term', '/api/dev/view?id=term&_ward=term', '/api/dev/sessions?project=p1&_ward=term', '/api/dev/sessions?id=s1&after=3&_ward=term', '/api/dev/capabilities?_ward=term']) assert.ok(allows(ctl, 'GET', path), path);
  for (const path of ['/api/dev/events', '/api/dev/events?_ward=pad', '/api/dev/view?id=pad&_ward=term', '/api/dev/sessions?_ward=term', '/api/dev/projects?_ward=term', '/api/dev/project-defaults?_ward=term', '/api/dev/session-resources?project=p1&_ward=term', '/api/dev/files?project=p1&path=.&_ward=term', '/api/dev/git?project=p1&_ward=term', '/api/dev/buffer?project=p1&path=x&_ward=term']) assert.ok(!allows(ctl, 'GET', path), path);
  for (const path of ['/api/dev/input?_ward=term', '/api/dev/control?_ward=term', '/api/dev/sessions?_ward=term', '/api/dev/restart?_ward=term', '/api/dev/view?_ward=term']) assert.ok(!allows(ctl, 'POST', path), `${path} — view only, whatever the role`);
  assert.ok(!allows(ctl, 'DELETE', '/api/dev/sessions?id=s1&_ward=term'));
  revokeShare(owner, ctl.share.id);
});
