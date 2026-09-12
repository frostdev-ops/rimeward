// Ward and page sharing. A share is one row (migration 031): the OWNER's ward or page,
// granted to another user of this instance (view or edit) or to anyone holding a link
// (always view, server instances only). Nothing about ownership changes anywhere else:
// a request inside a share runs AS THE OWNER (middleware swaps `locals.user`) and is
// restricted to `shareAllows`, a positive allowlist of the routes the shared wards
// need. The owner's layout stays the registry — `shareWards` reads it on every request,
// so a ward leaving the layout ends the share's reach at once.
import crypto from 'node:crypto';
import { getSession, type Session } from './auth.ts';
import { getDb } from './db.ts';
import { getDashboard, getPages } from './dashboard.ts';
import { isDesktop } from './dev/runtime.ts';
import { broadcast } from './logic-engine.ts';
import { getNoteMeta, noteIdOf } from './note.ts';
import { notebookIdOf } from './notebook.ts';
import { siteInfo } from './site.ts';
import type { Snapshot } from './status.ts';
import { getUser, getUserByEmail } from './users.ts';
import { CATALOG, pageOf, shownServiceIds, wardTitle, type PageDef, type WardInstance } from './wards.ts';

export type ShareRole = 'view' | 'edit';
export type ShareKind = 'ward' | 'page';
export const SHARE_ROLES: readonly ShareRole[] = ['view', 'edit'];
export const SHARE_ID_RE = /^[a-z0-9]{12}$/;
/** 32 random bytes, base64url. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** The cookie a link landing sets, one per share so several links coexist. */
export const shareCookie = (id: string): string => `rw_share_${id}`;
/** Longest a link may live; 0 = never expires. */
export const SHARE_MAX_TTL_S = 366 * 86400;

export interface Share {
  id: string;
  owner: number;
  kind: ShareKind;
  target: string;
  /** Null = an anyone-with-the-link share. */
  grantee: number | null;
  role: ShareRole;
  expiresAt: string | null;
  createdAt: string;
  /** Link shares only; never leaves this module. */
  tokenHash: string | null;
}
/** A resolved share plus the owner's wards it covers and who is looking. */
export interface ShareScope {
  share: Share;
  wards: WardInstance[];
  viewer: Session | null;
}
/** What the middleware hangs on `locals.share` for routes that behave differently inside a share. */
export interface ShareLocals {
  id: string;
  role: ShareRole;
  kind: ShareKind;
  target: string;
  /** The owner's display name — what the share page shows. */
  owner: string;
  viewer: number | null;
  viewerName: string | null;
  /** What a stream re-checks on every beat (live-stream.ts principalAlive): the share, plus the grantee's session. */
  principal: string;
  wards: WardInstance[];
}

type Row = { id: string; owner_id: number; kind: ShareKind; target: string; grantee_id: number | null; role: ShareRole; token_hash: string | null; expires_at: string | null; created_at: string };
const COLS = 'id, owner_id, kind, target, grantee_id, role, token_hash, expires_at, created_at';
const fromRow = (r: Row): Share => ({ id: r.id, owner: r.owner_id, kind: r.kind, target: r.target, grantee: r.grantee_id, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at, tokenHash: r.token_hash });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newShareId = (): string => {
  let id = '';
  while (id.length < 12) id += crypto.randomInt(36).toString(36);
  return id;
};

/** Public links exist on a server whose admin has not turned them off; never on the desktop runtime. */
export const linksEnabled = (): boolean => !isDesktop() && siteInfo().links;

/** The most a ward of this type may be shared as; undefined = not shareable (CATALOG.share). */
export const shareCeiling = (w: WardInstance): ShareRole | undefined => CATALOG[w.type]?.share;

/** An expired row is gone the moment anyone looks at it. */
function fresh(r: Row | undefined): Share | null {
  if (!r) return null;
  if (r.expires_at && r.expires_at < new Date().toISOString()) {
    getDb().prepare('DELETE FROM shares WHERE id = ?').run(r.id);
    return null;
  }
  return fromRow(r);
}

