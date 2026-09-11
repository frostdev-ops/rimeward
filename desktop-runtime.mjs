// Parent-only stdin/stdout protocol. No credential is a command-line argument.
import readline from "node:readline";
import fs from "node:fs";
import crypto from "node:crypto";
const lines = readline.createInterface({ input: process.stdin });
const initial = await new Promise((resolve) =>
  lines.once("line", (line) => resolve(JSON.parse(line))),
);
process.env.RIMEWARD_DESKTOP = "1";
// The app's version: what /api/update/desktop compares against the newest release.
if (typeof initial.version === "string") process.env.RIMEWARD_DESKTOP_VERSION = initial.version;
process.env.RIMEWARD_NATIVE_TOKEN = crypto
  .randomBytes(32)
  .toString("base64url");
process.env.TOKEN_ENC_KEY = initial.key;
fs.mkdirSync(initial.data, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(initial.data, 0o700);
process.env.HOMEPAGE_DATA_DIR = initial.data;
process.env.PLAYWRIGHT_BROWSERS_PATH = initial.browsers;
process.env.HOST = "127.0.0.1";
process.env.PORT = String(initial.port ?? 0);
const pending = new Map();
let serial = 0;
const nativeRequest = (type, op, value) =>
  new Promise((resolve, reject) => {
    if (pending.size >= 32 || process.stdout.writableLength > 1024 * 1024) {
      reject(new Error("Desktop is busy. Retry after the current operation finishes."));
      return;
    }
    const id = ++serial;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error("Desktop request timed out"));
      },
      type === "desktop" ? 120000 : 15000,
    );
    pending.set(id, { resolve, reject, timer });
    const message = `${JSON.stringify({ type, id, op, value })}\n`;
    if (Buffer.byteLength(message) > (op === 'computer-clipboard' ? 12 : op === 'computer-files' ? 6 : 2) * 1024 * 1024) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error("Desktop request too large"));
      return;
    }
    process.stdout.write(message);
  });
globalThis.__nativeVault = (op, value) => nativeRequest("vault", op, value);
globalThis.__nativeDesktop = (op, value) => nativeRequest("desktop", op, value);
// Startup may not have installed the graceful shutdown handler yet.
const stop = () => { if (!process.emit("SIGTERM")) process.exit(0); };
lines.on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.type === "shutdown") {
      stop();
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error
      ? p.reject(
          new Error(
            typeof m.error === "string" ? m.error : "Desktop request failed",
          ),
        )
      : p.resolve(m.value);
  } catch {}
});
lines.on("close", () => {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Desktop disconnected")); }
  pending.clear();
  stop();
});
const { httpServer } = await import("./server.mjs");
if (!httpServer.listening)
  await new Promise((resolve) => httpServer.once("listening", resolve));
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    url:
      process.env.PUBLIC_BASE_URL +
      "/api/native/bootstrap?token=" +
      process.env.RIMEWARD_NATIVE_TOKEN,
  })}\n`,
);
