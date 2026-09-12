// A shared terminal ward, seen from the server: which project and sessions it shows,
// what of the desktop's answers a viewer may see, and which frames of the event
// stream are theirs. The desktop never learns of the share — every request reaches
// it as the owner's own (dev/devices.ts relayRequest) — so everything a viewer must
// not see is cut here, before the relay's answer leaves this process. View only:
// the allowlist (shares.ts) admits no write, so nothing a viewer sends reaches a PTY.
import { relayRequest } from './dev/devices.ts';
import type { RuntimeEvent, SessionView } from './dev/types.ts';
import { shareLive, type ShareLocals } from './shares.ts';

export interface TerminalScope { project: string; sessions: Set<string>; at: number }
const scopes = new Map<string, TerminalScope>();
const SCOPE_MS = 30_000;
const LIVE_MS = 5_000;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-rimeward-private': '1' } });
const strip = (url: URL): string => { const q = new URLSearchParams(url.search); q.delete('share'); return `${url.pathname}?${q}`; };
async function relayJson(owner: number, device: string, path: string): Promise<unknown> {
  const res = await relayRequest(owner, device, path, new Request(`https://rimeward.invalid${path}`, { headers: { accept: 'application/json' } }));
  if (!res.ok) throw Object.assign(new Error('the desktop refused'), { status: res.status });
  return res.json();
}

/** What the ward shows: its project, from the ward's own view (ward_state lives on the
 *  desktop), and that project's sessions. Cached briefly; a session the stream announces joins it. */
export async function terminalScope(owner: number, share: ShareLocals, ward: string, device: string, fresh = false): Promise<TerminalScope> {
  const key = `${share.id}:${ward}`;
  const have = scopes.get(key);
  if (have && !fresh && Date.now() - have.at < SCOPE_MS) return have;
  const view = (await relayJson(owner, device, `/api/dev/view?id=${encodeURIComponent(ward)}&_ward=${encodeURIComponent(ward)}`)) as { project?: unknown } | null;
  const project = typeof view?.project === 'string' ? view.project : '';
  const sessions = new Set<string>(have?.sessions ?? []);
  if (project) for (const s of (await relayJson(owner, device, `/api/dev/sessions?project=${encodeURIComponent(project)}&_ward=${encodeURIComponent(ward)}`)) as SessionView[]) sessions.add(s.id);
  const scope = { project, sessions, at: Date.now() };
  scopes.set(key, scope);
  return scope;
}

/** A session as a viewer may see it: no review evidence (a diff, file paths, the check commands). */
export function viewerSession<T extends object>(s: T): T {
  const { evidence: _evidence, review: _review, ...rest } = s as T & { evidence?: unknown; review?: unknown };
  return rest as T;
}

/** One frame of /api/dev/events as the viewer may have it, or null to drop it: the reset, the
 *  shared project's sessions (a new one joins the scope as it is announced) and their output.
 *  Project, buffer and ward events are other surfaces' business. */
export function viewerFrame(frame: string, scope: TerminalScope): string | null {
  if (frame.startsWith(':')) return frame;
  const data = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!data) return null;
  let ev: RuntimeEvent;
  try { ev = JSON.parse(data.slice(5)) as RuntimeEvent; } catch { return null; }
  if (ev.type === 'reset') return frame;
  if (ev.type === 'session') {
    if (ev.id === '') return frame; // "the list changed": the listing itself is pinned on its way through
    const d = ev.data as Partial<SessionView> | undefined;
    if (d?.project === scope.project) scope.sessions.add(ev.id);
    if (!scope.sessions.has(ev.id)) return null;
    return d ? frame.replace(data, `data: ${JSON.stringify({ ...ev, data: viewerSession(d) })}`) : frame;
  }
  if (ev.type === 'output') return scope.sessions.has(ev.id) ? frame : null;
  return null;
}

/** The relayed stream, frame by frame through viewerFrame; the share re-checked every few seconds. */
function viewerStream(scope: TerminalScope, live: () => boolean): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '', checked = Date.now();
  return new TransformStream({
    transform(chunk, controller) {
      if (Date.now() - checked > LIVE_MS) { checked = Date.now(); if (!live()) { controller.terminate(); return; } }
      buf += dec.decode(chunk, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const out = viewerFrame(buf.slice(0, at), scope);
        buf = buf.slice(at + 2);
        if (out !== null) controller.enqueue(enc.encode(`${out}\n\n`));
      }
    },
  });
}

/** A share's /api/dev call on its way to the owner's desktop (instance-routing.ts): the ward's
 *  own view and the runtime's capabilities pass; a listing is pinned to the ward's project and a
 *  snapshot to one of its sessions, both shaped for a viewer; the event stream is filtered. */
export async function shareDevRelay(owner: number, share: ShareLocals, device: string, url: URL, request: Request): Promise<Response> {
  const ward = url.searchParams.get('_ward') ?? '';
  const action = url.pathname.slice('/api/dev/'.length);
  const path = strip(url);
  if (action === 'view' || action === 'capabilities') return relayRequest(owner, device, path, request);
  let scope = await terminalScope(owner, share, ward, device);
  if (action === 'sessions') {
    const id = url.searchParams.get('id');
    if (id) {
      if (!scope.sessions.has(id)) scope = await terminalScope(owner, share, ward, device, true);
      if (!scope.sessions.has(id)) return json({ error: 'not in this share' }, 403);
    } else if (url.searchParams.get('project') !== scope.project) return json({ error: 'not in this share' }, 403);
    const res = await relayRequest(owner, device, path, request);
    if (!res.ok) return res;
    const body = (await res.json()) as SessionView[] | { session: SessionView };
    return json(Array.isArray(body) ? body.map(viewerSession) : { ...body, session: viewerSession(body.session) });
  }
  if (action === 'events') {
    const res = await relayRequest(owner, device, path, request);
    if (!res.ok || !res.body) return res;
    return new Response(res.body.pipeThrough(viewerStream(scope, () => shareLive(share, url))), { status: res.status, headers: res.headers });
  }
  return json({ error: 'not in this share' }, 403);
}
