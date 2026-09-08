import "./_setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { csrfBlocked } from "../src/lib/csrf.ts";
import { workDb } from "../src/lib/dev/runtime.ts";
import { secretEqual } from "../src/lib/dev/native.ts";
import { once } from "node:events";
import WebSocket from "ws";
import { createUser } from "../src/lib/users.ts";
import { getDb } from "../src/lib/db.ts";
import {
  enroll,
  claimEnrollment,
  enrollment,
  deviceUpgrade,
  relaySocket,
  relayRequest,
  listDevices,
  revoke,
  allowedRelayPath,
} from "../src/lib/dev/devices.ts";

/** The desktop reconnects on every close code EXCEPT 4001; letting go must not read as revoked. */
function closeCode(ws: WebSocket) {
  return new Promise<number>(resolve => ws.on("close", code => resolve(code)));
}
const sockets = new Set<WebSocket>();
const server = http.createServer();
server.on("upgrade", (r, s, h) => deviceUpgrade(r, s as any, h));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `ws://127.0.0.1:${(server.address() as any).port}/api/devices/connect`;
after(() => {
  for (const s of sockets) s.terminate();
  server.closeAllConnections();
  server.close();
});
test(
  "paired relay streams content, scopes identities, and revokes live access without replication",
  { timeout: 10000 },
  async () => {
    const user = createUser("device-owner@example.com", null),
      other = createUser("other-owner@example.com", null);
    const { code } = enroll(user);
    assert.equal(enrollment(code).user_id, user);
    const pair = claimEnrollment(code, "PC", "darwin", 1);
    assert.throws(() => enrollment(code));
    const control = new WebSocket(url, {
      headers: { authorization: "Bearer " + pair.token },
    });
    sockets.add(control);
    await once(control, "message");
    assert.equal(listDevices(user)[0]?.online, true);
    assert.equal(listDevices(other).length, 0);
    await assert.rejects(() =>
      relayRequest(
        other,
        pair.id,
        "/api/test",
        new Request("https://example.com/api/test"),
      ),
    );
    const marker = "LOCAL_ONLY_" + crypto.randomUUID();
    control.on("message", async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== "request") return;
      const ws = new WebSocket(url, {
        headers: {
          authorization: "Bearer " + pair.token,
          "x-rimeward-request": event.id,
        },
      });
      sockets.add(ws);
      ws.on("open", () => {
        const local = http.createServer((req, res) => {
          assert.equal(req.headers.cookie, undefined);
          assert.equal(req.headers.authorization, undefined);
          const chunks: Buffer[] = [];
          req.on("data", (b) => chunks.push(b));
          req.on("end", () => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(marker + Buffer.concat(chunks).toString());
          });
        });
        local.emit("connection", relaySocket(ws));
      });
    });
    const response = await relayRequest(
      user,
      pair.id,
      "/api/test",
      new Request("https://example.com/api/test", {
        method: "POST",
        body: "input",
        headers: {
          cookie: "SERVER_COOKIE",
          authorization: "Bearer SERVER_SECRET",
          "content-type": "text/plain",
        },
      }),
    );
    assert.equal(await response.text(), marker + "input");
    assert.equal(
      response.headers.get("cache-control"),
      "no-store, no-transform",
    );
    const db = getDb();
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[])
      assert.ok(
        !JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(
          marker,
        ),
      );
    revoke(user, pair.id);
    assert.equal(listDevices(user).length, 0);
    await assert.rejects(() =>
      relayRequest(
        user,
        pair.id,
        "/api/test",
        new Request("https://example.com"),
      ),
    );
  },
);
test("relay prevents recursive and native management routes", () => {
  assert.equal(allowedRelayPath("/api/dev/sessions"), true);
  for (const path of [
    "//evil/",
    "/api/native/bootstrap",
    "/api/%6eative/bootstrap",
    "/api/dev/pair",
    "/api/dev/unpair",
    "/api/devices/claim",
    "/runtime/other",
    "/bad\r\nheader",
  ])
    assert.equal(allowedRelayPath(path), false);
});

test("native execution and relay mutations fail closed across trust boundaries", () => {
  assert.throws(() => workDb());
  assert.equal(secretEqual("é", "a"), false);
  assert.equal(
    csrfBlocked(
      new Request("https://rime.example/runtime/device/api/dev/input", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ),
    true,
  );
  assert.equal(
    csrfBlocked(
      new Request("https://rime.example/runtime/device/api/dev/input", {
        method: "POST",
        headers: {
          origin: "https://rime.example",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ),
    false,
  );
});

test("relay origin checks use the forwarded host when no canonical URL is configured", () => {
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    assert.equal(
      csrfBlocked(
        new Request("http://127.0.0.1:3005/runtime/device/api/dev/input", {
          method: "POST",
          headers: {
            host: "rime.example",
            origin: "https://rime.example",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      ),
      false,
    );
  } finally {
    if (saved !== undefined) process.env.PUBLIC_BASE_URL = saved;
  }
});

test("letting a desktop go and revoking it are different close codes", { timeout: 10000 }, async () => {
  const user = createUser("device-close-codes@example.com", null);
  const first = claimEnrollment(enroll(user).code, "PC", "darwin", 1);
  const a = new WebSocket(url, { headers: { authorization: "Bearer " + first.token } });
  sockets.add(a);
  await once(a, "message");
  // A second socket for the same device replaces the first: the older runtime must yield instead of reconnecting in a loop.
  const replaced = closeCode(a);
  const b = new WebSocket(url, { headers: { authorization: "Bearer " + first.token } });
  sockets.add(b);
  await once(b, "message");
  assert.equal(await replaced, 4001);
  // Revocation is final.
  const revoked = closeCode(b);
  revoke(user, first.id);
  assert.equal(await revoked, 4001);
});

test("a refused device upgrade answers with a status instead of a bare reset", { timeout: 10000 }, async () => {
  const user = createUser("device-upgrade-refused@example.com", null);
  const pair = claimEnrollment(enroll(user).code, "PC", "darwin", 1);
  for (const [headers, expected] of [
    [{ authorization: "Bearer not-a-real-token" }, 401],
    [{ authorization: "Bearer " + pair.token, "x-rimeward-request": crypto.randomUUID() }, 409],
  ] as const) {
    const ws = new WebSocket(url, { headers });
    sockets.add(ws);
    const [error] = await once(ws, "error") as [Error & { message: string }];
    assert.match(error.message, new RegExp(String(expected)), error.message);
  }
});
