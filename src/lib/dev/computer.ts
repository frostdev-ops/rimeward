import { randomUUID } from 'node:crypto';
import { nativeDesktop, rimeConnection, instanceRequest } from './remote.ts';
import { DEFAULT_REMOTE_POLICY, type DeviceAccessPolicy } from './remote-desktop-contract.ts';
import { localOwner } from './native.ts';
import { DevError, requireDesktop } from './runtime.ts';

interface ControlState { enabled: boolean; generation: number; [key: string]: unknown }
interface Observation { user: number; owner: string; target: string; at: number; generation: number; geometry: Record<string, unknown>; ownership: number; topology: number; timer: ReturnType<typeof setInterval> }
const observations = new Map<string, Observation>();
function discard(id: string) {
  const previous = observations.get(id);
  if (previous) clearInterval(previous.timer);
  observations.delete(id);
}
const busy = new Set<string>();
const nativeState = () => nativeDesktop('computer-status') as Promise<ControlState>;

export async function controlSettings(_user: number) {
  requireDesktop();
  const { pendingRemoteApprovals } = await import('./remote-desktop-host.ts');
  return { ...await nativeState(), pending: pendingRemoteApprovals() };
}
export async function configureControl(user: number, value: Record<string, unknown>) {
  requireDesktop();
  if (user !== localOwner()) throw new DevError('Only the local owner can change computer control.', 403);
  if (typeof value.session === 'string' && typeof value.allow === 'boolean') {
    const { approveRemoteSession } = await import('./remote-desktop-host.ts');
    await approveRemoteSession(value.session, value.allow);
    return controlSettings(user);
  }
  if (typeof value.enabled !== 'boolean') throw new DevError('Invalid control settings.');
  const state = await nativeState();
  if (value.enabled && value.generation !== state.generation) throw new DevError('Control permission changed. Refresh settings before enabling.', 409);
  await nativeDesktop('computer-configure', { enabled: value.enabled, generation: state.generation });
  for (const id of observations.keys()) discard(id);
  return controlSettings(user);
}
const appSessions = new Map<string, { session: string; revision: number; timer: ReturnType<typeof setInterval>; cleanup: () => void }>();
function forgetAppSession(owner: string) {
  const previous = appSessions.get(owner);
  if (previous) { clearInterval(previous.timer); previous.cleanup(); }
  appSessions.delete(owner);
}
const policies = new Map<string, { value: DeviceAccessPolicy; at: number }>();
let policyGeneration = 0;
export async function invalidateComputerPolicy() {
  policyGeneration++; policies.clear();
  for (const owner of appSessions.keys()) forgetAppSession(owner);
  for (const id of observations.keys()) discard(id);
  await Promise.all([nativeDesktop('computer-revoke'), import('./remote-desktop-host.ts').then(m => m.stopRemoteHostSessions())]);
}
async function computerPolicy(user: number) {
  const generation = policyGeneration;
  const connection = await rimeConnection(user);
  if (!connection) return { ...DEFAULT_REMOTE_POLICY };
  const key = connection.id, cached = policies.get(key);
  if (cached && Date.now() - cached.at < 10000) return cached.value;
  try {
    const path = `/api/remote-desktop/policy?device=${encodeURIComponent(key)}`;
    const response = await instanceRequest(user, path, new Request(`https://rimeward.invalid${path}`, { signal: AbortSignal.timeout(3000) }));
    if (!response.ok) {
      policies.delete(key);
      throw new DevError('Account authorization was revoked. Reconnect this computer.', 403);
    }
    const value = await response.json() as DeviceAccessPolicy;
    if (generation !== policyGeneration) throw new DevError('Account permissions changed. Retry with fresh authorization.', 403);
    policies.set(key, { value, at: Date.now() }); return value;
  } catch (error) {
    if (generation === policyGeneration && policies.has(key) && cached && Date.now() - cached.at < 30000) return cached.value;
    throw error;
  }
}
export async function computerStatus(user: number) {
  return { ...await nativeState(), policy: await computerPolicy(user) };
}
async function authorizeRime(user: number) {
  const policy = await computerPolicy(user);
  if (policy.connection === 'disabled' || !policy.screen || !policy.rime) throw new DevError('Rime screen access is disabled for this account.', 403);
  return policy;
}
async function enabled() {
  const state = await nativeState();
  if (!state.enabled) throw new DevError('Computer control is off. Enable it in this computer’s Rimeward connections.', 403);
  return state;
}

