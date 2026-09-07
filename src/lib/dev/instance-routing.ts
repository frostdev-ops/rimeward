import type { APIContext } from 'astro';
import { getDashboard, getPages } from '../dashboard.ts';
import { getSetting } from '../settings.ts';
import { sharedRime, syncRime } from '../agent/sync.ts';
import { isDesktop, DevError } from './runtime.ts';
import { rimeConnection, instanceRequest } from './remote.ts';
import { listDevices, relayRequest } from './devices.ts';
import { wardDevice } from './instance.ts';
import fs from 'node:fs';
import { backgroundPath } from '../backgrounds.ts';

const localPaths = /^\/(?:_astro\/|api\/(?:native\/|runtime(?:\?|$)|dashboard(?:\?|$)|instance(?:\/|\?|$)|dev\/|store\/|agent\/models(?:\?|$)|logic\/stream(?:\?|$)|account\/(?:theme|background)(?:\?|$))|desktop\/|dash(?:\/|\?|$)|brand\/|favicon|apple-touch-icon)/;
const wardPath = /^\/api\/(?:agent|browser(?:\/stream)?|note|comms)\/([^/?]+)$/;
/** Kept pure so routing can be checked without starting either backend. */
export function requestWard(path: string): string | undefined {
  const url = new URL(path, 'https://rimeward.invalid');
  return url.searchParams.get('_ward') || url.searchParams.get('ward') ||
    wardPath.exec(url.pathname)?.[1];
}
export async function routeInstance(context: APIContext): Promise<Response | undefined> {
  const user = context.locals.user?.userId;
  if (!user) return;
  const { request, url } = context;
  const path = url.pathname + url.search;
  // These operations authorize their explicit target, never page placement.
  if (url.pathname.startsWith('/api/remote-desktop/')) return;
  if (url.pathname.startsWith('/api/devices/')) return;
  if (url.pathname === '/api/dev/agent-tools' || url.pathname === '/api/dev/control-settings') return;
  const desktop = isDesktop();
  const connection = desktop ? await rimeConnection(user) : undefined;
  const joined = desktop && !!getSetting(`instance:joined:${user}`);
  if (desktop && joined && url.pathname.startsWith('/api/bg/')) {
    const name = url.pathname.slice('/api/bg/'.length).replace(/^\d+-/, `${user}-`);
    const file = backgroundPath(user, name);
    if (file && fs.existsSync(file) && url.pathname !== `/api/bg/${name}`) return context.redirect(`/api/bg/${name}`, 307);
    return;
  }
  if (url.pathname.startsWith('/api/icon/')) return;
  if (desktop && url.pathname === '/api/agent/history' && !url.searchParams.has('_ward')) return;
  let device: string | undefined;
  const id = requestWard(path);
  if (id) device = wardDevice(user, id);
  if (!device && url.pathname.startsWith('/api/dev/')) {
    const page = url.searchParams.get('_page');
    device = getPages(user).find(p => p.id === page)?.device;
    // Global project actions use this computer in the app, or the available owner in a browser.
    if (!desktop && !device) device = listDevices(user).find(d => d.online)?.id;
  }
  try {
    if (device && device !== connection?.id) {
      if (desktop) return await instanceRequest(user, `/runtime/${device}${path}`, request);
      return await relayRequest(user, device, path, request);
    }
    if (!desktop || !connection || !joined || device === connection.id) return;
    if (url.pathname === '/account') {
      await syncRime(user, true);
      if (sharedRime(user)?.online === false) return;
    }
    if (url.pathname.startsWith('/runtime/')) return await instanceRequest(user, path, request);
    if (localPaths.test(path)) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/account' || url.pathname.startsWith('/admin')) {
      // Server-owned services must never silently fall through to a different local account.
      return await instanceRequest(user, path, request);
    }
  } catch (e) {
    return Response.json({ error: e instanceof DevError ? e.message : 'Connection lost. Local projects are still available. Check the result before retrying an action.' },
      { status: e instanceof DevError ? e.status : 503, headers: { 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }
}
export async function instanceStatus(user: number) {
  if (!isDesktop()) return { connected: true, name: 'Rimeward', devices: listDevices(user), ownDevice: null };
  const connection = await rimeConnection(user), shared = sharedRime(user);
  const ids = [...new Set(getDashboard(user).map(w => w.device).concat(getPages(user).map(p => p.device)).filter((id): id is string => !!id))];
  return { connected: !connection || shared?.online === true, configured: !!connection,
    name: getSetting(`instance:name:${user}`) ?? 'Rimeward', ownDevice: connection?.id ?? null,
    devices: ids.map(id => ({ id, online: id === connection?.id })),
    error: shared?.error };
}
