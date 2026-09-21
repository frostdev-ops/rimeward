/**
 * The two things every voice surface on a page must share, whatever kind of call it holds.
 *
 * The server allows one voice lease per user (a second start is a 409), and a machine has one
 * microphone. Dictation, read-aloud and a live conversation therefore cannot each keep their own
 * copy of this state: two modules with private owners would talk over each other, and two private
 * release chains would race the server's 409 on the handover between them.
 */

export interface SignalReply {
  sdp?: string;
  lease?: string;
  expiresAt?: number;
  active?: boolean;
  closed?: boolean;
  usage?: unknown;
}

export interface VoiceOwner { dispose: () => void }

let owner: VoiceOwner | undefined;
let releasing: Promise<boolean> = Promise.resolve(true);
window.addEventListener('pagehide', () => owner?.dispose());

/** Take the page's single capture/playback owner, disposing whoever held it. */
export function claimOwner(identity: VoiceOwner) {
  if (owner !== identity) owner?.dispose();
  owner = identity;
}
export const ownsAudio = (identity: VoiceOwner) => owner === identity;
export function releaseOwner(identity: VoiceOwner) { if (owner === identity) owner = undefined; }

/** Whether the previously held lease has confirmed it closed. A new call must wait on this. */
export const releasePending = () => releasing;
/** Queue a teardown behind the ones before it, so starts and stops stay in order. */
export function chainRelease(release: Promise<boolean>): Promise<boolean> {
  const previous = releasing;
  const next = Promise.all([previous, release]).then(([, closed]) => closed);
  releasing = next;
  return next;
}
/** Forget an unconfirmed close: the authoritative answer is the server's, on the next attempt. */
export function resetRelease() { releasing = Promise.resolve(true); }

export async function signal(
  ward: string,
  action: 'start' | 'status' | 'stop',
  body: { owner: string; lease?: string; sdp?: string },
): Promise<SignalReply> {
  const url = `/api/agent/${encodeURIComponent(ward)}/voice?_ward=${encodeURIComponent(ward)}`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ action, ...body }),
    // Keep harvesting a slow refresh/create after the shorter UI connection timeout closes media.
    signal: AbortSignal.timeout(action === 'start' ? 90_000 : 10_000), keepalive: action === 'stop',
  });
  const data = await response.json() as SignalReply & { error?: unknown };
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Voice is unavailable. Try again.');
  return data;
}
