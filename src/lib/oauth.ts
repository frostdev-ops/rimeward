import crypto from 'node:crypto';
import { publicOrigin } from './app-config.ts';
import { getSession, sessionId } from './auth.ts';
import { setSetting, sweepSettings, takeSetting } from './settings.ts';

// OAuth pending state lives in the settings KV (not memory) so a pm2 restart
// mid-flow survives. Keyed per state: two people connecting concurrently must
// not clobber each other.

const TTL_MS = 15 * 60 * 1000;

export interface PendingState {
  provider: 'google-sso' | 'google' | 'microsoft' | 'notion' | 'zoho';
  userId?: number;
  /** Microsoft only: the Mail.Send-less retry after a tenant denies consent. */
  readonly?: boolean;
  brokerId?: string;
  at: number;
}

export function mintState(provider: PendingState['provider'], userId?: number, extra?: Partial<PendingState>): string {
  sweepSettings('oauth_pending:', TTL_MS);
  const state = crypto.randomBytes(24).toString('base64url');
  setSetting(
    `oauth_pending:${state}`,
    JSON.stringify({ provider, userId, ...extra, at: Date.now() } satisfies PendingState)
  );
  return state;
}

/** One-shot: the delete is the check. Expired or unknown → null. */
export function takeState(state: string): PendingState | null {
  if (!/^[A-Za-z0-9_-]{20,50}$/.test(state)) return null;
  const raw = takeSetting(`oauth_pending:${state}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingState;
    if (Date.now() - parsed.at > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The connect callbacks are public — the one-shot state is all they carry, so
 *  on its own it does not say WHICH browser is finishing the flow. Without this
 *  check an attacker mints a connect URL for their own user, walks a victim
 *  through it, and the victim's provider tokens land on the attacker's account.
 *  The session cookie rides along (SameSite=Lax sends it on a top-level GET). */
export function takeConnectState(
  state: string,
  cookies: { get(name: string): { value: string } | undefined }
): PendingState | null {
  const pending = takeState(state);
  if (!pending?.userId) return null;
  return getSession(sessionId(cookies))?.userId === pending.userId ? pending : null;
}

export function baseUrl(): string {
  return publicOrigin();
}
