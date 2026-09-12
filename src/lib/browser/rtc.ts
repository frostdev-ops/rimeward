// The browser ward's WebRTC signaling: one peer per viewer, the capture page
// (assets/browser-extensions/stream) the host. A viewer joins with a random
// connection id; the page's offer, candidates and states come back through the
// session's sink for that id alone — never through emit() — and the viewer's
// answer and candidates are validated here before they reach the page.
//
// ICE: the host is relay-only (TURN credentials minted for the owner where the
// secret lives — the server — and handed to a desktop inside the relayed request,
// RTC_HEADER); a signed-in viewer gets TURN too, an anonymous link viewer STUN
// only, because a TURN credential for anyone holding a link is an open relay.
import { randomBytes } from 'node:crypto';
import { isDesktop } from '../dev/runtime.ts';
import { remoteTurn, STUN_SERVERS } from '../dev/remote-turn.ts';
import { tell, type Session, type StreamSignal } from './session.ts';

export interface IceServer { urls: string | string[]; username?: string; credential?: string }
/** What a viewer receives on its own transport: `ice` first, then the host's offer, candidates and states. */
export type RtcMessage = { type: 'rtc'; conn: string; ice?: IceServer[]; sdp?: string; candidate?: unknown; state?: string };
/** Who is watching: a user id, or null for an anonymous link viewer. */
export interface RtcPrincipal { userId: number | null }
/** ICE for one host and one viewer. The server mints it; a desktop reads it off the relayed request. */
export interface RtcIce { host: IceServer[]; viewer: IceServer[] }
export const RTC_HEADER = 'x-rimeward-rtc';

/** Hours, not minutes: coturn authenticates every request with the same username and a movie outlives five minutes. */
const TURN_TTL = 12 * 3600;
const SDP_MAX = 32 * 1024;
const CANDIDATE_MAX = 1024;
const MESSAGES_MAX = 64;
/** Dev and tests: host candidates over loopback, no TURN (session.ts drops the UDP policy too). */
const direct = () => process.env.RIMEWARD_RTC_DIRECT === '1';
/** Peers per session: a desktop encodes on its GPU, a server on its four cores. */
const peersMax = () => (isDesktop() ? 3 : 2);
/** Every session of this runtime together. */
const globalMax = () => Number(process.env.RIMEWARD_RTC_VIEWERS ?? 4);
const maxBitrate = () => (isDesktop() ? 8_000_000 : 4_000_000);
/** H.264 encodes on VideoToolbox on a Mac; VP8 is the cheapest software encoder elsewhere. */
const CODECS = process.platform === 'darwin' ? 'h264' : 'vp8';

interface Peer { s: Session; answered: boolean; count: number }
const peers = new Map<string, Peer>();

/** ICE servers for a host and a viewer, minted where the TURN secret lives. Null = no relay
 *  configured, so a relay-only host would have no candidates at all: the viewer stays on JPEG. */
export function rtcIce(owner: number, viewer: RtcPrincipal): RtcIce | null {
  if (direct()) return { host: [], viewer: [] };
  const host = remoteTurn(owner, `browser-host:${randomBytes(6).toString('hex')}`, TURN_TTL);
  if (!host.available) return null;
  const v: IceServer[] = viewer.userId === null ? STUN_SERVERS : [...STUN_SERVERS, ...remoteTurn(viewer.userId, `browser:${randomBytes(6).toString('hex')}`, TURN_TTL).iceServers];
  return { host: host.iceServers, viewer: v };
}

/** The relayed stream request carries the ICE the server minted (devices.ts forwards RTC_HEADER). */
export function rtcIceFromRelay(request: Request): RtcIce | null {
  const raw = request.headers.get(RTC_HEADER);
  if (!raw || raw.length > 8192) return null;
  try {
    const v = JSON.parse(raw) as RtcIce;
    return Array.isArray(v?.host) && Array.isArray(v?.viewer) ? { host: v.host, viewer: v.viewer } : null;
  } catch { return null; }
}
export function withRtcHeader(request: Request, ice: RtcIce | null): Request {
  if (!ice) return request;
  const headers = new Headers(request.headers);
  headers.set(RTC_HEADER, JSON.stringify(ice));
  return new Request(request.url, { method: request.method, headers });
}

/** A viewer joins the session's stream. Null when there is no capture page, no ICE, or a peer
 *  cap is reached — the viewer stays on JPEG. `send` carries every rtc message to this viewer
 *  alone; `connected` flips its JPEG frames off and back on. */
export function rtcJoin(s: Session, ice: RtcIce | null, send: (msg: RtcMessage) => void, connected: (on: boolean) => void): { conn: string; leave: () => void } | null {
  if (!s.stream || !ice) return null;
  if (s.rtc.size >= peersMax() || peers.size >= globalMax()) return null;
  const conn = randomBytes(16).toString('hex');
  peers.set(conn, { s, answered: false, count: 0 });
  const sink = (msg: StreamSignal) => {
    if (msg.state === 'connected') connected(true);
    else if (msg.state === 'failed' || msg.state === 'closed' || msg.state === 'disconnected') connected(false);
    const out: RtcMessage = { type: 'rtc', conn };
    if (msg.sdp !== undefined) out.sdp = msg.sdp;
    if (msg.candidate !== undefined) out.candidate = msg.candidate;
    if (msg.state !== undefined) out.state = msg.state;
    send(out);
  };
  s.rtc.set(conn, sink);
  send({ type: 'rtc', conn, ice: ice.viewer });
  tell(s, { add: { conn, ice: ice.host, relay: !direct(), maxBitrate: maxBitrate(), codecs: CODECS } });
  return {
    conn,
    leave: () => {
      if (s.rtc.get(conn) !== sink) return;
      s.rtc.delete(conn);
      peers.delete(conn);
      tell(s, { remove: { conn } });
    },
  };
}

/** The viewer's answer or a candidate for its own connection: validated at this boundary, then
 *  handed to the page. False = refuse (the caller drops the message or the viewer). When `s` is
 *  given the connection must belong to that session. */
export function rtcInbound(conn: unknown, body: unknown, s?: Session): boolean {
  if (typeof conn !== 'string') return false;
  const p = peers.get(conn);
  if (!p || (s && p.s !== s) || ++p.count > MESSAGES_MAX) return false;
  if (!body || typeof body !== 'object') return false;
  const b = body as { sdp?: unknown; candidate?: unknown };
  if (typeof b.sdp === 'string') {
    if (p.answered || b.sdp.length > SDP_MAX || !b.sdp.includes('a=fingerprint:sha-256 ')) return false;
    p.answered = true;
    tell(p.s, { answer: { conn, sdp: b.sdp } });
    return true;
  }
  if (b.candidate && typeof b.candidate === 'object') {
    const c = b.candidate as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown };
    if (typeof c.candidate !== 'string' || c.candidate.length > CANDIDATE_MAX) return false;
    const mid = c.sdpMid ?? null, line = c.sdpMLineIndex ?? null;
    if (mid !== null && (typeof mid !== 'string' || mid.length > 16)) return false;
    if (line !== null && !(Number.isInteger(line) && (line as number) >= 0 && (line as number) <= 3)) return false;
    tell(p.s, { ice: { conn, candidate: { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: line } } });
    return true;
  }
  return false;
}

/** Live peers across every session of this runtime (tests, the health line). */
export const rtcPeers = (): number => peers.size;
