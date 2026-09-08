import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ensureFreshTokens } from './codex.ts';
import { accountMeta, getAgentAccount } from './accounts.ts';
import { getDashboard } from '../dashboard.ts';
import { getDb } from '../db.ts';
import { limitDeviceAuth } from '../dev/device-auth.ts';
import { deleteSetting, getSetting, setSetting } from '../settings.ts';

const SDP_MAX = 64 * 1024;
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 45_000;
// Live V3 sessions advertise a two-hour expiry. Keep uncertainty through that window plus clock margin.
const PROVIDER_EXPIRY_MS = 2 * 60 * 60_000 + 60_000;
const leaseKey = (user: number) => `voice:lease:${user}`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

export type VoiceAction =
  | { action: 'start'; owner: string; sdp: string }
  | { action: 'status' | 'stop'; owner: string; lease: string };
export interface VoiceReply {
  sdp?: string;
  lease?: string;
  expiresAt?: number;
  active?: boolean;
  ok?: boolean;
  closed?: boolean;
}
interface Lease {
  id: string;
  owner: string;
  principal: string;
  ward: string;
  expiresAt: number;
  providerExpiresAt: number;
  heartbeat: number;
  account: string;
  socket?: WebSocket;
  closing?: Promise<boolean>;
  closed: boolean;
  ready: boolean;
}
// ponytail: one Node process owns calls; use a shared lease store before running multiple workers.
const leases = new Map<number, Lease>();
let sweep: ReturnType<typeof setInterval> | undefined;

async function boundedText(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) throw fail('Missing voice content.');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw fail('Voice content is too large.', 413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString();
}

export async function voiceBody(request: Request): Promise<VoiceAction & { ward?: string }> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw fail('Expected JSON.');
  const text = await boundedText(request.body, SDP_MAX + 8192);
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); }
  catch { throw fail('Invalid voice request.'); }
  if (!body || Array.isArray(body) || typeof body.owner !== 'string' || !UUID.test(body.owner) || typeof body.action !== 'string' || !['start', 'stop', 'status'].includes(body.action)) throw fail('Invalid voice request.');
  if (body.action === 'start') validateSdp(body.sdp);
  else if (typeof body.lease !== 'string' || !UUID.test(body.lease)) throw fail('Invalid voice lease.');
  return body as VoiceAction & { ward?: string };
}

function validateSdp(sdp: unknown): asserts sdp is string {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp) > SDP_MAX || !sdp.startsWith('v=0\r\n') ||
    !/^m=audio /m.test(sdp) || !/^m=application /m.test(sdp) || /[\0]/.test(sdp)) throw fail('Invalid voice SDP.');
}

function stillAuthorized(user: number, lease: Lease) {
  const account = getAgentAccount(user, 'codex');
  return !!account && accountMeta(account).account_id === lease.account &&
    getDashboard(user).some(w => w.i === lease.ward && w.type === 'agent') &&
    (!lease.principal.startsWith('device:') || !!getDb().prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(lease.principal.slice(7), user));
}

async function closeLease(lease: Lease): Promise<boolean> {
  if (lease.closed) return true;
  if (lease.closing) return lease.closing;
  lease.closing = new Promise<boolean>((resolve) => {
    const socket = lease.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) { resolve(false); return; }
    const finish = () => { clearTimeout(timeout); socket.off('close', finish); socket.terminate(); resolve(lease.closed); };
    const timeout = setTimeout(finish, 3000);
    socket.once('close', finish);
    socket.send(JSON.stringify({ type: 'session.close' }), error => { if (error) finish(); });
  });
  return lease.closing;
}

function ensureSweep() {
  if (sweep) return;
  sweep = setInterval(() => {
    const now = Date.now();
    for (const [user, lease] of leases) {
      if (lease.closed || lease.providerExpiresAt <= now) {
        leases.delete(user); deleteSetting(leaseKey(user));
        lease.socket?.terminate();
        continue;
      }
      if (lease.expiresAt <= now || (lease.ready && (now - lease.heartbeat > HEARTBEAT_MS || !stillAuthorized(user, lease)))) {
        void closeLease(lease);
        // Keep an unacknowledged call's slot through its provider expiry, including across restarts.
      }
    }
    if (!leases.size) { clearInterval(sweep); sweep = undefined; }
  }, 5000);
  sweep.unref();
}

async function attachControl(user: number, lease: Lease, callId: string, headers: Record<string, string>) {
  const socket = new WebSocket(`wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`, {
    headers, handshakeTimeout: 10_000, maxPayload: 256 * 1024, followRedirects: false,
  });
  lease.socket = socket;
  socket.on('error', () => {}); // Do not expose upstream diagnostics or headers.
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'session.closed') {
        lease.closed = true;
        if (leases.get(user) === lease) deleteSetting(leaseKey(user));
      }
      if (event.type === 'session.started' && Number.isFinite(event.session?.expires_at) && event.session.expires_at * 1000 > Date.now() && leases.get(user) === lease && !lease.closed) {
        lease.providerExpiresAt = event.session.expires_at * 1000 + 60_000;
        setSetting(leaseKey(user), String(lease.providerExpiresAt));
      }
    } catch { /* Voice content never enters Rime's executor or canonical history. */ }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', () => reject(fail('Voice session control is unavailable. Try again after this session expires.', 502)));
    socket.once('close', () => reject(fail('Voice session control disconnected.', 502)));
  });
}

