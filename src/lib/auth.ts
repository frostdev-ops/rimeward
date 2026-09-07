import crypto from 'node:crypto';
import { getDb } from './db.ts';
import { revokeRemoteSessions } from './dev/remote-desktop-events.ts';

export const SESSION_COOKIE = 'rimeward_session';
export const SSO_STATE_COOKIE = 'rimeward_sso';
/** Only this fixed continuation survives login; never accept a redirect URL. */
export function afterLogin(cookies: {get(name:string):{value:string}|undefined;delete(name:string,opts:{path:string}):void}):string {
  const code=cookies.get('rimeward_connect')?.value;
  cookies.delete('rimeward_connect',{path:'/'});
  return code&&/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)?'/desktop/connect?code='+code:'/dash';
}
/** v0.16.0 renamed the cookies from frost_*. Browsers still carry the old one
 *  until they log in again, and the desktop app reads the session cookie BY
 *  NAME from its webview — so reads accept both names and a login sets both.
 *  Drop the legacy name once desktop-v0.1.3 (reads rimeward_session) is out. */
export const LEGACY_SESSION_COOKIE = 'frost_session';
export const SESSION_COOKIES = [SESSION_COOKIE, LEGACY_SESSION_COOKIE] as const;

/** The session id a request carries, whichever name it came under. */
export function sessionId(cookies: { get(name: string): { value: string } | undefined }): string | undefined {
  return cookies.get(SESSION_COOKIE)?.value ?? cookies.get(LEGACY_SESSION_COOKIE)?.value;
}
/** Only an https site can set a Secure cookie: an install reached over plain
 *  http (a LAN, Tailscale) would otherwise bounce on the login forever. */
const SECURE = (process.env.PUBLIC_BASE_URL ?? '').startsWith('https:');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SESSION_DAYS = 30;

/** "scrypt$N$r$p$<saltB64>$<hashB64>" */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSession(userId: number): { id: string; expiresAt: string } {
  const id = crypto.randomBytes(32).toString('base64url');
  const row = getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))
       RETURNING expires_at`
    )
    .get(id, userId) as { expires_at: string };
  return { id, expiresAt: row.expires_at };
}

export type Role = 'admin' | 'member';

export interface Session {
  userId: number;
  email: string;
  role: Role;
  displayName: string;
  /** JSON ThemeConfig (src/lib/theme.ts) or null for the stock theme. */
  theme: string | null;
}

export function getSession(id: string | undefined): Session | null {
  if (!id) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.user_id AS userId, u.email AS email, u.role AS role, u.display_name AS displayName, u.theme AS theme
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .get(id) as Session | undefined;
  if (row) return row;
  // Miss: cheap moment to sweep dead rows.
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  return null;
}

export function destroySession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  revokeRemoteSessions({ session: id });
}

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC; make it a real Date. */
/** The SSO state echo. Lax so Google's top-level redirect still sends it, and
 *  short-lived: it only has to survive one trip to the consent screen. */
export function ssoStateCookieOptions() {
  return {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 15 * 60,
  };
}

export function sessionCookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax' as const,
    path: '/',
    expires: new Date(expiresAt.replace(' ', 'T') + 'Z'),
  };
}
