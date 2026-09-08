import "./_setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/lib/users.ts";
import { getDb } from "../src/lib/db.ts";
import { getSession, afterLogin } from "../src/lib/auth.ts";
import { GET as runtimeBootstrap } from "../src/pages/api/runtime.ts";
import {
  beginDeviceAuth,
  approveDeviceAuth,
  pollDeviceAuth,
  deviceServerSession,
  deviceAuthorization,
} from "../src/lib/dev/device-auth.ts";
import {
  listDevices,
  revoke,
  allowedRelayPath,
} from "../src/lib/dev/devices.ts";

test("runtime bootstrap requires an authenticated user", async () => {
  const response = await runtimeBootstrap({ locals: {} } as Parameters<typeof runtimeBootstrap>[0]);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Sign in required." });
});

test("browser approval binds the initiating desktop, tokens are one-use, and revocation ends its server sessions", () => {
  const user = createUser("pair-flow@example.com", null),
    other = createUser("pair-other@example.com", null);
  const grant = beginDeviceAuth("My Mac", "darwin", 1),
    now = Date.now();
  assert.equal(
    pollDeviceAuth(grant.device_code, now).error,
    "authorization_pending",
  );
  assert.equal(pollDeviceAuth("wrong-secret", now).error, "expired_token");
  assert.equal(pollDeviceAuth(grant.device_code, now + 1).error, "slow_down");
  approveDeviceAuth(grant.user_code, user, true);
  assert.throws(() => approveDeviceAuth(grant.user_code, other, true));
  const paired = pollDeviceAuth(grant.device_code, now + 3100);
  assert.ok("token" in paired);
  if (!("token" in paired)) return;
  assert.equal(listDevices(other).length, 0);
  assert.equal(listDevices(user)[0]!.id, paired.id);
  assert.equal(
    pollDeviceAuth(grant.device_code, now + 6200).error,
    "expired_token",
  );
  const session = deviceServerSession(paired.token);
  assert.equal(getSession(session.id)?.userId, user);
  assert.throws(() => revoke(other, paired.id));
  assert.ok(getSession(session.id));
  revoke(user, paired.id);
  assert.equal(getSession(session.id), null);
  assert.throws(() => deviceServerSession(paired.token));
  assert.equal(
    JSON.stringify(getDb().prepare("SELECT * FROM devices").all()).includes(
      paired.token,
    ),
    false,
  );
});
test("declined and expired approvals cannot register a device, login continuation is a fixed path", () => {
  const user = createUser("denied-flow@example.com", null),
    g = beginDeviceAuth("Mac", "darwin", 1);
  approveDeviceAuth(g.user_code, user, false);
  assert.equal(pollDeviceAuth(g.device_code).error, "access_denied");
  assert.equal(listDevices(user).length, 0);
  const expired = beginDeviceAuth("Old", "darwin", 1);
  assert.equal(
    pollDeviceAuth(expired.device_code, Date.now() + 600001).error,
    "expired_token",
  );
  assert.throws(() => deviceAuthorization("https://evil.example"));
  for (const code of ["https://evil.example", "//evil.example", "ABCD-EF12"]) {
    let deleted = false;
    const target = afterLogin({
      get: () => ({ value: code }),
      delete: () => {
        deleted = true;
      },
    });
    assert.equal(
      target,
      code === "ABCD-EF12" ? "/desktop/connect?code=ABCD-EF12" : "/dash",
    );
    assert.equal(deleted, true);
  }
  for (const route of [
    "sign-in-start",
    "sign-in-poll",
    "sign-in-open",
    "sign-in-cancel",
    "folder",
    "onboard",
    "open-server",
  ])
    assert.equal(allowedRelayPath("/api/dev/" + route), false);
});

test("a re-minted device session keeps the shell's live sessions and prunes only expired ones", () => {
  const user = createUser("device-session-keep@example.com", null);
  const grant = beginDeviceAuth("Session Mac", "darwin", 1);
  approveDeviceAuth(grant.user_code, user, true);
  const paired = pollDeviceAuth(grant.device_code, Date.now() + 3100);
  assert.ok("token" in paired);
  if (!("token" in paired)) return;
  // The Tauri shell copies the first session into its server window; the runtime re-mints its own.
  const shell = deviceServerSession(paired.token), runtime = deviceServerSession(paired.token);
  assert.notEqual(shell.id, runtime.id);
  assert.equal(getSession(shell.id)?.userId, user, "the shell window stays signed in");
  assert.equal(getSession(runtime.id)?.userId, user);
  getDb().prepare("UPDATE sessions SET expires_at=datetime('now','-1 day') WHERE id=?").run(shell.id);
  deviceServerSession(paired.token);
  assert.equal(getDb().prepare("SELECT 1 FROM sessions WHERE id=?").get(shell.id), undefined, "expired sessions are swept");
  // Never unbounded: the newest eight survive.
  for (let i = 0; i < 12; i++) deviceServerSession(paired.token);
  const kept = getDb().prepare("SELECT COUNT(*) AS n FROM device_sessions WHERE device_id=?").get(paired.id) as { n: number };
  assert.ok(kept.n <= 8, `kept ${kept.n}`);
});