/** Included in the runtime's existing graceful shutdown; tombstones survive an unclean exit. */
export async function shutdownVoice() {
  await Promise.all([...leases.values()].map(closeLease));
}

/** Only signaling and lease control. Audio and transcript events never run agent tools. */
export async function voiceAction(user: number, ward: string, principal: string, body: VoiceAction): Promise<VoiceReply> {
  if (body.action !== 'start') {
    const lease = leases.get(user);
    if (!lease) {
      const closed = !(Number(getSetting(leaseKey(user))) > Date.now());
      return body.action === 'stop' ? { ok: true, closed } : { active: false, closed };
    }
    if (lease.id !== body.lease || lease.owner !== body.owner || lease.principal !== principal || lease.ward !== ward) throw fail('This voice session belongs to another client.', 403);
    if (body.action === 'stop') {
      const closed = await closeLease(lease);
      if (closed && leases.get(user) === lease) leases.delete(user);
      return { ok: true, closed };
    }
    const active = !lease.closing && !lease.closed && lease.expiresAt > Date.now() && stillAuthorized(user, lease) && lease.socket?.readyState === WebSocket.OPEN;
    if (active) lease.heartbeat = Date.now();
    else void closeLease(lease);
    return { active, expiresAt: lease.expiresAt, closed: lease.closed };
  }
  validateSdp(body.sdp);
  // Conversation playback rotates acknowledged peers: two starts per full listen/read cycle.
  limitDeviceAuth(`voice-start:${user}`, 60);
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'agent')) throw fail('Agent ward unavailable.', 404);
  const previous = leases.get(user);
  if ((previous && !previous.closed && previous.providerExpiresAt > Date.now()) || Number(getSetting(leaseKey(user))) > Date.now()) throw fail('Voice is active in another view, or its previous call may still be active. Wait for it to close before starting again.', 409);
  previous?.socket?.terminate();
  if (!getAgentAccount(user, 'codex')) throw fail('Connect ChatGPT under Account → Agent to use voice.', 503);
  const lease: Lease = { id: randomUUID(), owner: body.owner, principal, ward, expiresAt: Date.now() + LEASE_MS, providerExpiresAt: Date.now() + PROVIDER_EXPIRY_MS, heartbeat: Date.now(), account: '', closed: false, ready: false };
  leases.set(user, lease);
  setSetting(leaseKey(user), String(lease.providerExpiresAt));
  ensureSweep();
  let sent = false;
  try {
    const tokens = await ensureFreshTokens(user).catch(() => { throw fail('ChatGPT login expired or unavailable. Reconnect under Account → Agent.', 401); });
    if (!tokens.account_id || !tokens.access_token) throw fail('Reconnect ChatGPT under Account → Agent to use voice.', 401);
    lease.account = tokens.account_id;
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`, 'chatgpt-account-id': tokens.account_id,
      'content-type': 'application/json', 'openai-alpha': 'quicksilver=v2', originator: 'codex_cli_rs',
    };
    sent = true;
    // Never retry creation: a timeout may hide a successfully created, billable call.
    const response = await fetch('https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas', {
      method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ sdp: body.sdp, session: {
        model: 'gpt-live-1-codex',
        instructions: 'You are the voice interface for Rimeward. Say supplied speakable context aloud verbatim. Never repeat microphone speech or answer it yourself. Wait for speakable context from the agent. Do not use tools.',
        audio: { output: { voice: 'cove' } }, delegation: { type: 'client', ack_filler: false },
      } }),
    });
    if (!response.ok) {
      sent = response.status >= 500;
      await response.body?.cancel();
      throw fail(response.status === 401 ? 'ChatGPT login expired. Reconnect under Account → Agent.' : response.status === 429 ? 'Voice usage limit reached. Try again later.' : 'Voice is unavailable for this ChatGPT connection.', response.status === 401 || response.status === 403 || response.status === 429 ? response.status : 502);
    }
    const location = response.headers.get('location') ?? '';
    const callId = new URL(location, 'https://chatgpt.com').pathname.split('/').filter(Boolean).at(-1);
    if (!callId || !/^[a-zA-Z0-9_-]{8,200}$/.test(callId)) {
      await response.body?.cancel();
      throw fail('Voice returned an invalid call identifier.', 502);
    }
    await attachControl(user, lease, callId, headers);
    const sdp = await boundedText(response.body, SDP_MAX);
    validateSdp(sdp);
    if (lease.closed || lease.closing || !stillAuthorized(user, lease)) throw fail('Voice connection was cancelled.', 409);
    lease.heartbeat = Date.now();
    lease.ready = true;
    return { sdp, lease: lease.id, expiresAt: lease.expiresAt };
  } catch (error) {
    if (!sent && leases.get(user) === lease) { leases.delete(user); deleteSetting(leaseKey(user)); }
    else void closeLease(lease);
    if (error instanceof Error && 'status' in error) throw error;
    throw fail('Voice connection was interrupted. The previous call may still be active; it will not be retried automatically.', 502);
  }
}
