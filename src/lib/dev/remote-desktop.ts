import { createHash, randomUUID } from 'node:crypto';
import { getSession } from '../auth.ts';
import { getDb } from '../db.ts';
import { getDashboard } from '../dashboard.ts';
import { wardDevice } from './instance.ts';
import { relayRequest, listDevices, type RemoteRelayContext } from './devices.ts';
import { authorizeDevice } from './remote-desktop-policy.ts';
import { onRemoteRevocation } from './remote-desktop-events.ts';
import { remoteTurn } from './remote-turn.ts';
import { remoteArchive } from './remote-archive.ts';
import { REMOTE_LIMITS, REMOTE_CAPABILITIES, RemoteDesktopError, type RemoteCapability, type RemoteOperation } from './remote-desktop-contract.ts';

interface Viewer {
  id: string; user: number; device: string; ward: string; actor: string;
  authentication: string; capabilities: RemoteCapability[]; active: number; revision: number;
  relayBytes: number; mediaBytes: number; rttSum: number; samples: number; failures: number;
  mediaId?: string; reportedBytes?: number; reportedAt?: number; transport?: string;
  pausedAt?: number; detached?: boolean; detaching?: Promise<Response>;
  archives?: Map<string, { root: string; path: string; active: boolean; cancel?: () => void }>;
}
const viewers = new Map<string, Viewer>();
const actorOf = (authentication: string) => createHash('sha256').update(authentication).digest('hex');
function flush(v: Viewer) {
  getDb().prepare('UPDATE remote_desktop_audit SET bytes=bytes+?,relay_bytes=relay_bytes+?,media_bytes=media_bytes+?,rtt_ms_sum=rtt_ms_sum+?,rtt_samples=rtt_samples+?,webrtc_failures=webrtc_failures+?,transport=COALESCE(?,transport) WHERE id=?')
    .run(v.relayBytes + v.mediaBytes, v.relayBytes, v.mediaBytes, v.rttSum, v.samples, v.failures, v.transport ?? null, v.id);
  v.relayBytes = v.mediaBytes = v.rttSum = v.samples = v.failures = 0;
}
/** Thirty-day owner-scoped operational metadata. Direct-media counters/RTT are viewer-reported. */
export function remoteDesktopMetrics(user: number) {
  start();
  for (const v of viewers.values()) if (v.user === user) flush(v);
  return getDb().prepare(`SELECT count(*) AS sessions, COALESCE(sum(ended_at IS NULL),0) AS active,
    COALESCE(sum(termination_reason='connection_failed'),0) AS connectionFailures,
    COALESCE(sum(webrtc_failures),0) AS webRtcFailures, COALESCE(sum(relay_bytes),0) AS relayBytes,
    COALESCE(sum(media_bytes),0) AS reportedMediaBytes,
    round(1.0*sum(rtt_ms_sum)/NULLIF(sum(rtt_samples),0)) AS reportedMeanRttMs
    FROM remote_desktop_audit WHERE user_id=? AND started_at>=?`).get(user, Date.now() - 30 * 86400000);
}
let started = false;
function start() {
  if (started) return;
  started = true;
  const db = getDb();
  db.prepare("UPDATE remote_desktop_audit SET ended_at=?,termination_reason='runtime_restarted' WHERE ended_at IS NULL").run(Date.now());
  const sweep = () => {
    for (const v of viewers.values()) {
      if (v.relayBytes || v.mediaBytes || v.samples || v.failures) flush(v);
      if (!getSession(v.authentication)) void close(v, 'authorization_revoked');
      else if (Date.now() - v.active >= REMOTE_LIMITS.idleMs) void close(v, 'idle');
      else if (!v.detached && v.pausedAt && Date.now() - v.pausedAt >= REMOTE_LIMITS.idleMs)
        void detach(v).then(response => response.body?.cancel()).catch(() => close(v, 'idle'));
    }
    if (Date.now() - pruned >= 3600000) { pruned = Date.now(); getDb().prepare('DELETE FROM remote_desktop_audit WHERE started_at<?').run(Date.now() - 30 * 86400000); }
  };
  let pruned = 0;
  setInterval(sweep, 1000).unref();
  onRemoteRevocation(event => {
    for (const v of viewers.values()) if ((!event.session || v.authentication === event.session) &&
      (!event.device || v.device === event.device) && (!event.user || v.user === event.user)) void close(v, 'authorization_revoked');
  });
}
function authenticated(user: number, authentication: string) {
  if (getSession(authentication)?.userId !== user) throw new RemoteDesktopError('Sign in again to access this computer.', 401, 'sign_in_expired');
}
function placement(user: number, ward: string, device: string) {
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'remote-desktop' && w.device === device))
    throw new RemoteDesktopError('The ward target changed. Reconnect to its selected computer.', 409, 'target_changed');
}
async function host(v: Viewer, action: string, body: Record<string, unknown> = {}, operation: RemoteOperation = 'view') {
  const policy = authorizeDevice(v.user, v.device, operation);
  const issuedAt = Date.now();
  const remote: RemoteRelayContext = { protocol: 1, actor: v.actor, session: v.id, device: v.device, policy,
    issuedAt, expires: issuedAt + REMOTE_LIMITS.authorizationMs };
  if (action === 'media' && body.command === 'start') {
    const turn = remoteTurn(v.user, v.id);
    body = { ...body, turn: turn.servers, iceServers: turn.iceServers, turnAvailable: turn.available };
  }
  const payload = JSON.stringify({ ...body, action });
  const response = await relayRequest(v.user, v.device, '/api/remote-desktop/host', new Request('https://rimeward.invalid/api/remote-desktop/host', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    signal: AbortSignal.timeout(action === 'files' || action === 'clipboard' ? 120000 : action === 'frame' ? 10000 : 15000),
  }), remote);
  if (!viewers.has(v.id)) return response;
  v.relayBytes += Buffer.byteLength(payload);
  if (!response.body) return response;
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) { if (viewers.has(v.id)) v.relayBytes += bytes.byteLength; controller.enqueue(bytes); },
  })), { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function close(v: Viewer, reason: string) {
  if (!viewers.delete(v.id)) return;
  for (const archive of v.archives?.values() ?? []) archive.cancel?.();
  flush(v);
  getDb().prepare('UPDATE remote_desktop_audit SET ended_at=?,termination_reason=? WHERE id=? AND ended_at IS NULL').run(Date.now(), reason, v.id);
  // Status authorization permits teardown even after access has been disabled.
  try { const response = await host(v, 'disconnect', {}, 'status'); await response.body?.cancel(); } catch { /* Native heartbeat and authorization expiry independently release input. */ }
}
function detach(v: Viewer): Promise<Response> {
  if (v.detaching) return v.detaching.then(response => response.clone());
  v.detaching = (async () => {
    const response = await host(v, 'detach', { archive: [...v.archives?.values() ?? []].some(a => a.active) }, 'status');
    if (!response.ok) { await close(v, 'idle'); return response; }
    const result = await response.json();
    if (result.closed) await close(v, 'idle'); else { v.detached = true; v.mediaId = undefined; }
    return Response.json(result);
  })();
  return v.detaching.then(response => response.clone()).finally(() => { v.detaching = undefined; });
}
export async function remoteCapabilities(user: number, authentication: string, device: string) {
  authenticated(user, authentication);
  authorizeDevice(user, device, 'status');
  if (listDevices(user).some(d => d.id === device && d.online && d.remoteDesktop !== 1))
    throw new RemoteDesktopError('Update required on the selected computer. Its projects and terminals remain available.', 426, 'remote_desktop_upgrade_required');
  return host({ id: randomUUID(), user, device, actor: actorOf(authentication), authentication, ward: '', capabilities: [], active: Date.now(), revision: 0,
    relayBytes: 0, mediaBytes: 0, rttSum: 0, samples: 0, failures: 0 }, 'status', {}, 'status');
}
export async function createRemoteSession(user: number, authentication: string, body: Record<string, unknown>) {
  authenticated(user, authentication);
  if (typeof body.device !== 'string' || typeof body.ward !== 'string' || body.protocol !== 1)
    throw new RemoteDesktopError('Update Rimeward and select a computer.', 426, 'remote_desktop_upgrade_required');
  const policy = authorizeDevice(user, body.device, 'connect');
  placement(user, body.ward, body.device);
  if (!Array.isArray(body.capabilities) || !body.capabilities.includes('screen') ||
      body.capabilities.some(c => !REMOTE_CAPABILITIES.includes(c))) throw new RemoteDesktopError('Invalid session capabilities.');
  const capabilities = [...new Set(body.capabilities as RemoteCapability[])].filter(c => policy[c]);
  start();
  if ([...viewers.values()].filter(v => v.device === body.device).length >= 12 || [...viewers.values()].filter(v => v.device === body.device && !v.detached).length >= REMOTE_LIMITS.viewers)
    throw new RemoteDesktopError('This computer already has four viewers.', 429, 'viewer_limit');
  const v: Viewer = { id: randomUUID(), user, authentication, actor: actorOf(authentication), device: body.device,
    ward: body.ward, capabilities, active: Date.now(), revision: policy.revision,
    relayBytes: 0, mediaBytes: 0, rttSum: 0, samples: 0, failures: 0 };
  viewers.set(v.id, v);
  getDb().prepare('INSERT INTO remote_desktop_audit(id,user_id,device_id,actor,started_at,capabilities) VALUES(?,?,?,?,?,?)')
    .run(v.id, user, v.device, v.actor, Date.now(), JSON.stringify(capabilities));
  try {
    const response = await host(v, 'connect', { capabilities });
    if (!response.ok) { await close(v, 'connection_failed'); return response; }
    const result = await response.json();
    // Revocation during negotiation cannot resurrect a removed viewer.
    authenticated(user, authentication);
    if (!viewers.has(v.id) || authorizeDevice(user, v.device, 'connect').revision !== v.revision) throw new RemoteDesktopError('Access changed during connection.', 403);
    getDb().prepare('UPDATE remote_desktop_audit SET transport=? WHERE id=?').run(result.transport ?? null, v.id);
    return Response.json({ ...result, id: v.id, device: v.device, policy, capabilities });
  } catch (e) { await close(v, 'connection_failed'); throw e; }
}
const operations: Record<string, { operation: RemoteOperation; capability?: RemoteCapability }> = {
  status: { operation: 'status' }, disconnect: { operation: 'status' },
  frame: { operation: 'view', capability: 'screen' }, monitor: { operation: 'view', capability: 'screen' },
  pause: { operation: 'status' }, detach: { operation: 'status' }, resume: { operation: 'view', capability: 'screen' },
  acquire: { operation: 'control', capability: 'input' }, release: { operation: 'status' },
  heartbeat: { operation: 'status' }, input: { operation: 'control', capability: 'input' },
  clear: { operation: 'status' },
  rime: { operation: 'rime', capability: 'rime' }, clipboard: { operation: 'clipboard', capability: 'clipboard' },
  audio: { operation: 'audio', capability: 'audio' },
  files: { operation: 'transfer', capability: 'files' },
  media: { operation: 'view', capability: 'screen' },
};
export async function remoteSessionAction(user: number, authentication: string, id: string, body: Record<string, unknown>) {
  authenticated(user, authentication);
  const v = viewers.get(id);
  if (!v || v.user !== user || v.actor !== actorOf(authentication)) throw new RemoteDesktopError('Session not found. Connect again.', 404, 'session_not_found');
  if (body.action === 'disconnect') { await close(v, 'viewer_disconnected'); return Response.json({ closed: true }); }
  placement(user, v.ward, v.device);
  const spec = operations[String(body.action)];
  if (!spec) throw new RemoteDesktopError('Unknown session action.');
  if (spec.capability && !v.capabilities.includes(spec.capability)) throw new RemoteDesktopError('This capability was not granted to the session.', 403);
  const policy = authorizeDevice(user, v.device, spec.operation);
  if (policy.revision !== v.revision) { await close(v, 'policy_changed'); throw new RemoteDesktopError('Access settings changed. Connect again.', 403); }
  if (v.detached && !['files', 'status', 'disconnect', 'detach', 'resume'].includes(String(body.action)))
    throw new RemoteDesktopError('Viewing ended while hidden. Reconnect viewing first.', 409);
  v.active = Date.now();
  if (body.action === 'detach') return detach(v);
  if (body.action === 'pause' || body.action === 'resume') {
    if (body.action === 'resume' && v.detaching) await v.detaching;
    const detached = v.detached;
    if (body.action === 'resume' && detached) {
      if ([...viewers.values()].filter(other => other.device === v.device && !other.detached).length >= REMOTE_LIMITS.viewers)
        throw new RemoteDesktopError('This computer already has four viewers.', 429);
      v.detached = false; // Reserve the viewer slot before awaiting native execution.
    }
    try {
      const response = await host(v, String(body.action), body, spec.operation);
      if (response.ok) v.pausedAt = body.action === 'pause' ? Date.now() : undefined;
      else {
        v.detached = detached;
        if (body.action === 'resume' && response.status === 404) await close(v, 'idle');
      }
      return response;
    } catch (error) { v.detached = detached; throw error; }
  }
  if (body.action === 'media') {
    if (body.command === 'metrics') {
      if (!v.mediaId || body.mediaId !== v.mediaId || !['webrtc', 'turn'].includes(String(body.transport)) ||
          !Number.isSafeInteger(body.bytes) || Number(body.bytes) < (v.reportedBytes ?? 0) ||
          !Number.isSafeInteger(body.rtt) || Number(body.rtt) < 0 || Number(body.rtt) > 60000)
        throw new RemoteDesktopError('Invalid media metrics.');
      const elapsed = Date.now() - (v.reportedAt ?? Date.now());
      if (elapsed < 5000) return Response.json({ recorded: false });
      const delta = Number(body.bytes) - (v.reportedBytes ?? 0);
      if (delta > elapsed * 128 * 1024) throw new RemoteDesktopError('Media counters exceed the session limit.');
      v.mediaBytes += delta; v.rttSum += Number(body.rtt); v.samples++;
      v.reportedBytes = Number(body.bytes); v.reportedAt = Date.now(); v.transport = String(body.transport);
      return Response.json({ recorded: true });
    }
    if (body.command === 'start') {
      const response = await host(v, 'media', body, spec.operation);
      if (!response.ok) { v.failures++; return response; }
      const result = await response.json();
      v.mediaId = randomUUID(); v.reportedBytes = 0; v.reportedAt = Date.now();
      return Response.json({ ...result, mediaId: v.mediaId });
    }
    if (body.command === 'stop') {
      if (v.mediaId && body.failure === true) v.failures++;
      v.mediaId = undefined; v.transport = 'compatibility';
    }
  }
  if (body.action === 'files' && body.command === 'download-folder') {
    if (typeof body.root !== 'string' || typeof body.path !== 'string') throw new RemoteDesktopError('Select a folder.');
    v.archives ??= new Map();
    if (v.archives.size >= 2) throw new RemoteDesktopError('Two folder transfers may run per session.', 429);
    const response = await host(v, 'files', { command: 'browse', root: body.root, path: body.path }, 'transfer');
    if (!response.ok) return response;
    await response.body?.cancel();
    const id = randomUUID().replaceAll('-', '');
    v.archives.set(id, { root: body.root, path: body.path, active: false });
    return Response.json({ id });
  }
  if (body.action === 'files' && body.command === 'cancel-folder') {
    const id = String(body.id), archive = v.archives?.get(id);
    archive?.cancel?.(); v.archives?.delete(id);
    return Response.json({ cancelled: true });
  }
  if (body.action === 'rime') {
    const ward = typeof body.ward === 'string' ? getDashboard(user).find(w => w.i === body.ward && w.type === 'agent') : undefined;
    if (!ward) throw new RemoteDesktopError('Choose an existing Rime ward.');
    const source = wardDevice(user, ward.i);
    return host(v, 'rime', { ward: ward.i, local: source === v.device,
      caller: createHash('sha256').update(`${source ?? `server:${user}`}:${ward.i}`).digest('hex') }, 'rime');
  }
  return host(v, String(body.action), body, spec.operation);
}
/** Browser downloads use the existing authenticated relay and pull one bounded chunk at a time. */
export async function downloadRemoteFile(user: number, authentication: string, id: string, transfer: string, signal: AbortSignal) {
  authenticated(user, authentication);
  const viewer = viewers.get(id);
  if (!viewer || viewer.user !== user || viewer.actor !== actorOf(authentication)) throw new RemoteDesktopError('Session not found.', 404);
  placement(user, viewer.ward, viewer.device);
  authorizeDevice(user, viewer.device, 'transfer');
  const folder = viewer.archives?.get(transfer);
  if (folder) {
    if (folder.active) throw new RemoteDesktopError('Folder download already active.', 409);
    folder.active = true;
    const lifetime = new AbortController(); folder.cancel = () => lifetime.abort();
    return remoteArchive(folder.root, folder.path, async (command, body) => {
      const response = await remoteSessionAction(user, authentication, id, { action: 'files', command, ...body });
      if (!response.ok) throw Error((await response.json()).error ?? 'Folder download failed.');
      return response.json();
    }, AbortSignal.any([signal, lifetime.signal]), () => viewer.archives?.delete(transfer));
  }
  const call = async (command: string, extra: Record<string, unknown> = {}) => {
    signal.throwIfAborted();
    const response = await remoteSessionAction(user, authentication, id, { action: 'files', command, id: transfer, ...extra });
    if (!response.ok) throw new RemoteDesktopError((await response.json()).error ?? 'Transfer failed.', response.status);
    return response.json();
  };
  const state = await call('inspect');
  if (state.upload) throw new RemoteDesktopError('Select a download transfer.', 409);
  if (!Number.isSafeInteger(state.size) || state.size < 0) throw new RemoteDesktopError('Invalid download size.', 502);
  if (state.offset !== 0) throw new RemoteDesktopError('Start a new browser download or explicitly resume into the original local file.', 409);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset === state.size) { await call('finalize'); controller.close(); return; }
        const result = await call('chunk', { offset });
        const bytes = Buffer.from(result.data, 'base64');
        if (!bytes.length || bytes.length > REMOTE_LIMITS.chunkBytes || result.offset !== offset + bytes.length || result.offset > state.size ||
          createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw Error('Invalid transfer chunk.');
        offset = result.offset; controller.enqueue(bytes);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await remoteSessionAction(user, authentication, id, { action: 'files', command: 'pause', id: transfer }).catch(() => {}); },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(state.name ?? 'download')}`,
    'content-length': String(state.size), 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}
export async function retargetRemoteWard(user: number, ward: string, device: string) {
  authorizeDevice(user, device, 'status');
  let layout = getDashboard(user), target = layout.find(w => w.i === ward && w.type === 'remote-desktop');
  if (!target) throw new RemoteDesktopError('Save this ward before selecting a computer.', 404);
  await Promise.all([...viewers.values()].filter(v => v.user === user && v.ward === ward).map(v => close(v, 'target_changed')));
  layout = getDashboard(user); target = layout.find(w => w.i === ward && w.type === 'remote-desktop');
  if (!target) throw new RemoteDesktopError('Ward was removed.', 404);
  target.device = device;
  const { saveDashboard, getPages } = await import('../dashboard.ts');
  const { broadcast } = await import('../logic-engine.ts');
  saveDashboard(user, layout);
  broadcast(user, 'layout', { layout, pages: getPages(user) });
  return { device };
}
