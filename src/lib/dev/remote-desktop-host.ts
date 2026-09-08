import { nativeDesktop } from './remote.ts';
import { secretEqual, localOwner } from './native.ts';
import type { RemoteRelayContext } from './devices.ts';
import { REMOTE_LIMITS, REMOTE_CAPABILITIES, parseRemotePolicy, RemoteDesktopError, type RemoteCapability, type RemoteDisplay } from './remote-desktop-contract.ts';
import sharp from 'sharp';

interface NativeStatus {
  generation: number; ownershipGeneration: number;
  media?: boolean;
  screenPermission?: boolean; inputPermission?: boolean; clipboardPermission?: boolean; textPermission?: boolean;
  enabled: boolean; locked?: boolean; supported: boolean; suspended: boolean; platform: string; permissions: string;
  controller: { id: string; kind: string; generation: number } | null; topology: number; displays: RemoteDisplay[] | null;
}
interface HostSession {
  id: string; actor: string; device: string; revision: number; expires: number; active: number;
  capabilities: RemoteCapability[]; pending: boolean; paused: boolean; display?: number;
  ownership?: number; topology: number; frame: number; frameAt: number; capturing: boolean;
  rime?: { owner: string; ownership: number; topology: number };
  // Teardown invalidates pending completions; cleanup keeps new starts out until it finishes.
  media?: boolean; detached?: boolean; epoch: number; starting: number;
}
const sessions = new Map<string, HostSession>();
const closed = new Map<string, number>();
const agentApprovals = new Map<string, { id: string; expires: number; approved: boolean; revision: number }>();
let started = false;
async function release(s: HostSession) {
  s.epoch++; s.starting++;
  const ownership = s.ownership, rime = s.rime; s.ownership = undefined; s.rime = undefined;
  try {
    if (ownership !== undefined) await nativeDesktop('computer-release', { owner: s.id, ownership, topology: s.topology }).catch(() => {});
    if (rime) await nativeDesktop('computer-release', rime).catch(() => {});
  } finally { s.starting--; }
}
function currentOperation(s: HostSession, epoch: number) {
  return sessions.get(s.id) === s && s.epoch === epoch && s.expires > Date.now() && !s.paused && !s.detached;
}
async function close(s: HostSession) {
  sessions.delete(s.id); closed.set(s.id, Date.now() + REMOTE_LIMITS.authorizationMs);
  await release(s);
  if (s.media) await nativeDesktop('computer-media', { command: 'stop', session: s.id, expires: Date.now() + 1000 }).catch(() => {});
  await nativeDesktop('computer-files', { command: 'close', actor: s.device, session: s.id, expires: Date.now() + 1000 }).catch(() => {});
}
function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    for (const s of sessions.values()) if (s.expires <= Date.now() || Date.now() - s.active >= REMOTE_LIMITS.idleMs) void close(s);
    for (const [id, expires] of closed) if (expires <= Date.now()) closed.delete(id);
    for (const [owner, request] of agentApprovals) if (request.expires <= Date.now()) agentApprovals.delete(owner);
  }, 250).unref();
}
export function pendingRemoteApprovals() {
  return [...sessions.values()].filter(s => s.pending).map(s => ({ id: s.id, capabilities: s.capabilities })).concat(
    [...agentApprovals.values()].filter(s => !s.approved).map(s => ({ id: s.id, capabilities: ['screen', 'rime'] as RemoteCapability[] })));
}
export function requireRimeApproval(owner: string, revision: number) {
  start();
  const pending = agentApprovals.get(owner);
  if (pending?.approved && pending.expires > Date.now() && pending.revision === revision) { agentApprovals.delete(owner); return; }
  if (!pending || pending.expires <= Date.now() || pending.revision !== revision)
    agentApprovals.set(owner, { id: crypto.randomUUID(), expires: Date.now() + 30000, approved: false, revision });
  throw new RemoteDesktopError('Approve Rime screen control on the host Connections page, then retry.', 409, 'pending_approval');
}
export async function approveRemoteSession(id: string, allow: boolean) {
  const agent = [...agentApprovals.entries()].find(([, request]) => request.id === id);
  if (agent) {
    if (agent[1].expires <= Date.now()) throw new RemoteDesktopError('Connection request expired.', 404);
    if (allow) agent[1].approved = true; else agentApprovals.delete(agent[0]);
    return;
  }
  const s = sessions.get(id);
  if (!s?.pending || s.expires <= Date.now()) throw new RemoteDesktopError('Connection request expired.', 404);
  if (allow) s.pending = false;
  else await close(s);
}
export async function stopRemoteHostSessions() { agentApprovals.clear(); await Promise.all([...sessions.values()].map(close)); }
function contextOf(request: Request): RemoteRelayContext {
  if (!secretEqual(request.headers.get('x-rimeward-native-token'), process.env.RIMEWARD_NATIVE_TOKEN))
    throw new RemoteDesktopError('Private native dispatch required.', 403);
  const raw = request.headers.get('x-rimeward-remote-context');
  if (!raw || raw.length > 4096) throw new RemoteDesktopError('Authenticated device dispatch required.', 403);
  const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as RemoteRelayContext;
  if (c.protocol !== 1 || !/^[a-f0-9]{64}$/.test(c.actor) || !/^[a-f0-9-]{36}$/.test(c.session) ||
      !/^[a-f0-9-]{36}$/.test(c.device) || !Number.isSafeInteger(c.expires) || c.expires <= Date.now() || c.expires > Date.now() + 31000)
    throw new RemoteDesktopError('Expired or invalid session grant.', 403);
  c.policy = parseRemotePolicy(c.policy);
  return c;
}
/** Input batches, heartbeats and media signaling arrive many times a second; each native status read
 *  enumerates displays. They reuse one read for 500 ms — the native controller re-checks enablement,
 *  lock, ownership and topology on every event regardless, so this gate is never the only one. */