async function exclusive<T>(target: string, fn: () => Promise<T>) {
  if (busy.has(target)) throw new DevError('Another screen operation is running. Wait for it to finish.', 409);
  busy.add(target);
  try { return await fn(); } finally { busy.delete(target); }
}
export async function computerScreenshot(user: number, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const generation = policyGeneration;
  const checkPolicy = () => { if (generation !== policyGeneration) throw new DevError('Account permissions changed. Take a fresh screenshot.', 403); };
  if (args.ios !== undefined) throw new DevError('iOS targets are no longer supported. Choose a paired computer.');
  const policy = await authorizeRime(user);
  const before = await enabled(); signal?.throwIfAborted();
  checkPolicy();
  const controller = `${owner}:${user}`;
  if (policy.connection === 'approval' && (before.controller as { id?: string } | null)?.id !== controller) {
    const { requireRimeApproval } = await import('./remote-desktop-host.ts');
    requireRimeApproval(controller, policy.revision);
  }
  const control = await nativeDesktop('computer-agent-acquire', { owner: controller }) as { ownership: number; topology: number; generation: number };
  const state = await enabled();
  checkPolicy();
  const target = 'desktop';
  for (const [id, o] of observations) if (Date.now() - o.at > 60000) discard(id);
  return exclusive(target, async () => {
    for (const [id, previous] of observations) if (previous.target === target) discard(id);
    const result = await nativeDesktop('computer-screenshot', { display: args.display }) as { image: string; [key: string]: unknown };
    const { image, ...geometry } = result;
    checkPolicy();
    if ((await enabled()).generation !== state.generation) throw new DevError('Control permission changed while capturing.');
    const observation = randomUUID();
    const at = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - at >= 60000) { discard(observation); return; }
      void authorizeRime(user).then(() => nativeDesktop('computer-heartbeat', { owner: controller, ownership: control.ownership, topology: control.topology }))
        .catch(() => discard(observation));
    }, 2000).unref();
    observations.set(observation, { user, owner, target, at, generation: state.generation, geometry,
      ownership: control.ownership, topology: control.topology, timer });
    return { observation, ...geometry, image };
  });
}
export async function computerInput(user: number, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  await authorizeRime(user);
  const state = await enabled(), observation = observations.get(String(args.observation));
  if (!observation || observation.user !== user || observation.owner !== owner || Date.now() - observation.at > 60000 || observation.generation !== state.generation) throw new DevError('Take a fresh screenshot on this device before input.', 409);
  signal?.throwIfAborted();
  return exclusive(observation.target, async () => {
    // Consume before input: an uncertain response can never replay this observation.
    discard(String(args.observation));
    return nativeDesktop('computer-input', { ...args, owner: `${owner}:${user}`, ownership: observation.ownership, topology: observation.topology, geometry: observation.geometry, generation: observation.generation, expires: observation.at + 60000 });
  });
}

/** A separate native session: these operations can never acquire the physical controller. */
export async function computerApp(user: number, operation: 'apps' | 'state' | 'input' | 'release', args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  requireDesktop();
  const controller = `${owner}:${user}`;
  if (operation === 'release') {
    // Revocation must remain possible after access is disabled.
    const result = await nativeDesktop('computer-app-release', { owner: controller, session: args.session });
    if (appSessions.get(controller)?.session === args.session) forgetAppSession(controller);
    return result;
  }
  const generation = policyGeneration;
  const policy = await authorizeRime(user);
  if (operation === 'input' && !policy.input) throw new DevError('Input is disabled for this account.', 403);
  const state = await enabled();
  const capability = state.backgroundApps as { supported?: boolean; reason?: string } | undefined;
  if (!capability?.supported) throw new DevError(capability?.reason ?? 'Update this desktop to a version with validated background app support.', 409);
  if (policy.connection === 'approval' && appSessions.get(controller)?.revision !== policy.revision) {
    const { requireRimeApproval } = await import('./remote-desktop-host.ts');
    requireRimeApproval(controller, policy.revision);
  }
  signal?.throwIfAborted();
  const release = async (session: string) => {
    if (appSessions.get(controller)?.session === session) forgetAppSession(controller);
    await nativeDesktop('computer-app-release', { owner: controller, session }).catch(() => {});
  };
  const onAbort = () => {
    const session = appSessions.get(controller)?.session;
    if (session) void release(session);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let retained = false;
  try {
    if (generation !== policyGeneration) throw new DevError('Account authorization changed.', 403);
    const result = await nativeDesktop(operation === 'apps' ? 'computer-apps' : `computer-app-${operation}`, { ...args, owner: controller }) as Record<string, unknown>;
    if (signal?.aborted || generation !== policyGeneration) {
      if (typeof result.session === 'string') await release(result.session);
      signal?.throwIfAborted();
      throw new DevError('Account authorization changed during the observation.', 403);
    }
    if (typeof result.session === 'string') {
      const session = result.session, observed = Date.now();
      forgetAppSession(controller);
      const timer = setInterval(() => {
        if (Date.now() - observed >= 60000) { void release(session); return; }
        void authorizeRime(user).then(() => nativeDesktop('computer-app-heartbeat', { owner: controller, session }))
          .catch(() => release(session));
      }, 2000).unref();
      appSessions.set(controller, { session, revision: policy.revision, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      retained = true;
    }
    return result;
  } finally { if (!retained) signal?.removeEventListener('abort', onAbort); }
}
