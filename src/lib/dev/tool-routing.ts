import os from 'node:os';
import { createHash } from 'node:crypto';
import type { ToolCtx, ToolDef } from '../agent/tools.ts';
import { storeAttachment } from '../agent/attachments.ts';
import { isDesktop, DevError, requireDesktop } from './runtime.ts';
import { listDevices, relayRequest } from './devices.ts';
import { instanceRequest, rimeConnection } from './remote.ts';
import { getDb } from '../db.ts';
import { getSession } from '../auth.ts';
import { getDashboard } from '../dashboard.ts';
import { wardDevice } from './instance.ts';
import { secretEqual } from './native.ts';

const endpoint = '/api/dev/agent-tools';
const deviceId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const remoteAppCleanup = new Map<string, () => void>();
export async function agentDevices(user: number) {
  if (!isDesktop()) return { devices: listDevices(user) };
  const local = { id: 'local', name: os.hostname(), platform: process.platform, online: true };
  try {
    const pair = await rimeConnection(user);
    if (!pair) return { devices: [local] };
    const response = await instanceRequest(user, '/api/devices/list', new Request('https://rimeward.invalid/api/devices/list', { signal: AbortSignal.timeout(5000) }));
    if (!response.ok) throw Error('Connected server unavailable.');
    const devices = await response.json();
    if (!Array.isArray(devices)) throw Error('Invalid device list.');
    return { devices: [{ ...local, pairedId: pair.id }, ...devices.filter(d => d.id !== pair.id)] };
  } catch {
    return { devices: [local], error: 'Connected server unavailable; other computers cannot be discovered.' };
  }
}