export function resolveShare(id: unknown): Share | null {
  if (typeof id !== 'string' || !SHARE_ID_RE.test(id)) return null;
  return fresh(getDb().prepare(`SELECT ${COLS} FROM shares WHERE id = ?`).get(id) as Row | undefined);
}
export function findShareByToken(token: unknown): Share | null {
  if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return null;
  return fresh(getDb().prepare(`SELECT ${COLS} FROM shares WHERE token_hash = ?`).get(sha256(token)) as Row | undefined);
}
export function verifyShareToken(share: Share, token: unknown): boolean {
  if (!share.tokenHash || typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return false;
  const a = Buffer.from(sha256(token), 'hex'), b = Buffer.from(share.tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The owner's wards a share covers, in layout order: the ward (or, for a page, the
 *  page's top-level wards) plus the children of any group among them, each only if
 *  its type is shareable. A page share skips hidden wards; a ward share is explicit. */
export function shareWards(share: Pick<Share, 'owner' | 'kind' | 'target'>, layout = getDashboard(share.owner), pages = getPages(share.owner)): WardInstance[] {
  const tops = share.kind === 'ward'
    ? layout.filter((w) => w.i === share.target)
    : layout.filter((w) => !w.in && !w.hidden && pageOf(w, pages, layout) === share.target);
  const out: WardInstance[] = [];
  for (const w of tops) {
    if (shareCeiling(w)) out.push(w);
    if (w.type === 'container') for (const c of layout) if (c.in === w.i && !c.hidden && shareCeiling(c)) out.push(c);
  }
  return out;
}
export function shareTitle(share: Pick<Share, 'owner' | 'kind' | 'target'>, wards: WardInstance[], pages = getPages(share.owner)): string {
  if (share.kind === 'page') return pages.find((p) => p.id === share.target)?.title ?? 'Page';
  const w = wards.find((x) => x.i === share.target);
  return w ? wardTitle(w) : 'Ward';
}
/** The owner as the share names them; a link holder (anonymous) never learns the email's local part. */
export const shareOwnerName = (id: number, anonymous = false): string => { const u = getUser(id); return u?.display_name || (anonymous ? '' : u?.email.split('@')[0]) || 'Someone'; };

export interface ShareView {
  id: string;
  kind: ShareKind;
  target: string;
  title: string;
  /** The shared ward's type, or `page`. */
  type: string;
  size: string | null;
  role: ShareRole;
  expiresAt: string | null;
  createdAt: string;
  /** Owner's listing: who holds it. */
  grantee: { id: number; email: string; displayName: string } | null;
  link: boolean;
  /** Recipient's listing: whose it is. */
  owner: string;
}
function view(share: Share, layout = getDashboard(share.owner), pages = getPages(share.owner)): ShareView | null {
  const wards = shareWards(share, layout, pages);
  if (!wards.length) return null;
  const target = wards.find((w) => w.i === share.target);
  const g = share.grantee !== null ? getUser(share.grantee) : null;
  return {
    id: share.id, kind: share.kind, target: share.target, title: shareTitle(share, wards, pages), type: share.kind === 'ward' ? target?.type ?? 'ward' : 'page',
    size: target?.size ?? null, role: share.role, expiresAt: share.expiresAt, createdAt: share.createdAt,
    grantee: g ? { id: g.id, email: g.email, displayName: g.display_name } : null, link: share.grantee === null, owner: shareOwnerName(share.owner),
  };
}

/** Everything this owner has shared, live targets only. */
export function listShares(owner: number): ShareView[] {
  const layout = getDashboard(owner), pages = getPages(owner);
  return (getDb().prepare(`SELECT ${COLS} FROM shares WHERE owner_id = ? ORDER BY created_at`).all(owner) as Row[])
    .map(fresh).map((s) => (s ? view(s, layout, pages) : null)).filter((v): v is ShareView => !!v);
}
/** Everything shared WITH this user (never link shares — those have no grantee). */
export function sharedWithMe(user: number): ShareView[] {
  return (getDb().prepare(`SELECT ${COLS} FROM shares WHERE grantee_id = ? ORDER BY created_at`).all(user) as Row[])
    .map(fresh).map((s) => (s ? view(s) : null)).filter((v): v is ShareView => !!v);
}

export interface CreateShare {
  kind: ShareKind;
  target: string;
  /** An existing user's email; absent = an anyone-with-the-link share. */
  email?: string;
  role?: ShareRole;
  /** Seconds until the share lapses; 0/absent = never. */
  expiresIn?: number;
}
/** Create (or, for a person who already holds this target, re-role) a share.
 *  The token of a link share is returned exactly once. */
export function createShare(owner: number, input: CreateShare): { share: Share; token?: string } {
  const layout = getDashboard(owner), pages = getPages(owner);
  const kind: ShareKind = input.kind === 'page' ? 'page' : 'ward';
  const target = typeof input.target === 'string' ? input.target : '';
  if (kind === 'page' ? !pages.some((p) => p.id === target) : !layout.some((w) => w.i === target)) throw fail(404, 'no such ward or page');
  const wards = shareWards({ owner, kind, target }, layout, pages);
  if (!wards.length) throw fail(400, 'nothing there can be shared');
  const role: ShareRole = input.role === 'edit' ? 'edit' : 'view';
  if (role === 'edit' && !wards.some((w) => shareCeiling(w) === 'edit')) throw fail(400, 'this can only be shared view-only');
  const ttl = Math.min(Math.max(Math.round(Number(input.expiresIn) || 0), 0), SHARE_MAX_TTL_S);
  const expiresAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  const db = getDb();
  if (input.email !== undefined) {
    const u = getUserByEmail(String(input.email));
    if (!u) throw fail(404, 'no account with that email');
    if (u.id === owner) throw fail(400, 'that is you');
    const have = db.prepare(`SELECT ${COLS} FROM shares WHERE owner_id = ? AND kind = ? AND target = ? AND grantee_id = ?`).get(owner, kind, target, u.id) as Row | undefined;
    let share: Share;
    if (have) {
      db.prepare('UPDATE shares SET role = ?, expires_at = ? WHERE id = ?').run(role, expiresAt, have.id);
      share = { ...fromRow(have), role, expiresAt };
    } else {
      const id = newShareId();
      db.prepare('INSERT INTO shares (id, owner_id, kind, target, grantee_id, role, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, owner, kind, target, u.id, role, expiresAt);
      share = resolveShare(id)!;
    }
    broadcast(u.id, 'share', { id: share.id, kind, title: shareTitle(share, wards, pages), owner: shareOwnerName(owner), role });
    return { share };
  }
  if (role !== 'view') throw fail(400, 'links are view-only');
  if (!linksEnabled()) throw fail(403, isDesktop() ? 'public links need a server' : 'public links are turned off for this instance');
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newShareId();
  db.prepare('INSERT INTO shares (id, owner_id, kind, target, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, owner, kind, target, 'view', sha256(token), expiresAt);
  return { share: resolveShare(id)!, token };
}
export function setShareRole(owner: number, id: string, role: ShareRole): Share {
  const share = resolveShare(id);
  if (!share || share.owner !== owner) throw fail(404, 'no such share');
  if (share.grantee === null && role !== 'view') throw fail(400, 'links are view-only');
  if (role === 'edit' && !shareWards(share).some((w) => shareCeiling(w) === 'edit')) throw fail(400, 'this can only be shared view-only');
  getDb().prepare('UPDATE shares SET role = ? WHERE id = ?').run(role, id);
  return { ...share, role };
}
export function revokeShare(owner: number, id: string): boolean {
  return getDb().prepare('DELETE FROM shares WHERE id = ? AND owner_id = ?').run(id, owner).changes > 0;
}

// ------------------------------------------------------------------ the scope

/** Who may see share `id`: its grantee (signed in), a link holder (the token cookie), or
 *  the owner previewing it. 404 = no such share, 403 = not for this visitor. */
export function shareScope(id: unknown, session: Session | null, cookieToken: string | undefined): ShareScope | 403 | 404 {
  const share = resolveShare(id);
  if (!share) return 404;
  const owner = !!session && session.userId === share.owner;
  if (!owner) {
    if (share.grantee !== null) { if (!session || session.userId !== share.grantee) return 403; }
    else if (!verifyShareToken(share, cookieToken)) return 403;
  }
  return { share, wards: shareWards(share), viewer: session };
}
/** The session every route sees inside the share: the owner's id (so every store
 *  resolves), never their role or email, and the theme the page should paint in. */
export function sharePrincipal(scope: ShareScope, theme: 'owner' | 'mine'): Session {
  const owner = scope.share.owner;
  const row = getDb().prepare('SELECT theme FROM users WHERE id = ?').get(owner) as { theme: string | null } | undefined;
  return { userId: owner, email: '', role: 'member', displayName: shareOwnerName(owner), theme: theme === 'mine' && scope.viewer ? scope.viewer.theme : row?.theme ?? null };
}
export function shareLocals(scope: ShareScope, sessionId?: string): ShareLocals {
  const { share } = scope;
  return { id: share.id, role: share.role, kind: share.kind, target: share.target, owner: shareOwnerName(share.owner, !scope.viewer), viewer: scope.viewer?.userId ?? null, viewerName: scope.viewer?.displayName ?? null, principal: sharePrincipalId(scope, scope.viewer && sessionId ? sessionId : undefined), wards: scope.wards };
}
/** The principal id a live connection re-checks (live-stream.ts): the share, and the grantee's session when there is one. */
export const sharePrincipalId = (scope: ShareScope, sessionId?: string): string => `share:${scope.share.id}${sessionId ? `:${sessionId}` : ''}`;
/** Whether a stream's or socket's principal still stands: a session, or a share (and its grantee's session). */
export function principalAlive(id: string): boolean {
  if (!id.startsWith('share:')) return !!getSession(id);
  const [, share, session] = id.split(':');
  return !!resolveShare(share) && (!session || !!getSession(session));
}
/** Would the request that opened a stream or socket pass now, with the role it had? Asked on
 *  every heartbeat and event: a revoke, an expiry, a role change or the ward leaving the
 *  owner's layout ends it. */
export function shareStillAllows(was: Pick<Share, 'id' | 'role'>, method: string, url: URL): boolean {
  const share = resolveShare(was.id);
  return !!share && share.role === was.role && shareAllows({ share, wards: shareWards(share), viewer: null }, method, url);
}
/** An SSE route's beat inside a share: the principal and the share's reach, re-read. */
export const shareLive = (share: ShareLocals, url: URL): boolean => principalAlive(share.principal) && shareStillAllows(share, 'GET', url);

const STATUS_TYPES = new Set(['service-group', 'incidents', 'chart']);
/** The positive allowlist: what a request inside the share may do, by route, method
 *  and ward. Everything not listed is refused before any handler runs. */
export function shareAllows(scope: ShareScope, method: string, url: URL): boolean {
  const { share, wards } = scope;
  const get = method === 'GET' || method === 'HEAD';
  if (!get && share.role !== 'edit') return false;
  const p = url.pathname, q = url.searchParams;
  const ward = (id: string | null | undefined) => wards.find((w) => w.i === id);
  let m: RegExpExecArray | null;
  if (p === `/api/share/${share.id}` || p === `/api/share/${share.id}/stream` || p === '/api/me') return get;
  if (p === '/api/live/stream') return get; // the socket mux (live-stream.ts): every subscription inside it is checked on its own
  if (p === '/api/status' || p === '/api/status/stream' || p === '/api/status/incidents' || p === '/api/status/history') return get && wards.some((w) => STATUS_TYPES.has(w.type));
  if (p === '/api/weather') return get && ward(q.get('ward'))?.type === 'weather';
  if (p === '/api/flow') return get && ward(q.get('ward'))?.type === 'flow';
  if ((m = /^\/api\/timers\/([^/]+)$/.exec(p))) return get && ward(m[1])?.type === 'timer';
  if ((m = /^\/api\/note\/(ws\/)?([^/]+)$/.exec(p))) {
    // Only THE document of a shared notepad, or a document filed in a shared notebook;
    // the collaboration socket (ws/) is the same document, opened read-only for a viewer.
    const w = ward(q.get('ward'));
    const doc = m[2]!;
    const inShare = w?.type === 'note' ? noteIdOf(w) === doc : w?.type === 'notebook' ? getNoteMeta(share.owner, doc)?.notebook === notebookIdOf(w) : false;
    if (m[1]) return inShare && get;
    return inShare && (get || method === 'PUT' || method === 'POST');
  }
  if ((m = /^\/api\/notebook\/([^/]+)$/.exec(p))) return ward(m[1])?.type === 'notebook' && (get || method === 'POST');
  if (p === '/api/notes') return get && wards.some((w) => w.type === 'notebook');
  if ((m = /^\/api\/browser\/(stream\/|ws\/)?([^/]+)$/.exec(p))) {
    if (ward(m[2])?.type !== 'browser') return false;
    if (m[1]) return get; // frames
    // Input only: never the extension, download or restart actions the query selects.
    return method === 'POST' && [...q.keys()].every((k) => k === 'share');
  }
  if (p.startsWith('/api/bg/') || p.startsWith('/api/icon/')) return get;
  return false;
}
/** Notebook operations a collaborator may run; `link` would pull ANY of the owner's
 *  documents into view, `purge`/`empty-trash`/`notebook` (the schema) and `ask` stay the owner's. */
export const SHARE_NOTEBOOK_OPS = new Set(['create', 'update', 'unlink', 'reorder']);

/** The owner's status data a share may show: the services its wards put on screen,
 *  the host rows, and whether an incidents ward (the whole instance's history) is in it. */
export function shareStatusScope(wards: WardInstance[]): { services: Set<string>; host: boolean; incidents: boolean } {
  const services = shownServiceIds(wards);
  let host = [...services].some((id) => id.startsWith('host:'));
  for (const w of wards) {
    if (w.type !== 'chart') continue;
    if (w.config?.source === 'host') host = true;
    if (typeof w.config?.service === 'string') services.add(w.config.service);
  }
  return { services, host, incidents: wards.some((w) => w.type === 'incidents') };
}

/** The status snapshot as a share may see it: the services its wards show, host
 *  figures only when a host row is among them, no alerts, no deploy stamp. */
export function shareSnapshot(snap: Snapshot, wards: WardInstance[]): Snapshot {
  const scope = shareStatusScope(wards);
  return {
    ...snap,
    alerts: [],
    services: snap.services.filter((s) => scope.services.has(s.id)),
    host: scope.host ? snap.host : { disk: { usedPct: 0, freeGb: 0 }, mem: { usedPct: 0 }, load: null, cores: 0 },
  };
}

/** The owner's per-user events a share's stream forwards, renamed where the share
 *  view handles them differently. Undefined = not for this share. */
export function shareEvent(scope: ShareScope, event: string, data: unknown): { event: string; data: unknown } | undefined {
  const { share, wards } = scope;
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const W = new Set(wards.map((w) => w.i));
  switch (event) {
    case 'note': {
      if (typeof d.ward === 'string' && W.has(d.ward)) return { event, data };
      if (typeof d.note !== 'string') return undefined;
      if (wards.some((w) => w.type === 'note' && noteIdOf(w) === d.note)) return { event, data };
      const nb = getNoteMeta(share.owner, d.note)?.notebook;
      return nb && wards.some((w) => w.type === 'notebook' && notebookIdOf(w) === nb) ? { event, data } : undefined;
    }
    case 'notebook':
      return typeof d.notebook === 'string' && wards.some((w) => w.type === 'notebook' && notebookIdOf(w) === d.notebook) ? { event, data } : undefined;
    case 'refresh':
      return typeof d.type === 'string' && wards.some((w) => w.type === d.type) ? { event, data: { type: d.type } } : undefined;
    case 'timer':
      return typeof d.ward === 'string' && W.has(d.ward) ? { event, data } : undefined;
    // The owner rearranged: the share view is server-rendered from the layout, so it reloads.
    case 'layout': {
      // Only when what THIS share shows changed: a rename or a move elsewhere must not pull
      // the document out from under a collaborator. The scope follows the layout for the next event.
      const now = shareWards(share);
      if (JSON.stringify(now) === JSON.stringify(wards)) return undefined;
      scope.wards = now;
      return { event: 'reload', data: {} };
    }
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ presence

interface Present { name: string; send: (data: unknown) => void; anonymous: boolean }
const presence = new Map<string, Map<number, Present>>();
let presenceSeq = 0;
/** One live viewer of a share. Every join/leave tells every viewer and the owner who is there. */
export function joinPresence(scope: ShareScope, name: string, send: (data: unknown) => void, anonymous = false): () => void {
  const id = scope.share.id;
  let room = presence.get(id);
  if (!room) presence.set(id, (room = new Map()));
  const key = ++presenceSeq;
  room.set(key, { name, send, anonymous });
  emitPresence(scope);
  return () => {
    const r = presence.get(id);
    if (!r?.delete(key)) return;
    if (!r.size) presence.delete(id);
    emitPresence(scope);
  };
}
function emitPresence(scope: ShareScope): void {
  const room = presence.get(scope.share.id);
  const viewers = [...new Set([...(room?.values() ?? [])].map((v) => v.name))];
  const data = { share: scope.share.id, kind: scope.share.kind, target: scope.share.target, viewers };
  // A link holder sees how many are looking, never who: the names stay with signed-in viewers and the owner.
  const masked = { ...data, viewers: viewers.map(() => 'Viewer') };
  for (const v of room?.values() ?? []) v.send(v.anonymous ? masked : data);
  broadcast(scope.share.owner, 'presence', data);
}