const STATUS_REUSE = new Set(['input', 'heartbeat', 'clear', 'media']);
let statusAt = 0, statusRead: Promise<NativeStatus> | undefined;
function nativeStatus(action: unknown) {
  if (statusRead && STATUS_REUSE.has(String(action)) && Date.now() - statusAt < 500) return statusRead;
  statusAt = Date.now();
  const read = nativeDesktop('computer-status') as Promise<NativeStatus>;
  statusRead = read;
  read.catch(() => { if (statusRead === read) statusRead = undefined; });
  return read;
}
export async function remoteHostAction(request: Request, value: Record<string, unknown> | (() => Promise<Record<string, unknown>>)) {
  let grant = contextOf(request);
  const receiving = sessions.get(grant.session);
  const body = typeof value === 'function' ? await value() : value;
  if (grant.expires <= Date.now()) {
    // A slow upload may outlive its original grant, but only independent renewals of the
    // same approved session can authorize it. Never extend a lease just because bytes arrived.
    if (!['files', 'clipboard'].includes(String(body.action)) || !receiving || sessions.get(grant.session) !== receiving ||
      receiving.pending || receiving.expires <= Date.now() || receiving.actor !== grant.actor || receiving.device !== grant.device || receiving.revision !== grant.policy.revision)
      throw new RemoteDesktopError('Expired session grant. Connect again.', 403);
    grant = { ...grant, expires: receiving.expires };
  }
  start();
  const native = await nativeStatus(body.action);
  if (!native.enabled || native.locked) await stopRemoteHostSessions();
  const features = { screen: native.enabled && !native.locked && native.supported && native.screenPermission !== false && grant.policy.screen,
    input: native.enabled && !native.locked && native.supported && native.inputPermission !== false && grant.policy.input, rime: native.enabled && !native.locked && native.supported && native.inputPermission !== false && grant.policy.rime,
    clipboard: native.enabled && !native.locked && native.supported && native.clipboardPermission !== false && grant.policy.clipboard, files: native.enabled && !native.locked && grant.policy.files,
    audio: native.enabled && !native.locked && native.media === true && grant.policy.audio };
  const textInput = { available: features.input && native.textPermission !== false,
    ...(native.textPermission === false ? { reason: 'This compositor supports physical keys but cannot send composed text. Use the keyboard or manual clipboard exchange.' } : {}) };
  if (body.action === 'status' && !sessions.has(grant.session)) return Response.json({ protocol: 1, platform: native.platform,
    state: native.suspended ? 'suspended' : native.locked ? 'locked' : !native.enabled ? 'disabled' : !native.supported ? 'unsupported' : native.screenPermission === false ? 'permission-required' : 'available',
    features, textInput, unavailable: { audio: 'Audio is unavailable in Compatibility mode.' },
    permissions: native.permissions, displays: native.displays ?? [], topology: native.topology,
    controller: native.controller, transports: native.media ? ['webrtc', 'compatibility'] : ['compatibility'], policy: grant.policy });
  if (body.action === 'disconnect') {
    const s = sessions.get(grant.session);
    if (s && s.actor === grant.actor && s.device === grant.device) await close(s);
    return Response.json({ closed: true });
  }
  if (!features.screen || grant.policy.connection === 'disabled') throw new RemoteDesktopError(native.locked ? 'Unlock this computer locally before connecting.' : native.suspended ? 'Remote access was stopped locally. Resume it on the host.' : 'Screen access is unavailable. Check the host Connections page and OS permissions.', 403);
  if (closed.has(grant.session)) throw new RemoteDesktopError('Session closed. Connect again.', 409);
  if (body.action === 'connect') {
    if (sessions.has(grant.session)) throw new RemoteDesktopError('Session grant already used.', 409);
    if (sessions.size >= 12 || [...sessions.values()].filter(s => !s.detached).length >= REMOTE_LIMITS.viewers) throw new RemoteDesktopError('This computer already has four viewers.', 429);
    if (!Array.isArray(body.capabilities) || body.capabilities.some(c => !REMOTE_CAPABILITIES.includes(c))) throw new RemoteDesktopError('Invalid capabilities.');
    const s: HostSession = { id: grant.session, actor: grant.actor, device: grant.device, revision: grant.policy.revision,
      expires: grant.expires, active: Date.now(), capabilities: body.capabilities.filter(c => features[c as RemoteCapability]),
      pending: grant.policy.connection === 'approval', paused: false, topology: native.topology,
      display: native.displays?.[0]?.display, frame: 0, frameAt: 0, capturing: false, epoch: 0, starting: 0 };
    sessions.set(s.id, s);
    return Response.json({ state: s.pending ? 'pending-approval' : 'connected', transport: 'compatibility',
      transports: native.media ? ['webrtc', 'compatibility'] : ['compatibility'],
      features, textInput, displays: native.displays ?? [], display: s.display, topology: s.topology, controller: native.controller });
  }
  const s = sessions.get(grant.session);
  if (!s || s.actor !== grant.actor || s.device !== grant.device || s.expires <= Date.now()) throw new RemoteDesktopError('Session expired. Connect again.', 404);
  if (s.revision !== grant.policy.revision) { await close(s); throw new RemoteDesktopError('Access settings changed. Connect again.', 403); }
  s.expires = Math.max(s.expires, grant.expires); s.active = Date.now();
  if (s.detached && !['files', 'status', 'disconnect', 'detach', 'resume'].includes(String(body.action)))
    throw new RemoteDesktopError('Viewing ended while hidden. Reconnect viewing before using this capability.', 409);
  if (s.topology !== native.topology) {
    s.starting++;
    try {
      await release(s);
      if (s.media) await nativeDesktop('computer-media', { command: 'stop', session: s.id, expires: s.expires }).catch(() => {});
      s.media = false; s.topology = native.topology; s.frame = 0;
      if (!native.displays?.some(d => d.display === s.display)) s.display = native.displays?.[0]?.display;
    } finally { s.starting--; }
  }
  if (body.action === 'status') {
    if (s.rime) await nativeDesktop('computer-heartbeat', s.rime).catch(() => { s.rime = undefined; });
    if (s.capabilities.includes('files')) await nativeDesktop('computer-files', { command: 'renew', actor: s.device, session: s.id, expires: s.expires });
    return Response.json({ state: s.pending ? 'pending-approval' : s.detached ? 'transfer-only' : 'connected', features, textInput, displays: native.displays ?? [], display: s.display, controller: native.controller, topology: native.topology });
  }
  if (s.pending) throw new RemoteDesktopError('Approve this connection on the host Connections page.', 409, 'pending_approval');
  if (body.action === 'detach') {
    if (!s.paused) throw new RemoteDesktopError('Pause viewing first.', 409);
    const transfers = s.capabilities.includes('files') ? await nativeDesktop('computer-files', { command: 'renew', actor: s.device, session: s.id, expires: s.expires }) as { active?: number } : {};
    if (!transfers.active && !(body.archive === true && features.files && s.capabilities.includes('files'))) { await close(s); return Response.json({ closed: true }); }
    s.detached = true;
    return Response.json({ state: 'transfer-only' });
  }
  if (body.action === 'media') {
    if (!native.media) throw new RemoteDesktopError('This host needs the bundled media helper. Compatibility mode is available.', 409);
    const command = body.command;
    if (!['start', 'poll', 'answer', 'ice', 'stop'].includes(String(command))) throw new RemoteDesktopError('Invalid media command.');
    if (command === 'start') {
      if (s.paused) throw new RemoteDesktopError('Resume viewing before connecting media.', 409);
      if (s.starting) throw new RemoteDesktopError('A session operation is still starting.', 409);
      if (body.audio === true && (!features.audio || !s.capabilities.includes('audio'))) throw new RemoteDesktopError('System audio is unavailable or not allowed.', 403);
      const display = native.displays?.find(d => d.display === s.display);
      if (!display) throw new RemoteDesktopError('Display unavailable.', 409);
      const quality = ['saver', 'auto', 'sharp'].includes(String(body.quality)) ? body.quality : 'auto';
      const limit = quality === 'sharp' ? 3840 : quality === 'saver' ? 1280 : 1920;
      const pixels = native.platform === 'macos' ? Math.max(1, display.scale) : 1;
      const scale = Math.min(pixels, limit / Math.max(display.width, display.height));
      // ScreenCaptureKit scales on the GPU, so a macOS capture is sized to the viewer's output and the
      // helper keys captures by size: no per-frame software downscale of a 4K/5K frame per viewer.
      const captureScale = native.platform === 'macos' ? scale : Math.min(pixels, 3840 / Math.max(display.width, display.height));
      const epoch = s.epoch; s.starting++;
      try {
        await nativeDesktop('computer-media', { command, session: s.id, expires: s.expires, input: features.input && s.capabilities.includes('input'),
        display: s.display, x: display.x, y: display.y, sourceWidth: display.width, sourceHeight: display.height,
        captureWidth: Math.max(2, Math.floor(display.width * captureScale / 2) * 2), captureHeight: Math.max(2, Math.floor(display.height * captureScale / 2) * 2),
        width: Math.max(2, Math.floor(display.width * scale / 2) * 2), height: Math.max(2, Math.floor(display.height * scale / 2) * 2),
        quality, audio: body.audio === true, forceTurn: body.forceTurn === true, turn: body.turn });
        if (!currentOperation(s, epoch)) {
          await nativeDesktop('computer-media', { command: 'stop', session: s.id, expires: Date.now() + 1000 }).catch(() => {});
          throw new RemoteDesktopError('Session changed while media was starting.', 409);
        }
        s.media = true;
        return Response.json({ iceServers: body.iceServers ?? [], turnAvailable: body.turnAvailable === true });
      } finally { s.starting--; }
    }
    if (command === 'stop') { s.epoch++; s.starting++; s.media = false; }
    try {
      return Response.json(await nativeDesktop('computer-media', { command, session: s.id, expires: s.expires, sdp: body.sdp, candidate: body.candidate, sdpMLineIndex: body.sdpMLineIndex }));
    } finally { if (command === 'stop') s.starting--; }
  }
  if (body.action === 'files') {
    if (!features.files || !s.capabilities.includes('files')) throw new RemoteDesktopError('File transfer is not allowed.', 403);
    return Response.json(await nativeDesktop('computer-files', { ...body, actor: s.device, session: s.id, expires: s.expires }));
  }
  if (body.action === 'clipboard') {
    if (!features.clipboard || !s.capabilities.includes('clipboard')) throw new RemoteDesktopError('Clipboard exchange is not allowed.', 403);
    if (body.sync === true && (body.mime !== 'text/plain' || s.paused || s.ownership === undefined || body.ownership !== s.ownership ||
      native.controller?.id !== s.id || native.controller.generation !== s.ownership)) throw new RemoteDesktopError('Clipboard synchronization requires the current controller.', 403);
    if (body.direction !== 'send' && body.direction !== 'receive') throw new RemoteDesktopError('Invalid clipboard direction.');
    if (body.mime !== 'text/plain' && body.mime !== 'image/png') throw new RemoteDesktopError('Only text and PNG clipboard exchange is supported.');
    if (body.direction === 'send') {
      if (body.mime === 'text/plain' && (typeof body.text !== 'string' || Buffer.byteLength(body.text) > REMOTE_LIMITS.textBytes)) throw new RemoteDesktopError('Clipboard text exceeds 1 MiB.', 413);
      if (body.mime === 'image/png') {
        if (typeof body.data !== 'string' || body.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new RemoteDesktopError('Invalid PNG.');
        const bytes = Buffer.from(body.data, 'base64');
        if (bytes.length > REMOTE_LIMITS.pngBytes) throw new RemoteDesktopError('Clipboard PNG exceeds 8 MiB.', 413);
        const metadata = await sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 }).metadata();
        if (metadata.format !== 'png') throw new RemoteDesktopError('Clipboard image must be PNG.');
      }
    }
    if (!sessions.has(s.id) || s.expires <= Date.now()) throw new RemoteDesktopError('Session closed.', 409);
    return Response.json(await nativeDesktop('computer-clipboard', { generation: native.generation, ownershipGeneration: native.ownershipGeneration, direction: body.direction, mime: body.mime, text: body.text, data: body.data }));
  }
  if (body.action === 'rime') {
    if (!features.rime || !s.capabilities.includes('rime') || typeof body.ward !== 'string' || !/^[a-z0-9-]{1,32}$/.test(body.ward) ||
      typeof body.caller !== 'string' || !/^[a-f0-9]{64}$/.test(body.caller)) throw new RemoteDesktopError('Rime control is not allowed.', 403);
    if (native.controller?.kind === 'human' && native.controller.id !== s.id) throw new RemoteDesktopError('The controlling viewer must release control first.', 409);
    if (s.starting || s.paused) throw new RemoteDesktopError('Resume viewing and wait for the current operation.', 409);
    const epoch = s.epoch + 1; s.starting++;
    try {
      await release(s);
      if (!currentOperation(s, epoch)) throw new RemoteDesktopError('Session changed before Rime acquired control.', 409);
      const owner = `agent:${body.local === true ? body.ward : `remote:${body.caller}`}:${localOwner()}`;
      const acquired = await nativeDesktop('computer-agent-acquire', { owner }) as { ownership: number; topology: number };
      if (!currentOperation(s, epoch)) {
        await nativeDesktop('computer-release', { owner, ...acquired }).catch(() => {});
        throw new RemoteDesktopError('Session changed while Rime acquired control.', 409);
      }
      s.rime = { owner, ...acquired };
      return Response.json({ granted: true, ward: body.ward, note: 'Control granted. No task was sent to Rime.' });
    } finally { s.starting--; }
  }
  if (body.action === 'pause' || body.action === 'resume') {
    s.starting++;
    try {
      if (body.action === 'resume' && s.detached) {
        if ([...sessions.values()].filter(s => !s.detached).length >= REMOTE_LIMITS.viewers) throw new RemoteDesktopError('This computer already has four viewers.', 429);
        s.detached = false; s.frame = 0;
      }
      s.paused = body.action === 'pause'; if (s.paused) await release(s);
      if (s.paused && s.media) {
        await nativeDesktop('computer-media', { command: 'stop', session: s.id, expires: s.expires }).catch(() => {}); s.media = false;
      }
      return Response.json({ paused: s.paused });
    } finally { s.starting--; }
  }
  if (body.action === 'monitor') {
    if (!native.displays?.some(d => d.display === body.display)) throw new RemoteDesktopError('Display unavailable. Refresh the display list.');
    s.starting++;
    try {
      await release(s);
      if (s.media) await nativeDesktop('computer-media', { command: 'stop', session: s.id, expires: s.expires }).catch(() => {});
      s.media = false; s.display = Number(body.display); s.frame = 0;
      return Response.json({ display: s.display });
    } finally { s.starting--; }
  }
  if (body.action === 'acquire') {
    if (s.paused || !features.input || !s.capabilities.includes('input')) throw new RemoteDesktopError('Input is not allowed.', 403);
    if (s.starting) throw new RemoteDesktopError('A session operation is still starting.', 409);
    const epoch = s.epoch; s.starting++;
    try {
      const result = await nativeDesktop('computer-acquire', { owner: s.id, takeover: body.takeover === true }) as { ownership: number; topology: number };
      if (!currentOperation(s, epoch)) {
        await nativeDesktop('computer-release', { owner: s.id, ...result }).catch(() => {});
        throw new RemoteDesktopError('Session changed while acquiring control.', 409);
      }
      s.ownership = result.ownership; s.topology = result.topology;
      return Response.json(result);
    } finally { s.starting--; }
  }
  if (body.action === 'release') { await release(s); return Response.json({ released: true }); }
  if (body.action === 'heartbeat' || body.action === 'input' || body.action === 'clear') {
    if (s.ownership === undefined || body.ownership !== s.ownership || body.topology !== s.topology) throw new RemoteDesktopError('Acquire control again.', 409);
    if (body.action === 'input' && (!features.input || s.paused)) throw new RemoteDesktopError('Input is not allowed.', 403);
    return Response.json(await nativeDesktop(body.action === 'input' ? 'computer-event' : body.action === 'clear' ? 'computer-clear' : 'computer-heartbeat', {
      owner: s.id, ownership: s.ownership, topology: s.topology, display: s.display,
      sequence: body.sequence, events: body.events,
    }));
  }
  if (body.action === 'frame') {
    if (s.paused) throw new RemoteDesktopError('Viewing is paused.', 409);
    if (body.ack !== s.frame || s.capturing) throw new RemoteDesktopError('Acknowledge the previous frame before requesting another.', 409, 'frame_ack_required');
    s.capturing = true; // held across the pacing wait too: a duplicate request cannot slip in meanwhile
    const frameDisplay = s.display, frameTopology = s.topology;
    try {
      // Pace here rather than answering 204: a viewer asking a few ms early would otherwise wait a whole
      // interval again and settle at half the frame rate. The relay allows 10 s per frame request.
      const wait = 1000 / REMOTE_LIMITS.compatibilityFps - (Date.now() - s.frameAt);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (!sessions.has(s.id) || s.paused) throw new RemoteDesktopError('Viewing is paused.', 409);
      const result = await nativeDesktop('computer-frame', { display: frameDisplay }) as { image: string; imageWidth: number; imageHeight: number };
      if (!sessions.has(s.id) || s.expires <= Date.now()) throw new RemoteDesktopError('Session closed.', 409);
      if (s.paused || s.display !== frameDisplay || s.topology !== frameTopology) throw new RemoteDesktopError('Display changed during capture.', 409);
      s.frame++; s.frameAt = Date.now();
      return new Response(Buffer.from(result.image, 'base64'), { headers: { 'content-type': 'image/jpeg',
        'x-rimeward-frame': String(s.frame), 'x-rimeward-topology': String(s.topology),
        'cache-control': 'no-store, no-transform' } });
    } finally { s.capturing = false; }
  }
  throw new RemoteDesktopError('This capability is unavailable in this build.', 409, 'capability_unavailable');
}
