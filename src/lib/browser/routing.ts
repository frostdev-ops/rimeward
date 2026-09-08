import fs from 'node:fs';
import path from 'node:path';
import { browserWard, getDashboard, getPages, saveDashboard } from '../dashboard.ts';
import { getSetting } from '../settings.ts';
import { wardDevice } from '../dev/instance.ts';
import { isDesktop, DevError } from '../dev/runtime.ts';
import { instanceRequest, rimeConnection } from '../dev/remote.ts';
import { listDevices, relayRequest } from '../dev/devices.ts';
import { secretEqual } from '../dev/native.ts';
import { peek, PROFILES } from './session.ts';

export function browserId(user: number, ward: unknown): string {
  let id = typeof ward === 'string' ? ward.trim() : '';
  if (!id) {
    const all = getDashboard(user).filter(w => w.type === 'browser');
    if (all.length !== 1 || !all[0]) throw Error(all.length ? 'Several browser wards — specify a ward ID.' : 'No browser ward — add one first.');
    id = all[0].i;
  }
  if (!browserWard(user, id)) throw Error(`${id} is not a browser ward`);
  return id;
}

/** A read-only probe never launches Chromium or replaces the user's logged-in profile. */
export function browserPresence(user: number, ward: string) {
  return { active: !!peek(user, ward), profile: fs.existsSync(path.join(PROFILES, String(user), ward, 'Default')) };
}

/** Human input, streams and Rime tools resolve the same stored browser placement. */
export async function routeBrowser(user: number, ward: string, request: Request): Promise<Response | undefined> {
  browserId(user, ward);
  const desktop = isDesktop();
  if (desktop && request.headers.get('x-rimeward-relayed') === '1' &&
      secretEqual(request.headers.get('x-rimeward-native-token'), process.env.RIMEWARD_NATIVE_TOKEN)) return;
  const cfg = browserWard(user, ward);
  if (!cfg) throw Error(`${ward} is not a browser ward`);
  const pair = desktop ? await rimeConnection(user) : undefined;
  let device = wardDevice(user, ward);
  if (!device && cfg.backend === 'app') {
    if (desktop) device = pair?.id;
    else {
      const devices = listDevices(user);
      if (!devices.length) return; // Compatibility with a legacy app using the CDP tunnel.
      if (devices.length === 1) device = devices[0]?.id;
      else {
        const states = await Promise.all(devices.filter(d => d.online).map(async d => {
          const target = `/api/browser/${ward}?presence=1`;
          try {
            const response = await relayRequest(user, d.id, target, new Request(`https://rimeward.invalid${target}`, { signal: AbortSignal.timeout(5000) }));
            if (!response.ok) return null;
            const state = await response.json();
            return { id: d.id, active: state.active === true, profile: state.profile === true };
          } catch { return null; }
        }));
        const live = states.filter(s => s?.active), profiles = states.filter(s => s?.profile);
        const owners = live.length ? live : profiles;
        const owner = owners[0];
        if (owners.length !== 1 || !owner) throw new DevError('This browser has no unambiguous computer owner. Open it in its Rimeward desktop app to bind it. Update the app if it is already open.', 409);
        device = owner.id;
      }
    }
    // Pin once: an offline owner must never silently redirect to another computer.
    if (device) saveDashboard(user, getDashboard(user).map(w => w.i === ward ? { ...w, device } : w), getPages(user));
  }
  const url = new URL(request.url), target = url.pathname + url.search;
  if (device && device !== pair?.id) return desktop
    ? instanceRequest(user, `/runtime/${device}${target}`, request)
    : relayRequest(user, device, target, request);
  if (desktop && pair && !device && cfg.backend !== 'app' && getSetting(`instance:joined:${user}`))
    return instanceRequest(user, target, request);
}
