import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
function turnSecret() {
  try { return process.env.RIMEWARD_TURN_SECRET || readFileSync(process.env.RIMEWARD_TURN_SECRET_FILE ?? '/etc/rimeward/turn.secret', 'utf8').trim(); }
  catch { return ''; }
}
let probe: Promise<{ configured: boolean; tlsReachable: boolean; checkedAt: string }> | undefined, checked = 0;
/** Certificate-validated listener health; the forced-TURN acceptance test proves actual allocation. */
export function remoteTurnHealth() {
  if (probe && Date.now() - checked < 60000) return probe;
  checked = Date.now();
  const configured = turnSecret().length >= 32, checkedAt = new Date().toISOString();
  probe = configured ? new Promise(resolve => {
    const socket = tls.connect({ host: TURN_HOST, port: 5349, servername: TURN_HOST, rejectUnauthorized: true });
    const done = (tlsReachable: boolean) => { socket.destroy(); resolve({ configured, tlsReachable, checkedAt }); };
    socket.setTimeout(3000); socket.once('secureConnect', () => done(true)); socket.once('timeout', () => done(false)); socket.once('error', () => done(false));
  }) : Promise.resolve({ configured, tlsReachable: false, checkedAt });
  return probe;
}
/** The relay every WebRTC media path uses (remote desktop, the browser ward's stream). */
export const TURN_HOST = 'turn.frostdev.io';
/** STUN only — what an anonymous viewer gets: it may learn its own address, never relay. */
export const STUN_SERVERS = [{ urls: `stun:${TURN_HOST}:3478` }];
/** coturn REST credentials, short-lived (300 s for a remote-desktop session; a browser stream
 *  passes hours, since coturn re-authenticates every request with the same username and a
 *  movie outlives five minutes) and scoped in audit to this account/session. */
export function remoteTurn(user: number, session: string, ttlSeconds = 300) {
  const secret = turnSecret();
  if (secret.length < 32) return { iceServers: [], servers: [], available: false };
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const identity = createHmac('sha256', secret).update(`${user}:${session}`).digest('hex').slice(0, 32);
  const username = `${expires}:${identity}`, credential = createHmac('sha1', secret).update(username).digest('base64');
  const host = TURN_HOST;
  const urls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`];
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(credential)}`;
  return { available: true, iceServers: [{ urls, username, credential }],
    servers: [`turn://${auth}@${host}:3478?transport=udp`, `turn://${auth}@${host}:3478?transport=tcp`, `turns://${auth}@${host}:5349?transport=tcp`] };
}
