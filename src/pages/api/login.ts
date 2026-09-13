import { config } from '../../lib/app-config.ts';
import type { APIRoute } from 'astro';
import { SESSION_COOKIES, createSession, sessionCookieOptions, afterLogin } from '../../lib/auth.ts';
import { getUserByEmail, verifyUserPassword } from '../../lib/users.ts';

export const prerender = false;

// 5 failures / 15 min per IP+email. In-memory: a pm2 restart resets it, which
// is fine — this blunts scripts, not nation-states. Behind a reverse proxy the
// address is the proxy's, so the key is effectively the email alone: stricter
// than trusting X-Forwarded-For without a trusted-proxy list, and enough.
const failures = new Map<string, { n: number; at: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_KEYS = 1000;

function throttled(key: string): boolean {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.at > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.n >= MAX_FAILS;
}

function recordFailure(key: string): void {
  const f = failures.get(key);
  if (f && Date.now() - f.at <= WINDOW_MS) f.n += 1;
  else failures.set(key, { n: 1, at: Date.now() });
  // A key is only forgotten when it comes back, and a script hammering a
  // varying email never comes back: sweep what aged out, then evict oldest
  // first (Map iterates in insertion order) so the map stays bounded either way.
  if (failures.size > MAX_KEYS) {
    for (const [k, v] of failures) if (Date.now() - v.at > WINDOW_MS) failures.delete(k);
    for (const k of failures.keys()) {
      if (failures.size <= MAX_KEYS) break;
      failures.delete(k);
    }
  }
}

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  if (config('PASSWORD_LOGIN') !== 'true') return redirect('/login?err=disabled',303);
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const key = `${clientAddress}:${email}`;

  if (throttled(key)) return redirect('/login?err=throttled', 303);

  const user = email ? getUserByEmail(email) : null;
  if (!user || user.status !== 'active' || password.length > 1024 || !verifyUserPassword(user.id, password)) {
    recordFailure(key);
    return redirect('/login?err=1', 303);
  }

  failures.delete(key);
  const session = createSession(user.id);
  for (const name of SESSION_COOKIES) cookies.set(name, session.id, sessionCookieOptions(session.expiresAt));
  return redirect(afterLogin(cookies), 303);
};
