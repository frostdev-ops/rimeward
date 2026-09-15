// Run after desktop/prebuild.mjs. Uses disposable data and the bundled Node.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(repo, "desktop/runtime");
const { target } = JSON.parse(
  fs.readFileSync(path.join(runtime, "runtime.json"), "utf8"),
);
const node = path.join(
  repo,
  "desktop/binaries",
  "rimeward-node-" + target + (process.platform === "win32" ? ".exe" : ""),
);
const data = fs.mkdtempSync(
  path.join(os.tmpdir(), "rimeward-standalone-test-"),
);
const project = path.join(data, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "hello.txt"), "original\r\n");
let child;
async function launch() {
  child = spawn(node, [path.join(runtime, "app/desktop-runtime.mjs")], {
    cwd: path.join(runtime, "app"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(
    JSON.stringify({
      key: Buffer.alloc(32, 9).toString("base64"),
      data: path.join(data, "state"),
      browsers: path.join(runtime, "browsers"),
    }) + "\n",
  );
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  const line = readline.createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error("Runtime startup timeout: " + stderr.join("").slice(-1200)),
        ),
      30000,
    );
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          "Runtime exited " + code + ": " + stderr.join("").slice(-1200),
        ),
      );
    });
    line.on("line", (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === "ready") {
          clearTimeout(timeout);
          resolve(m.url);
        }
        if (m.type === "vault")
          child.stdin.write(JSON.stringify({ id: m.id, value: "[]" }) + "\n");
      } catch {}
    });
  });
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 303);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const base = new URL(url).origin;
  const request = async (action, value) => {
    const res = await fetch(base + "/api/dev/" + action, {
      headers: {
        cookie,
        ...(value ? { "content-type": "application/json" } : {}),
      },
      method: value ? "POST" : "GET",
      body: value ? JSON.stringify(value) : undefined,
    });
    const json = await res.json();
    assert.ok(res.ok, JSON.stringify(json));
    return json;
  };
  assert.equal((await fetch(base + "/api/dev/projects")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/dev/projects", {
        headers: { cookie, origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(url, { redirect: "manual" })).status, 403);
  return { base, cookie, request };
}
async function stop() {
  const current = child;
  if (!current || current.exitCode !== null) return;
  const done = new Promise((resolve) => current.once("exit", resolve));
  current.stdin.write('{"type":"shutdown"}\n');
  await done;
}
try {
  let { request, base, cookie } = await launch();
  const p = await request("projects", { root: project });
  await request("preset", { root: project });
  const dashboard = await fetch(base + "/dash", { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Files/);
  const diagnostics = await request("lint", { project: p.id, path: "sample.ts", text: "const unused: any = 1;" });
  assert.ok(diagnostics.diagnostics.some((d) => d.code === "lint/suspicious/noExplicitAny"));
  const formatted = await request("format", { project: p.id, path: "sample.ts", text: "export const x=1" });
  assert.equal(formatted.text, "export const x = 1;\n");
  assert.equal(fs.existsSync(path.join(project, "sample.ts")), false);
  const view = await request("buffer?project=" + p.id + "&path=hello.txt");
  await request("buffer", {
    project: p.id,
    path: "hello.txt",
    text: "recovered\n",
    revision: view.revision,
    owner: "client:test",
  });
  const session = await request("sessions", { project: p.id, kind: "shell" });
  assert.equal(session.state, "running");
  await stop();
  ({ request } = await launch());
  const recovered = await request("buffer?project=" + p.id + "&path=hello.txt");
  assert.equal(recovered.text, "recovered\n");
  assert.equal(recovered.dirty, true);
  assert.equal(
    fs.readFileSync(path.join(project, "hello.txt"), "utf8"),
    "original\r\n",
  );
  const ended = await request("sessions?id=" + session.id);
  assert.notEqual(ended.session.state, "running");
  console.log(
    "Standalone packaged runtime: authentication, dashboard, bundled Biome lint/format, recovery, PTY, and restart passed.",
  );
} finally {
  await stop();
  fs.rmSync(data, { recursive: true, force: true });
}
