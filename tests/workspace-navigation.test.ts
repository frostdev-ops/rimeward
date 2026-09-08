import "./_setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/lib/users.ts";
import { saveDashboard } from "../src/lib/dashboard.ts";
import { runtimeNavigation, rememberPage, workspacePath, restoredDesktopPath } from "../src/lib/dev/navigation.ts";
import { authenticatedDevice, deviceServerSession } from "../src/lib/dev/device-auth.ts";
import { claimEnrollment, enroll, revoke, allowedRelayPath } from "../src/lib/dev/devices.ts";
import { getSession } from "../src/lib/auth.ts";
import { ALL as devices } from "../src/pages/api/devices/[...action].ts";
import { GET, POST } from "../src/pages/api/runtime.ts";

test("workspace navigation remembers the same page for local and remote clients, scoped to its owner", async () => {
  const user = createUser("workspace-owner@example.com", null), other = createUser("workspace-other@example.com", null);
  saveDashboard(user, [], [{ id: "home", title: "Home" }, { id: "project", title: "My project", project: "private-project-id" }]);
  rememberPage(user, "project");
  const nav = runtimeNavigation(user);
  assert.equal(nav.activePage, "project");
  assert.deepEqual(nav.pages[1], { id: "project", title: "My project" });
  assert.notEqual(runtimeNavigation(other).activePage, "project");
  assert.throws(() => rememberPage(other, "project"));
  const response = await GET({ locals: { user: { userId: user } }, url: new URL("https://example.com/api/runtime?navigation=1") } as Parameters<typeof GET>[0]);
  assert.deepEqual(await response.json(), nav);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await POST({ locals: {}, request: new Request("https://example.com/api/runtime", { method: "POST", body: '{}' }) } as Parameters<typeof POST>[0])).status, 401);
  saveDashboard(user, [], [{ id: "home", title: "Home" }]);
  assert.equal(runtimeNavigation(user).activePage, "home", "a removed page heals to the first page");
});

test("paired navigation is read-only, rejects browser origins and revoked credentials, and does not rotate the app session", async () => {
  const user = createUser("workspace-pair@example.com", null), other = createUser("workspace-pair-other@example.com", null);
  saveDashboard(user, [], [{ id: "home", title: "Owner page" }]);
  saveDashboard(other, [], [{ id: "home", title: "Other page" }]);
  const pair = claimEnrollment(enroll(user).code, "Computer", "darwin", 1);
  const session = deviceServerSession(pair.token);
  assert.equal(authenticatedDevice(pair.token).user_id, user);
  const request = (origin?: string) => devices({ params: { action: "navigation" }, locals: {}, request: new Request("https://example.com/api/devices/navigation", { headers: { authorization: `Bearer ${pair.token}`, ...(origin ? { origin } : {}) } }) } as unknown as Parameters<typeof devices>[0]);
  const response = await request();
  assert.equal(response.status, 200);
  const nav = await response.json();
  assert.equal(nav.pages[0].title, "Owner page");
  assert.equal(nav.devices[0].id, pair.id);
  assert.ok(getSession(session.id));
  assert.equal((await request("https://example.com")).status, 403);
  revoke(user, pair.id);
  assert.equal((await request()).status, 401);
});

test("native workspace navigation admits only app destinations and cannot be remotely relayed", () => {
  assert.equal(workspacePath("project"), "/dash#p=project");
  assert.equal(workspacePath(undefined, "connections"), "/desktop/start?setup=1");
  for (const page of ["//evil.example", "../outside", "x?y=z", "x#foo", "", "a".repeat(81)]) assert.throws(() => workspacePath(page));
  assert.throws(() => workspacePath(undefined, "shell"));
  for (const route of ["navigation", "navigate", "pairings", "open-server"]) assert.equal(allowedRelayPath(`/api/dev/${route}`), false);
  assert.equal(allowedRelayPath("/api/runtime?navigation=1"), true);
});


test("permission relaunch restores only app screens without replaying credentials or actions", () => {
  for (const path of ["/dash#p=project", "/dash?workspace=project#p=project", "/desktop/start?setup=1", "/account"])
    assert.equal(restoredDesktopPath(path), path);
  for (const path of [null, "//evil.example/dash", "/\\evil.example/dash", "/api/logout", "/api/native/bootstrap?token=x", "/dash?token=x", "/dash?workspace=x&token=y", "/dash" + "x".repeat(3000)])
    assert.equal(restoredDesktopPath(path), null);
});
