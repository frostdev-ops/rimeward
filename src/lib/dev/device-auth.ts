import crypto from "node:crypto";
import { getDb } from "../db.ts";
import { createSession } from "../auth.ts";
import { DevError } from "./runtime.ts";
import { PROTOCOL, enroll, claimEnrollment } from "./devices.ts";

const digest = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");
export const CONNECT_COOKIE = "rimeward_connect";
export const validUserCode = (s: unknown): s is string =>
  typeof s === "string" && /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(s);
interface Grant {
  device_hash: string;
  user_code: string;
  name: string;
  platform: string;
  protocol: number;
  user_id: number | null;
  status: string;
  expires_at: number;
  last_poll: number;
}
const attempts = new Map<string, { at: number; n: number }>();
export function limitDeviceAuth(key: string, limit = 20) {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.at > 60000) attempts.delete(k);
  if (attempts.size >= 2000 && !attempts.has(key))
    throw new DevError("Please try again in a minute.", 429);
  const row = attempts.get(key) ?? { at: now, n: 0 };
  attempts.set(key, row);
  if (++row.n > limit) throw new DevError("Please try again in a minute.", 429);
}
export function beginDeviceAuth(
  name: unknown,
  platform: unknown,
  protocol: unknown,
) {
  if (protocol !== PROTOCOL)
    throw new DevError("Update this desktop to connect to this server.", 409);
  const db = getDb(),
    now = Date.now();
  db.prepare("DELETE FROM device_authorizations WHERE expires_at<=?").run(now);
  if (
    (
      db.prepare("SELECT count(*) AS n FROM device_authorizations").get() as {
        n: number;
      }
    ).n >= 1000
  )
    throw new DevError("Too many connection requests. Try again shortly.", 429);
  const deviceCode = crypto.randomBytes(32).toString("base64url");
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase(),
    code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  db.prepare(
    "INSERT INTO device_authorizations(device_hash,user_code,name,platform,protocol,expires_at) VALUES(?,?,?,?,?,?)",
  ).run(
    digest(deviceCode),
    code,
    String(name || "My desktop").slice(0, 80),
    String(platform ?? "").slice(0, 30),
    PROTOCOL,
    now + 600000,
  );
  return {
    device_code: deviceCode,
    user_code: code,
    verification_uri: "/desktop/connect",
    verification_uri_complete: `/desktop/connect?code=${code}`,
    expires_in: 600,
    interval: 3,
  };
}
export function deviceAuthorization(code: unknown): Grant {
  if (!validUserCode(code))
    throw new DevError(
      "This connection link is invalid or expired. Start again from the desktop.",
      404,
    );
  const g = getDb()
    .prepare(
      "SELECT * FROM device_authorizations WHERE user_code=? AND expires_at>?",
    )
    .get(code, Date.now()) as Grant | undefined;
  if (!g)
    throw new DevError(
      "This connection link is invalid or expired. Start again from the desktop.",
      404,
    );
  return g;
}
export function approveDeviceAuth(code: unknown, user: number, allow: boolean) {
  const g = deviceAuthorization(code);
  if (g.status !== "pending")
    throw new DevError("This request has already been answered.", 409);
  getDb()
    .prepare(
      "UPDATE device_authorizations SET user_id=?,status=? WHERE device_hash=? AND status='pending'",
    )
    .run(user, allow ? "approved" : "denied", g.device_hash);
}
export function pollDeviceAuth(code: unknown, now = Date.now()) {
  if (typeof code !== "string" || code.length > 200)
    throw new DevError("Invalid connection request.", 400);
  const db = getDb();
  return db.transaction(() => {
    const g = db
      .prepare("SELECT * FROM device_authorizations WHERE device_hash=?")
      .get(digest(code)) as Grant | undefined;
    if (!g || g.expires_at <= now) return { error: "expired_token" };
    if (now - g.last_poll < 3000) return { error: "slow_down" };
    db.prepare(
      "UPDATE device_authorizations SET last_poll=? WHERE device_hash=?",
    ).run(now, g.device_hash);
    if (g.status === "pending") return { error: "authorization_pending" };
    db.prepare("DELETE FROM device_authorizations WHERE device_hash=?").run(
      g.device_hash,
    );
    if (g.status !== "approved" || !g.user_id)
      return { error: "access_denied" };
    const result = claimEnrollment(
      enroll(g.user_id).code,
      g.name,
      g.platform,
      g.protocol,
    );
    const account = db
      .prepare("SELECT email FROM users WHERE id=?")
      .get(g.user_id) as { email: string };
    return { ...result, name: g.name, email: account.email };
  })();
}
/** Only the native backend exchanges a paired credential for an app session. */
export function authenticatedDevice(token: unknown) {
  if (typeof token !== "string" || token.length > 200)
    throw new DevError("Reconnect this desktop.", 401);
  const db = getDb();
  const device = db
    .prepare("SELECT id,user_id FROM devices WHERE token_hash=?")
    .get(digest(token)) as { id: string; user_id: number } | undefined;
  if (!device)
    throw new DevError("This desktop was revoked. Connect again.", 401);
  return device;
}
export function deviceServerSession(token: unknown) {
  const device = authenticatedDevice(token), db = getDb();
  return db.transaction(() => {
    // Expired sessions go; live ones stay — the app shell's server window and the legacy tunnel hold
    // earlier ids, and a re-mint by the runtime used to log them out. Cap at the eight newest.
    db.prepare(
      "DELETE FROM sessions WHERE id IN (SELECT session_id FROM device_sessions WHERE device_id=?) AND expires_at <= datetime('now')",
    ).run(device.id);
    db.prepare(
      "DELETE FROM sessions WHERE id IN (SELECT s.id FROM sessions s JOIN device_sessions d ON d.session_id=s.id WHERE d.device_id=? ORDER BY s.expires_at DESC, s.rowid DESC LIMIT -1 OFFSET 7)",
    ).run(device.id);
    const session = createSession(device.user_id);
    db.prepare(
      "INSERT INTO device_sessions(device_id,session_id) VALUES(?,?)",
    ).run(device.id, session.id);
    return session;
  })();
}