/** Every call carries its target. There is no mutable, cross-turn "selected computer". */
export function deviceTool(name: string, args: Record<string, unknown>, ctx: ToolCtx, local: ToolDef['run']): unknown {
  if (args.device === undefined || args.device === 'local') {
    if (!isDesktop()) throw new DevError('Choose a device ID from list_devices; local tools are unavailable on the server.');
    const value = local(args, ctx);
    return ['computer_screenshot', 'computer_app_state', 'computer_app_input'].includes(name) ? Promise.resolve(value).then(v => storeImage(v, args, ctx)) : value;
  }
  return remoteDeviceTool(name, args, ctx, local);
}
async function remoteDeviceTool(name: string, args: Record<string, unknown>, ctx: ToolCtx, local: ToolDef['run']) {
  let value: unknown;
  if (typeof args.device !== 'string' || !deviceId.test(args.device)) throw new DevError('Use a device ID from list_devices.');
  const pair = isDesktop() ? await rimeConnection(ctx.userId) : undefined;
  if (args.device === pair?.id) value = await local(args, ctx);
  else {
    const agent = name.startsWith('computer_app') ? `${ctx.conv}:${ctx.task ?? ''}` : '';
    const caller = createHash('sha256').update(`${pair?.id ?? `server:${ctx.userId}`}:${ctx.ward}${agent ? `:${agent}` : ''}`).digest('hex');
    const request = new Request(`https://rimeward.invalid${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: ctx.signal,
      body: JSON.stringify({ name, args: { ...args, device: 'local' }, ward: ctx.ward, ...(agent ? { agent } : {}) }) });
    try {
      const response = isDesktop()
        ? await instanceRequest(ctx.userId, `/runtime/${args.device}${endpoint}`, request)
        : await relayRequest(ctx.userId, args.device, endpoint, request, undefined, caller);
      if (!response.ok || !response.body) throw new DevError(response.status === 404
        ? 'Computer or tool endpoint unavailable. Refresh list_devices and update the target app if needed.'
        : `Computer request failed (${response.status}).`, response.status);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '', complete = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += chunk.value;
          if (pending.length > 8 * 1024 * 1024) throw Error('Computer response too large.');
          while (pending.includes('\n')) {
            const end = pending.indexOf('\n');
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (typeof event.progress === 'string') ctx.progress?.(event.progress);
            if (event.error) throw new DevError(String(event.error));
            if ('result' in event) { value = event.result; complete = true; }
          }
        }
        if (!complete) throw Error('Computer disconnected before its receipt arrived.');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (e) {
      throw new DevError(`${e instanceof Error ? e.message : 'Computer disconnected.'} The operation may have completed. Inspect the same device before retrying; commands are never replayed automatically.`, e instanceof DevError ? e.status : 502);
    }
  }
  if (['computer_app_state', 'computer_app_input'].includes(name) && value && typeof value === 'object' && 'session' in value && typeof value.session === 'string' && ctx.signal) {
    const session = value.session, signal = ctx.signal;
    const key = `${ctx.userId}:${ctx.ward}:${ctx.conv}:${ctx.task ?? ''}:${args.device}`;
    remoteAppCleanup.get(key)?.();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); remoteAppCleanup.delete(key); };
    const cancel = () => {
      cleanup();
      void import('./tools.ts').then(m => deviceTool('computer_app_release', { runtime: 'desktop', device: args.device, session }, { ...ctx, signal: undefined }, m.LOCAL_DEV_TOOLS.computer_app_release.run)).catch(() => {});
    };
    const timer = setTimeout(cleanup, 60000).unref();
    remoteAppCleanup.set(key, cleanup);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
  }
  return ['computer_screenshot', 'computer_app_state', 'computer_app_input'].includes(name) ? storeImage(value, args, ctx) : value;
}
async function storeImage(value: unknown, args: Record<string, unknown>, ctx: ToolCtx) {
  // Store image bytes on the conversation's runtime, never a foreign attachment ID.
  if (value && typeof value === 'object' && 'image' in value) {
    const { image, ...receipt } = value as { image: unknown; [key: string]: unknown };
    if (typeof image !== 'string' || image.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new DevError('Invalid computer image.');
    const mime = receipt.imageMime ?? 'image/jpeg';
    if (mime !== 'image/png' && mime !== 'image/jpeg') throw new DevError('Unsupported computer image format.');
    const file = await storeAttachment({ userId: ctx.userId, conversationId: ctx.conv, name: `computer-screen.${mime === 'image/png' ? 'png' : 'jpg'}`, mime, bytes: Buffer.from(image, 'base64') });
    return { ...receipt, device: args.device ?? 'local', file_id: file.id, image_sha256: file.sha256 };
  }
  return value;
}

async function toolBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DevError('Missing tool request.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2 * 1024 * 1024) throw new DevError('Tool request too large.', 413);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString();
  return JSON.parse(raw);
}
/** The account server binds a desktop agent to its authenticated device and owned ward. */
export async function relayAgentCaller(user: number, authentication: string | undefined, request: Request) {
  if (getSession(authentication)?.userId !== user) throw new DevError('Sign in required.', 401);
  const source = getDb().prepare('SELECT d.id FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.session_id=? AND d.user_id=?')
    .get(authentication, user) as { id: string } | undefined;
  const body = await toolBody(request);
  const ward = getDashboard(user).find(w => w.i === body?.ward && w.type === 'agent');
  if (!source || !ward || wardDevice(user, ward.i) !== source.id) throw new DevError('The agent source must match its signed-in computer and ward.', 403);
  const agent = typeof body.name === 'string' && body.name.startsWith('computer_app') ? body.agent : '';
  if (agent !== '' && (typeof agent !== 'string' || !/^[0-9]+:[a-zA-Z0-9:-]{0,100}$/.test(agent))) throw new DevError('Invalid background agent identity.', 403);
  return createHash('sha256').update(`${source.id}:${ward.i}${agent ? `:${agent}` : ''}`).digest('hex');
}
/** Only native tools are callable here. Caller identity arrives on the private paired channel. */
export async function serveDeviceTool(user: number, request: Request) {
  requireDesktop();
  const caller = request.headers.get('x-rimeward-agent-caller');
  if (!secretEqual(request.headers.get('x-rimeward-native-token'), process.env.RIMEWARD_NATIVE_TOKEN) || !/^[a-f0-9]{64}$/.test(caller ?? ''))
    throw new DevError('Authenticated agent dispatch required.', 403);
  const body = await toolBody(request);
  const { LOCAL_DEV_TOOLS } = await import('./tools.ts');
  if (!body || typeof body.name !== 'string' || !Object.hasOwn(LOCAL_DEV_TOOLS, body.name) ||
      !body.args || typeof body.args !== 'object' || Array.isArray(body.args) || body.args.device !== 'local') throw new DevError('Invalid native tool request.');
  const tool = LOCAL_DEV_TOOLS[body.name];
  if (!tool) throw new DevError('Unknown native tool.');
  const ac = new AbortController(), encoder = new TextEncoder();
  const abort = () => ac.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let end: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const send = (data: unknown) => {
        if (ended) return;
        if ((controller.desiredSize ?? 0) <= 0) { abort(); end(); return; }
        try { controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`)); } catch { abort(); end(); }
      };
      const timer = setInterval(() => send({ heartbeat: true }), 15000);
      end = () => { if (ended) return; ended = true; clearInterval(timer); request.signal.removeEventListener('abort', abort); try { controller.close(); } catch {} };
      void Promise.resolve().then(() => {
        ac.signal.throwIfAborted();
        return tool.run(body.args, { userId: user, ward: `remote:${caller}`, conv: 0,
          signal: ac.signal, progress: progress => send({ progress }) });
      }).then(result => send({ result }), error => send({ error: error instanceof Error ? error.message : 'Native tool failed.' })).finally(end);
    },
    cancel() { abort(); end(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }));
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-rimeward-private': '1' } });
}
