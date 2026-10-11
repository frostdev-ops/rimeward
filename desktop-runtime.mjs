// Parent-only stdin/stdout protocol. No credential is a command-line argument.
import readline from "node:readline";
import fs from "node:fs";
import crypto from "node:crypto";
const lines = readline.createInterface({ input: process.stdin });
const initial = await new Promise((resolve) =>
  lines.once("line", (line) => resolve(JSON.parse(line))),
);
process.env.RIMEWARD_DESKTOP = "1";
if (typeof initial.documents === "string") process.env.RIMEWARD_DOCUMENTS_DIR = initial.documents;
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
// The deadline goes on the wire as an absolute time (the native side drops an
// op still queued then) and drives the local timer, so one clock governs both.
const nativeRequest = (type, op, value, deadlineMs = type === "desktop" ? 120000 : 15000, signal) =>
  new Promise((resolve, reject) => {
    const lens = type === 'desktop' && /^(lens-|overlay-|helper-)/.test(op);
    const control = lens && ['lens-start', 'lens-stop', 'lens-pause', 'lens-resume', 'lens-status', 'overlay-clear'].includes(op);
    if (signal?.aborted) { reject(new Error('Desktop request cancelled')); return; }
    // Four bounded control slots remain available when reads fill ordinary admission.
    const controls = [...pending.values()].filter((request) => request.control).length;
    if ((control ? controls >= 4 : pending.size - controls >= 32) || (!control && process.stdout.writableLength > 1024 * 1024)) {
      reject(new Error("Desktop is busy. Retry after the current operation finishes."));
      return;
    }
    const id = ++serial;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const cancel = (message) => {
      if (!pending.delete(id)) return;
      cleanup();
      if (lens) process.stdout.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
      reject(new Error(message));
    };
    const abort = () => cancel('Desktop request cancelled');
    const timer = setTimeout(() => {
      cancel('Desktop request timed out');
    }, deadlineMs);
    pending.set(id, { resolve, reject, cleanup, control });
    const message = `${JSON.stringify({ type, id, op, value, deadline: Date.now() + deadlineMs })}\n`;
    if (Buffer.byteLength(message) > (control ? 64 * 1024 : (op === 'computer-clipboard' ? 12 : op === 'computer-files' ? 6 : 2) * 1024 * 1024)) {
      pending.delete(id);
      cleanup();
      reject(new Error("Desktop request too large"));
      return;
    }
    process.stdout.write(message);
    signal?.addEventListener('abort', abort, { once: true });
  });
globalThis.__nativeVault = (op, value) => nativeRequest("vault", op, value);
globalThis.__nativeDesktop = (op, value, deadlineMs, signal) => nativeRequest("desktop", op, value, deadlineMs, signal);
// Lens signals are a push, not a reply, and start before the lens runtime is
// imported: they queue until __lensAttach installs the handler.
let lensSignal = null;
const lensQueue = [];
globalThis.__lensAttach = (fn) => {
  lensSignal = fn;
  for (const [line, m] of lensQueue.splice(0)) fn(line, m);
};
// Startup may not have installed the graceful shutdown handler yet.
const stop = () => { if (!process.emit("SIGTERM")) process.exit(0); };
lines.on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.type === "shutdown") {
      stop();
      return;
    }
    if (m.type === "lens") {
      if (lensSignal) lensSignal(line, m);
      else {
        if (lensQueue.length >= 4096) lensQueue.shift();
        lensQueue.push([line, m]);
      }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.cleanup();
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
  for (const p of pending.values()) { p.cleanup(); p.reject(new Error("Desktop disconnected")); }
  pending.clear();
  stop();
});
const { httpServer } = await import("./server.mjs");
if (!httpServer.listening)
  await new Promise((resolve) => httpServer.once("listening", resolve));
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
// The first request loads middleware, migrations and native services. Finish
// that work before telling the shell to replace its loading page.
const warm = await fetch(`${process.env.PUBLIC_BASE_URL}/login`);
if (!warm.ok) throw new Error("Local runtime failed to initialize");
await warm.arrayBuffer();
process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    url:
      process.env.PUBLIC_BASE_URL +
      "/api/native/bootstrap?token=" +
      process.env.RIMEWARD_NATIVE_TOKEN,
  })}\n`,
);
