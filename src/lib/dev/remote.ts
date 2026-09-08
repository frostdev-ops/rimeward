import { runtimeNavigation, workspacePath } from "./navigation.ts";
import type { WorkspaceEntry, WorkspaceNavigation } from "./types.ts";
import { ensureRimeSync, disconnectRime } from '../agent/sync.ts';
import http from "node:http";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { getSetting, setSetting } from "../settings.ts";
import { repoDir } from "../db.ts";
import { DevError, requireDesktop, isDesktop } from "./runtime.ts";
import { localOwner } from "./native.ts";
import { REMOTE_LIMITS } from './remote-desktop-contract.ts';
import {
  PROTOCOL,
  CHANNEL_CAP,
  allowedRelayPath,
  forwardHeaders,
  relaySocket,
} from "./devices.ts";
interface Pair {
  server: string;
  id: string;
  token: string;
  name: string;
}
const bootId = crypto.randomUUID();
type NativeGlobal = typeof globalThis & {
  __nativeVault?: (op: string, value?: string) => Promise<string>;
  __nativeDesktop?: (op: string, value?: unknown) => Promise<unknown>;
};
export async function nativeDesktop(op: string, value?: unknown) {
  requireDesktop();
  const fn = (globalThis as NativeGlobal).__nativeDesktop;
  if (!fn)
    throw new DevError(
      "Open this page in the desktop app to use the folder picker or browser sign-in.",
      409,
    );
  return fn(op, value);
}
let pairs: Pair[] = [];
let loaded = false;
/** The first configured Rime server is the shared profile; other pairs remain workspace connections. */
export async function rimeConnection(user:number) {
  await remotePairs(user);
  return pairs[0];
}
const serverSessions = new Map<string, { id: string; expiresAt: string }>();
const controls = new Map<string, WebSocket>();
/** Pairs the server told us it revoked: their socket close must not schedule a reconnect. */
const revoked = new Set<string>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
const channels = new Map<string, Set<WebSocket>>();
async function vault(op: string, value?: string) {
  const fn = (globalThis as NativeGlobal).__nativeVault;
  if (!fn) throw new DevError("Desktop credential store is unavailable.", 503);
  return fn(op, value);
}
function serverOrigin(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new DevError("Use an HTTPS Rimeward server.");
  return u.origin;
}
export async function remotePairs(user: number) {
  requireDesktop();
  if (user !== localOwner())
    throw new DevError("Only the local owner can pair this desktop.", 403);
  if (!loaded) {
    pairs = JSON.parse(await vault("get"));
    loaded = true;
    pairs.forEach(connect);
    if(pairs.length)ensureRimeSync(user);
  }
  return pairs.map(({ server, id, name }) => ({
    server,
    id,
    name,
    online: controls.get(id)?.readyState === WebSocket.OPEN,
  }));
}
async function enrollmentRequest(
  server: string,
  action: string,
  body: unknown,
) {
  const res = await fetch(`${serverOrigin(server)}/api/devices/${action}`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new DevError(
      res.status === 404
        ? "This server needs the desktop connection update. Update the server, then try again."
        : "Could not connect to this Rimeward server. Check the address and try again.",
      res.status,
    );
  try {
    return await res.json();
  } catch {
    throw new DevError(
      "This address did not return a Rimeward connection. Check the server address.",
      502,
    );
  }
}
interface SignIn {
  server: string;
  code: string;
  verificationUrl: string;
  name: string;
  user: number;
  expires: number;
  lastPoll: number;
  busy?: boolean;
  result?: { id: string; email: string; server: string };
}
const signIns = new Map<string, SignIn>();
export async function beginSignIn(user: number, server: string) {
  await remotePairs(user);
  for (const [id, s] of signIns)
    if (s.user === user || s.expires < Date.now()) signIns.delete(id);
  const origin = serverOrigin(server),
    name = os.hostname().replace(/\.local$/, "") || "My desktop";
  const grant = await enrollmentRequest(origin, "authorize", {
    name,
    platform: process.platform,
    protocol: PROTOCOL,
  });
  if (
    typeof grant.device_code !== "string" ||
    !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(grant.user_code)
  )
    throw new DevError("Invalid server connection response.", 502);
  const id = crypto.randomUUID(),
    verificationUrl = `${origin}/desktop/connect?code=${grant.user_code}`;
  signIns.set(id, {
    server: origin,
    code: grant.device_code,
    verificationUrl,
    name,
    user,
    expires: Date.now() + 600000,
    lastPoll: 0,
  });
  let browserOpened = true;
  try {
    await nativeDesktop("open-url", { url: verificationUrl });
  } catch {
    browserOpened = false;
  }
  return {
    id,
    verificationUrl,
    userCode: grant.user_code,
    interval: 3,
    browserOpened,
  };
}
function signInOf(user: number, id: string) {
  const s = signIns.get(id);
  if (!s || s.user !== user || s.expires <= Date.now())
    throw new DevError("Connection request expired. Start again.", 410);
  return s;
}
export async function openSignIn(user: number, id: string) {
  const s = signInOf(user, id);
  await nativeDesktop("open-url", { url: s.verificationUrl });
  return { ok: true };
}
export function cancelSignIn(user: number, id: string) {
  signInOf(user, id);
  signIns.delete(id);
  return { ok: true };
}
export async function pollSignIn(user: number, id: string) {
  const s = signInOf(user, id);
  if (s.result) return { status: "connected" as const, ...s.result };
  if (s.busy || Date.now() - s.lastPoll < 3000) return { status: "pending" as const };
  s.busy = true;
  s.lastPoll = Date.now();
  try {
    const result = await enrollmentRequest(s.server, "token", {
      device_code: s.code,
    });
    if (
      result.error === "authorization_pending" ||
      result.error === "slow_down"
    )
      return { status: "pending" as const };
    if (result.error)
      throw new DevError(
        result.error === "access_denied"
          ? "Connection declined. You can start again."
          : "Connection request expired. Start again.",
        409,
      );
    if (signIns.get(id) !== s)
      throw new DevError(
        "Connection cancelled. Any approved device can be revoked on the server.",
        409,
      );
    if (typeof result.id !== "string" || typeof result.token !== "string")
      throw new DevError("Invalid connection response.", 502);
    const p = {
      id: result.id,
      token: result.token,
      server: s.server,
      name: s.name,
    };
    const next = [...pairs, p];
    await vault("set", JSON.stringify(next));
    pairs = next;
    connect(p);
    ensureRimeSync(user);
    s.result = {
      id: p.id,
      email: String(result.email ?? ""),
      server: p.server,
    };
    return { status: "connected" as const, ...s.result };
  } finally {
    s.busy = false;
  }
}
export async function onboarding(user: number) {
  return {
    complete: getSetting(`desktop:onboarded:${user}`) === "1",
    home: getSetting(`desktop:home:${user}`) ?? "local",
    pairs: await remotePairs(user),
  };
}
export async function completeOnboarding(user: number, home: string) {
  const list = await remotePairs(user);
  if (home !== "local" && !list.some((p) => p.id === home))
    throw new DevError("Select a connected server.");
  setSetting(`desktop:home:${user}`, home);
  setSetting(`desktop:onboarded:${user}`, "1");
  return { ok: true };
}
export async function openServer(user: number, id: string, path = "/dash") {
  await remotePairs(user);
  const p = pairs.find((p) => p.id === id);
  if (!p) throw new DevError("Connect this server first.", 404);
  const session = await serverSession(p);
  await nativeDesktop("server", { url: `${p.server}${path}`, session: session.id, device: p.id });
  return { ok: true };
}
const sessionRequests = new Map<string, Promise<{ id: string; expiresAt: string }>>();
/** The server caps sessions per device and expires old ones: concurrent creations would churn them. */
function serverSession(p: Pair) {
  const session = serverSessions.get(p.id);
  if (session && Date.parse(`${session.expiresAt.replace(" ", "T")}Z`) >= Date.now() + 60_000) return Promise.resolve(session);
  let pending = sessionRequests.get(p.id);
  if (!pending) {
    pending = createServerSession(p).finally(() => sessionRequests.delete(p.id));
    sessionRequests.set(p.id, pending);
  }
  return pending;
}
async function createServerSession(p: Pair) {
  const response = await fetch(`${p.server}/api/devices/session`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${p.token}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new DevError(
      response.status === 401
        ? "This connection was revoked. Connect again."
        : "Server unavailable. You can continue on this desktop.",
      response.status,
    );
  const session = await response.json() as { id: string; expiresAt: string };
  serverSessions.set(p.id, session);
  return session;
}

/** Authenticated streaming transport for the connected instance. Never retry a mutation. */
export async function instanceRequest(user: number, path: string, request: Request): Promise<Response> {
  const pair = await rimeConnection(user);
  if (!pair || !path.startsWith('/') || path.startsWith('//')) throw new DevError('Connection unavailable.', 503);
  const session = await serverSession(pair);
  const headers = new Headers({ cookie: `rimeward_session=${session.id}` });
  for (const key of forwardHeaders) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  // A same-origin request on the desktop remains same-origin at the server.
  headers.set('origin', pair.server);
  const body = !['GET', 'HEAD'].includes(request.method) ? request.body : undefined;
  // This deadline includes uploading the request body, not just establishing the connection.
  const connect = new AbortController(), timeout = setTimeout(() => connect.abort(),
    body && path.startsWith('/api/remote-desktop/sessions/') ? 120000 : 15000);
  let response: Response;
  try {
    response = await fetch(`${pair.server}${path}`, {
      method: request.method, headers, body, ...(body ? { duplex: 'half' } : {}), redirect: 'manual',
      signal: AbortSignal.any([request.signal, connect.signal]),
    } as RequestInit);
  } catch (e) {
    if (!request.signal.aborted) disconnectRime(user);
    throw e;
  } finally { clearTimeout(timeout); }
  // A revoked session answers 401 on /api and a /login redirect on documents; the next call re-creates it.
  if (response.status === 401 || (response.status === 303 && /\/login(?:\?|$)/.test(response.headers.get('location') ?? ''))) { if (serverSessions.get(pair.id)?.id === session.id) serverSessions.delete(pair.id); }
  const out = new Headers(response.headers);
  for (const key of ['set-cookie', 'content-length', 'content-encoding']) out.delete(key);
  out.set('cache-control', 'no-store');
  out.set('x-accel-buffering', 'no');
  const location = out.get('location');
  if (location?.startsWith(`${pair.server}/`)) out.set('location', location.slice(pair.server.length));
  return new Response(response.body, { status: response.status, headers: out });
}
export async function previewPair(user: number, server: string, code: string) {
  await remotePairs(user);
  return enrollmentRequest(server, "preview", { code });
}
export async function pairDesktop(
  user: number,
  server: string,
  code: string,
  name: string,
) {
  await remotePairs(user);
  const origin = serverOrigin(server);
  const result = await enrollmentRequest(origin, "claim", {
    code,
    name,
    platform: process.platform,
    protocol: PROTOCOL,
  });
  const p = {
    server: origin,
    id: result.id,
    token: result.token,
    name: String(name).slice(0, 80) || "Desktop",
  };
  const next = [...pairs, p];
  await vault("set", JSON.stringify(next));
  pairs = next;
  connect(p);
  ensureRimeSync(user);
  return { id: p.id };
}
export async function unpairDesktop(user: number, id: string) {
  await remotePairs(user);
  const next = pairs.filter((p) => p.id !== id);
  await vault("set", JSON.stringify(next));
  pairs = next;
  const { stopRemoteHostSessions } = await import('./remote-desktop-host.ts');
  await stopRemoteHostSessions();
  await nativeDesktop('computer-disconnect').catch(() => {});
  serverSessions.delete(id);
  disconnectRime(user);
  clearTimeout(retries.get(id));
  controls.get(id)?.close();
  controls.delete(id);
  for (const ws of channels.get(id) ?? []) ws.terminate();
  channels.delete(id);
  return { ok: true };
}
function connect(pair: Pair) {
  if (controls.has(pair.id)) return;
  const ws = new WebSocket(
    `${pair.server.replace(/^https:/, "wss:")}/api/devices/connect`,
    {
      headers: { authorization: `Bearer ${pair.token}`, 'x-rimeward-boot': bootId, 'x-rimeward-remote-desktop': '1' },
      maxPayload: 16_384,
      perMessageDeflate: false,
    },
  );
  controls.set(pair.id, ws);
  channels.set(pair.id, new Set());
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);
  heartbeat.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'remote-policy-changed') {
        void import('./computer.ts').then(m => m.invalidateComputerPolicy()).catch(() => {});
        return;
      }
      if (m.type === 'remote-revoked') {
        revoked.add(pair.id);
        void import('./remote-desktop-host.ts').then(m => m.stopRemoteHostSessions());
        void nativeDesktop('computer-disconnect').catch(() => {});
        return;
      }
      if (
        m.type === "request" &&
        /^[\w-]{36}$/.test(m.id) &&
        m.base === `/runtime/${pair.id}`
      )
        openChannel(pair, m.id, m.base, m.remote, m.agentCaller);
    } catch {}
  });
  ws.on("close", (code) => {
    clearInterval(heartbeat);
    if (controls.get(pair.id) === ws) controls.delete(pair.id);
    for (const channel of channels.get(pair.id) ?? []) channel.terminate();
    channels.delete(pair.id);
    // 4001 = revoked or replaced. Heartbeat and network failures reconnect.
    if (code !== 4001 && !revoked.has(pair.id) && pairs.some((p) => p.id === pair.id)) {
      const timer = setTimeout(() => connect(pair), 5000);
      timer.unref();
      retries.set(pair.id, timer);
    }
  });
}
function openChannel(pair: Pair, id: string, base: string, remote?: import('./devices.ts').RemoteRelayContext, agentCaller?: string) {
  // A dropped channel surfaces on the server as a 10 s 504 "did not respond": say why here at least.
  const drop = (why: string) => console.warn(`[relay] channel refused: ${why}`);
  if (agentCaller !== undefined && !/^[a-f0-9]{64}$/.test(agentCaller)) return drop("invalid agent caller");
  // Grants arrive on the authenticated live socket. Translate their bounded lifetime once to
  // the host clock; forwarding the server's wall clock broke hosts more than one second behind.
  if (remote?.issuedAt !== undefined) {
    const lifetime = remote.expires - remote.issuedAt;
    if (!Number.isSafeInteger(remote.issuedAt) || !Number.isSafeInteger(remote.expires) || lifetime <= 0 || lifetime > REMOTE_LIMITS.authorizationMs)
      return drop('invalid remote grant lifetime');
    remote = { ...remote, expires: Date.now() + lifetime };
  }
  if (remote && (remote.protocol !== 1 || remote.device !== pair.id || !Number.isSafeInteger(remote.expires) || remote.expires <= Date.now() || remote.expires > Date.now() + 31000))
    return drop(remote.device !== pair.id ? "remote context for another device" : "remote context expired or clock skew over 31 s");
  const set = channels.get(pair.id);
  if (!set || set.size >= CHANNEL_CAP) return drop(`channel cap ${CHANNEL_CAP} reached`);
  const ws = new WebSocket(
    `${pair.server.replace(/^https:/, "wss:")}/api/devices/connect`,
    {
      headers: {
        authorization: `Bearer ${pair.token}`,
        "x-rimeward-request": id,
      },
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    },
  );
  set.add(ws);
  ws.on("error", () => {});
  ws.on("close", () => set.delete(ws));
  ws.on("open", () => {
    const local = http.createServer((req, res) => {
      if (!req.url || !allowedRelayPath(req.url, !!remote, !!agentCaller)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const token = process.env.RIMEWARD_NATIVE_TOKEN;
      if (!token) { res.writeHead(503); res.end(); return; }
      const headers: Record<string, string> = { "x-rimeward-native-token": token, "x-rimeward-relayed": "1" };
      if (remote) headers['x-rimeward-remote-context'] = Buffer.from(JSON.stringify(remote)).toString('base64url');
      if (agentCaller) headers['x-rimeward-agent-caller'] = agentCaller;
      for (const key of forwardHeaders) {
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
      const target = new URL(req.url, process.env.PUBLIC_BASE_URL);
      const upstream = http.request(
        target,
        { method: req.method, headers },
        (response) => {
          const headers = { ...response.headers };
          delete headers["set-cookie"];
          delete headers["content-length"];
          headers["cache-control"] = "no-store";
          headers["x-accel-buffering"] = "no";
          res.writeHead(response.statusCode ?? 502, headers);
          if (headers["content-type"]?.includes("text/html")) {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                upstream.destroy();
                res.destroy();
              } else chunks.push(chunk);
            });
            response.on("end", () =>
              res.end(relayHtml(Buffer.concat(chunks).toString(), base)),
            );
          } else response.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      const disconnected = () => upstream.destroy();
      ws.once('close', disconnected);
      res.on("close", () => { ws.off('close', disconnected); upstream.destroy(); });
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    });
    const stream = relaySocket(ws);
    stream.on("error", () => {});
    local.emit("connection", stream);
  });
}
export function relayHtml(html: string, base: string) {
  if (!/^\/runtime\/[\w-]{36}$/.test(base))
    throw new DevError("Invalid runtime.", 403);
  const bridge = fs.readFileSync(repoDir("public/runtime-bridge.js"), "utf8");
  return html
    .replace(
      /srcset=(["'])(.*?)\1/g,
      (_, quote, value) =>
        "srcset=" +
        quote +
        value.replace(/(^|[,\s])\/(?!\/)/g, `$1${base}/`) +
        quote,
    )
    .replace(
      /((?:src|href|action|poster|data-default)=["'])\/(?!\/)/g,
      `$1${base}/`,
    )
    .replace(/url\(["']?\/(?!\/)/g, (match) => `${match + base.slice(1)}/`)
    // Same match as routeInstance's marker injection: a <head> with attributes must still get the bridge.
    .replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta name="rimeward-runtime-base" content="${base}"><script>${bridge}</script>`);
}
export function ensureRemote() {
  if (isDesktop() && (globalThis as NativeGlobal).__nativeVault)
    void remotePairs(localOwner()).catch(() => {});
}

/** Gather the connected workspace list on demand. Remote payloads are not written to disk. */
export async function desktopNavigation(user: number): Promise<WorkspaceNavigation> {
  const list = await remotePairs(user);
  const workspaces: WorkspaceEntry[] = [{ id: "local", name: os.hostname(), online: true, ...runtimeNavigation(user) }];
  const servers = await Promise.all(list.map(async pair => {
    const entry: WorkspaceEntry = { id: `server:${pair.id}`, name: new URL(pair.server).host,
      kind: "server", online: false, server: pair.server, device: pair.id, pages: [] };
    try {
      const credential = pairs.find(p => p.id === pair.id);
      if (!credential) throw new Error("Connection removed");
      const response = await fetch(`${pair.server}/api/devices/navigation`, {
        headers: { authorization: `Bearer ${credential.token}` }, redirect: "error", signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Reconnect this server" : "Server unavailable");
      const result = await response.json();
      entry.online = true; entry.pages = result.pages; entry.activePage = result.activePage;
      return [entry, ...(result.devices ?? []).filter((d: {id: string}) => d.id !== pair.id).map((d: {id: string; name: string; online: boolean}) => ({
        id: `desktop:${pair.id}:${d.id}`, name: d.name, kind: "desktop" as const, online: d.online,
        server: pair.server, device: d.id, pages: [],
      }))];
    } catch (e) {
      // Older servers can still be connected without the page-navigation endpoint.
      entry.online = controls.get(pair.id)?.readyState === WebSocket.OPEN;
      entry.error = entry.online ? "Page list unavailable · open server dashboard" : e instanceof Error ? e.message : "Server unavailable";
      return [entry];
    }
  }));
  workspaces.push(...servers.flat());
  return { current: "local", workspaces };
}
export async function navigateWorkspace(user: number, runtime: string, page?: string, screen?: string) {
  await remotePairs(user);
  const path = workspacePath(page, screen);
  if (runtime === "local") return nativeDesktop("local", { path });
  if (screen) throw new DevError("Open connections on this desktop.");
  const [kind, pair, device, extra] = runtime.split(":");
  if (!pair || extra || !pairs.some(p => p.id === pair) || !["server", "desktop"].includes(kind ?? "") ||
    (kind === "desktop" ? !/^[\w-]{36}$/.test(device ?? "") : device !== undefined)) throw new DevError("Unknown workspace.", 404);
  return openServer(user, pair, kind === "desktop" ? `/runtime/${device}${path}` : path);
}
