import crypto from "node:crypto";
import { isDesktop } from "./runtime.ts";
import { createUser, getUserByEmail, setDisplayName } from "../users.ts";
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../auth.ts";
import { getDb } from "../db.ts";
import type { APIContext } from "astro";
import { restoredDesktopPath } from './navigation.ts';

export function secretEqual(
  a: string | null | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
export function localOwner() {
  const existing = getUserByEmail("owner@rimeward.local");
  if (existing) return existing.id;
  const id = createUser("owner@rimeward.local", null, "admin");
  setDisplayName(id, "Local owner");
  return id;
}
let redeemed = false;
/** Native bearer is an installation capability, never inferred from loopback. */
export function nativeRequest(context: APIContext): Response | undefined {
  if (!isDesktop()) return;
  const { request, url, cookies } = context;
  const base = process.env.PUBLIC_BASE_URL;
  if (!base || request.headers.get("host") !== new URL(base).host)
    return new Response("Invalid host", { status: 403 });
  const trusted = secretEqual(
    request.headers.get("x-rimeward-native-token"),
    process.env.RIMEWARD_NATIVE_TOKEN,
  );
  const origin = request.headers.get("origin");
  if (!trusted && origin && origin !== process.env.PUBLIC_BASE_URL)
    return new Response("Invalid origin", { status: 403 });
  if (url.pathname === "/api/native/bootstrap") {
    if (
      redeemed ||
      !secretEqual(
        url.searchParams.get("token"),
        process.env.RIMEWARD_NATIVE_TOKEN,
      )
    )
      return new Response("Invalid bootstrap", { status: 403 });
    redeemed = true;
    const session = createSession(localOwner());
    cookies.set(
      SESSION_COOKIE,
      session.id,
      sessionCookieOptions(session.expiresAt),
    );
    const restore = restoredDesktopPath(url.searchParams.get('restore'));
    // Startup redirects from the bundled app origin into loopback. Strict
    // cookies are withheld on that first document, losing the restore marker.
    if (restore && process.platform === 'darwin') cookies.set('rimeward_ui_restore', '1', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 });
    return context.redirect(restore ?? "/desktop/start", 303);
  }
  if (trusted) {
    context.locals.user = getDb()
      .prepare(
        "SELECT id AS userId,email,role,display_name AS displayName,theme FROM users WHERE id=?",
      )
      .get(localOwner()) as NonNullable<typeof context.locals.user>;
  }
}
