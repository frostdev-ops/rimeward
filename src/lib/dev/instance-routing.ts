import type { APIContext } from 'astro';
import { browserWard, getDashboard, getPages } from '../dashboard.ts';
import { getSetting } from '../settings.ts';
import { sharedRime, syncRime } from '../agent/sync.ts';
import { isDesktop, DevError } from './runtime.ts';
import { rimeConnection, instanceRequest } from './remote.ts';
import { listDevices, relayRequest } from './devices.ts';
import { wardDevice } from './instance.ts';
import { secretEqual } from './native.ts';
import fs from 'node:fs';
import { backgroundPath } from '../backgrounds.ts';
import { shareDevRelay } from '../share-dev.ts';
import { rtcIce, withRtcHeader } from '../browser/rtc.ts';

const localPaths = /^\/(?:_astro\/|api\/(?:native\/|logout(?:\?|$)|runtime(?:\?|$)|dashboard(?:\?|$)|instance(?:\/|\?|$)|dev\/|store\/|agent\/models(?:\?|$)|logic\/stream(?:\?|$)|account\/(?:theme|background)(?:\?|$))|desktop\/|dash(?:\/|\?|$)|brand\/|favicon|apple-touch-icon)/;
const wardPath = /^\/api\/(?:(?:agent|browser(?:\/stream)?|note|notebook|comms)\/([^/?]+)|agent\/([^/?]+)\/voice)$/;
/** Kept pure so routing can be checked without starting either backend. */
export function requestWard(path: string): string | undefined {
  const url = new URL(path, 'https://rimeward.invalid');
  const match = wardPath.exec(url.pathname);
  return url.searchParams.get('_ward') || url.searchParams.get('ward') || match?.[1] || match?.[2];
}
export async function routeInstance(context: APIContext): Promise<Response | undefined> {
  const user = context.locals.user?.userId;
  if (!user) return;
  const { request, url } = context;
  const path = url.pathname + url.search;
  // Update discovery belongs to this runtime, even when the desktop is paired.
  if (url.pathname === '/api/update' || url.pathname === '/api/update/desktop') return;
  // Replicated documents belong to this account on every runtime, including offline.
  if (/^\/api\/(?:notes$|(?:note|notebook)\/)/.test(url.pathname)) return;
  // These operations authorize their explicit target, never page placement.
  if (url.pathname.startsWith('/api/remote-desktop/')) return;
  if (url.pathname.startsWith('/api/devices/')) return;
  // Retrieval settings belong to this runtime; inference carries an explicit target.
  if (['/api/account/embeddings','/api/dev/embeddings','/api/agent/embeddings'].includes(url.pathname)) return;
  if (url.pathname === '/api/dev/agent-tools' || url.pathname === '/api/dev/control-settings') return;
  const desktop = isDesktop();
  // A relayed request (this desktop's own channel proxy, native token) is at its destination.
  // Routing it again could hand it back to the server (sync lag) and loop up to the channel cap.
  if (desktop && request.headers.get('x-rimeward-relayed') === '1' && secretEqual(request.headers.get('x-rimeward-native-token'), process.env.RIMEWARD_NATIVE_TOKEN) && (requestWard(path) || url.pathname.startsWith('/api/dev/'))) return;
  let connection: Awaited<ReturnType<typeof rimeConnection>> | undefined;
  if (desktop) {
    // The credential store can be slow or unavailable (keychain prompt, missing vault): that must
    // leave local screens available and refuse remote integration calls.
    try { connection = await rimeConnection(user); }
    catch {
      if (!localPaths.test(path)) return Response.json({ error: 'Pairing unavailable. Reconnect this desktop.' }, { status: 503 });
    }
  }
  const joined = desktop && !!getSetting(`instance:joined:${user}`);
  if (desktop && joined && url.pathname.startsWith('/api/bg/')) {
    const name = url.pathname.slice('/api/bg/'.length).replace(/^\d+-/, `${user}-`);
    const file = backgroundPath(user, name);
    if (file && fs.existsSync(file) && url.pathname !== `/api/bg/${name}`) return context.redirect(`/api/bg/${name}`, 307);
    return;
  }
  if (url.pathname.startsWith('/api/icon/')) return;
  if (desktop && url.pathname === '/api/agent/history' && !url.searchParams.has('_ward')) return;
  // Shares live on the server (lib/shares.ts): the share view and every call inside one go there.
  if (desktop && connection && (url.pathname.startsWith('/s/') || url.searchParams.has('share'))) {
    try { return await instanceRequest(user, path, request); }
    catch (e) { return Response.json({ error: e instanceof DevError ? e.message : 'The server is not reachable.' }, { status: e instanceof DevError ? e.status : 503 }); }
  }
  try {
    // A /runtime/<device> URL already names its target. Re-resolving the ward
    // inside it would relay a /runtime path, which the relay refuses (403).
    if (url.pathname.startsWith('/runtime/')) {
      if (!desktop || !connection) return;
      return await instanceRequest(user, path, request);
    }
    let device: string | undefined;
    const id = requestWard(path);
    if (id) device = wardDevice(user, id);
    if (!device && url.pathname.startsWith('/api/dev/')) {
      const page = url.searchParams.get('_page');
      device = getPages(user).find(p => p.id === page)?.device;
      // Global project actions use this computer in the app, or the available owner in a browser.
      if (!desktop && !device) device = listDevices(user).find(d => d.online)?.id;
    }
    if (device && device !== connection?.id) {
      if (desktop) return await instanceRequest(user, `/runtime/${device}${path}`, request);
      // A share's terminal viewer: what leaves the desktop is cut to the ward (lib/share-dev.ts) before it leaves here.
      if (context.locals.share && url.pathname.startsWith('/api/dev/')) return await shareDevRelay(user, context.locals.share, device, url, request);
      // A browser stream a desktop hosts: the ICE its capture page needs is minted here, where the
      // TURN secret lives, and rides the relayed request (lib/browser/rtc.ts, x-rimeward-rtc).
      if (/^\/api\/browser\/stream\/[^/]+$/.test(url.pathname)) return await relayRequest(user, device, path, withRtcHeader(request, rtcIce(user, { userId: context.locals.share ? context.locals.share.viewer : user })));
      return await relayRequest(user, device, path, request);
    }
    // An unplaced "My computer" browser belongs to this desktop even after
    // account pairing. Other backends and explicitly placed wards keep their route.
    if (desktop && !device && id && /^\/api\/browser(?:\/stream)?\/[^/]+$/.test(url.pathname) && browserWard(user, id)?.backend === 'app') return;
    if (!desktop || !connection || !joined || device === connection.id) return;
    if (url.pathname === '/account') {
      await syncRime(user, true);
      if (sharedRime(user)?.online === false) return;
    }
    if (localPaths.test(path)) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/account' || url.pathname.startsWith('/admin')) {
      // Server-owned services must never silently fall through to a different local account.
      const response = await instanceRequest(user, path, request);
      if ((url.pathname === '/account' || url.pathname.startsWith('/admin')) && response.headers.get('content-type')?.includes('text/html')) {
        // Server-owned HTML is still inside this app's local window. Preserve
        // that fact for navigation and permission restoration; account IDs differ.
        const restoring = process.platform === 'darwin' && context.cookies.get('rimeward_ui_restore')?.value === '1';
        const markers = `<meta name="rimeward-local" content="1">${process.platform === 'darwin'
          ? `<meta name="fd-mac-user" content="${user}"${restoring ? ' data-restore="1"' : ''}>` : ''}`;
        const html = await response.text();
        if (restoring) context.cookies.delete('rimeward_ui_restore', { path: '/' });
        return new Response(html.replace(/<head(?:\s[^>]*)?>/i, head => head + markers), response);
      }
      return response;
    }
  } catch (e) {
    console.warn(`[route] ${request.method} ${url.pathname.startsWith('/runtime/') ? 'runtime' : url.pathname.split('/').slice(0, 3).join('/')} → ${e instanceof DevError ? e.status : 503}`);
    return Response.json({ error: e instanceof DevError ? e.message : 'Connection lost. Local projects are still available. Check the result before retrying an action.' },
      { status: e instanceof DevError ? e.status : 503, headers: { 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }
}
const onlineCache = new Map<number, { at: number; ids: Set<string> }>();
/** Which paired desktops the server sees online, asked at most every 15 s (the client polls at that rate). */
async function onlineDevices(user: number): Promise<Set<string>> {
  const cached = onlineCache.get(user);
  if (cached && Date.now() - cached.at < 15000) return cached.ids;
  const ids = new Set<string>();
  try {
    const response = await instanceRequest(user, '/api/devices/list', new Request('https://rimeward.invalid/api/devices/list', { signal: AbortSignal.timeout(4000) }));
    if (!response.ok) return cached?.ids ?? ids;
    for (const d of await response.json() as { id: string; online: boolean }[]) if (d.online) ids.add(d.id);
  } catch { return cached?.ids ?? ids; }
  onlineCache.set(user, { at: Date.now(), ids });
  return ids;
}
export async function instanceStatus(user: number) {
  if (!isDesktop()) return { connected: true, name: 'Rimeward', devices: listDevices(user), ownDevice: null };
  const connection = await rimeConnection(user), shared = sharedRime(user);
  const ids = [...new Set(getDashboard(user).map(w => w.device).concat(getPages(user).map(p => p.device)).filter((id): id is string => !!id))];
  // Other desktops' online state comes from the server; reporting them offline kept a desktop from
  // opening their /runtime/<device>/api/logic/stream at all.
  const online = connection ? await onlineDevices(user) : new Set<string>();
  return { connected: !connection || shared?.online === true, configured: !!connection,
    name: getSetting(`instance:name:${user}`) ?? 'Rimeward', ownDevice: connection?.id ?? null,
    devices: ids.map(id => ({ id, online: id === connection?.id || online.has(id) })),
    error: shared?.error };
}
