import crypto from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { Readable } from "node:stream";
import type WebSocket from "ws";
import { WebSocketServer, createWebSocketStream } from "ws";
import { getDb } from "../db.ts";
import { DevError, isDesktop } from "./runtime.ts";
import { revokeRemoteSessions } from './remote-desktop-events.ts';
import type { DeviceAccessPolicy } from './remote-desktop-contract.ts';

/** Carried on the authenticated device channel, never accepted from HTTP headers. */
export interface RemoteRelayContext {
  protocol: 1; actor: string; session: string; device: string;
  policy: DeviceAccessPolicy; expires: number;
}

export const PROTOCOL = 1;
const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
interface Device {
  id: string;
  user_id: number;
  name: string;
  platform: string;
  protocol: number;
  token_hash: string;
}
interface Connection {
  ws: WebSocket;
  channels: Set<WebSocket>;
  alive: boolean;
  boot: string;
  remoteDesktop: number;
}
const connections = new Map<string, Connection>();
export function deviceBoot(id: string) { return connections.get(id)?.boot; }
export function notifyDevicePolicy(id: string) {
  connections.get(id)?.ws.send(JSON.stringify({ type: 'remote-policy-changed' }));
}
const waiting = new Map<
  string,
  {
    device: string;
    resolve: (ws: WebSocket) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export function listDevices(user: number) {
  return (
    getDb()
      .prepare("SELECT id,name,platform,protocol FROM devices WHERE user_id=?")
      .all(user) as Device[]
  ).map((d) => ({ ...d, online: connections.has(d.id), remoteDesktop: connections.get(d.id)?.remoteDesktop ?? null }));
}
export function enroll(user: number) {
  const code = crypto.randomBytes(32).toString("base64url");
  const expires = Date.now() + 600_000;
  getDb()
    .prepare("DELETE FROM device_enrollments WHERE expires_at<?")
    .run(Date.now());
  getDb()
    .prepare("INSERT INTO device_enrollments VALUES(?,?,?)")
    .run(digest(code), user, expires);
  return { code, expires, protocol: PROTOCOL };
}
export function enrollment(code: string) {
  if (typeof code !== "string" || code.length > 200)
    throw new DevError("Invalid enrollment.", 403);
  const row = getDb()
    .prepare(
      "SELECT e.user_id,u.email FROM device_enrollments e JOIN users u ON u.id=e.user_id WHERE code_hash=? AND expires_at>?",
    )
    .get(digest(code), Date.now()) as
    | { user_id: number; email: string }
    | undefined;
  if (!row) throw new DevError("Enrollment expired or invalid.", 403);
  return row;
}
export function claimEnrollment(
  code: string,
  name: string,
  platform: string,
  protocol: number,
) {
  if (protocol !== PROTOCOL)
    throw new DevError("Incompatible desktop protocol.", 409);
  return getDb().transaction(() => {
    const { user_id } = enrollment(code);
    getDb()
      .prepare("DELETE FROM device_enrollments WHERE code_hash=?")
      .run(digest(code));
    const id = crypto.randomUUID(),
      token = crypto.randomBytes(32).toString("base64url");
    getDb()
      .prepare(
        "INSERT INTO devices(id,user_id,name,platform,protocol,token_hash) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        user_id,
        String(name).slice(0, 80) || "Desktop",
        String(platform).slice(0, 30),
        protocol,
        digest(token),
      );
    return { id, token, protocol };
  })();
}
export function revoke(user: number, id: string) {
  if (!getDb().prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(id, user)) throw new DevError('Desktop not found.', 404);
  connections.get(id)?.ws.send(JSON.stringify({ type: 'remote-revoked' }));
  revokeRemoteSessions({ device: id, user });
  getDb().prepare('DELETE FROM sessions WHERE id IN (SELECT s.session_id FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE d.id=? AND d.user_id=?)').run(id,user);
  const result = getDb()
    .prepare("DELETE FROM devices WHERE id=? AND user_id=?")
    .run(id, user);
  if (!result.changes) throw new DevError("Desktop not found.", 404);
  disconnect(id);
}
function disconnect(id: string) {
  const c = connections.get(id);
  if (!c) return;
  connections.delete(id);
  c.ws.close(4001, "Disconnected");
  for (const ws of c.channels) ws.terminate();
  for (const [key, p] of waiting)
    if (p.device === id) {
      clearTimeout(p.timer);
      waiting.delete(key);
      p.reject(new DevError("Desktop offline.", 503));
    }
}
export function relaySocket(ws: WebSocket): net.Socket {
  const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
  // Node HTTP only needs the socket's stream and these transport hints.
  return Object.assign(stream, {
    setNoDelay() {
      return this;
    },
    setKeepAlive() {
      return this;
    },
    setTimeout() {
      return this;
    },
    ref() {
      return this;
    },
    unref() {
      return this;
    },
    destroySoon() {
      stream.end();
    },
  }) as unknown as net.Socket;
}
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: false,
});
export function deviceUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
) {
  if (req.headers.origin) {
    socket.destroy();
    return;
  }
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token || token.length > 200) {
    socket.destroy();
    return;
  }
  const device = getDb()
    .prepare("SELECT * FROM devices WHERE token_hash=?")
    .get(digest(token)) as Device | undefined;
  if (!device || device.protocol !== PROTOCOL) {
    socket.destroy();
    return;
  }
  const challenge = req.headers["x-rimeward-request"];
  if (challenge !== undefined) {
    const pending =
      typeof challenge === "string" ? waiting.get(challenge) : undefined;
    const connection = connections.get(device.id);
    if (!pending || pending.device !== device.id || !connection) {
      socket.destroy();
      return;
    }
    waiting.delete(challenge as string);
    clearTimeout(pending.timer);
    wss.handleUpgrade(req, socket, head, (ws) => {
      connection.channels.add(ws);
      ws.on("error", () => {});
      ws.on("close", () => connection.channels.delete(ws));
      pending.resolve(ws);
    });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    disconnect(device.id);
    const boot = req.headers['x-rimeward-boot'];
    const connection: Connection = { ws, channels: new Set(), alive: true,
      remoteDesktop: req.headers['x-rimeward-remote-desktop'] === '1' ? 1 : 0,
      boot: typeof boot === 'string' && /^[a-f0-9-]{36}$/.test(boot) ? boot : '' };
    connections.set(device.id, connection);
    ws.on("error", () => {});
    ws.on("pong", () => {
      connection.alive = true;
    });
    ws.on("close", () => {
      if (connections.get(device.id) === connection) disconnect(device.id);
    });
    ws.send(JSON.stringify({ type: "ready", protocol: PROTOCOL }));
  });
}
export function ensureDevices() {
  const g = globalThis as {
    __fdDeviceUpgrade?: typeof deviceUpgrade;
    __fdDeviceHeartbeat?: ReturnType<typeof setInterval>;
  };
  g.__fdDeviceUpgrade = deviceUpgrade;
  g.__fdDeviceHeartbeat ??= setInterval(() => {
    for (const [id, c] of connections) {
      if (!c.alive) {
        disconnect(id);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000).unref();
}
export const forwardHeaders = [
  "content-type",
  "accept",
  "range",
  "if-range",
  "content-length",
];
export function allowedRelayPath(value: string, remote = false, agent = false) {
  if (value.length > 8192 || !value.startsWith("/") || value.startsWith("//"))
    return false;
  let pathname = value.split("?")[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (
    /[\r\n\\%]/.test(pathname) ||
    pathname.startsWith("//") ||
    pathname.split("/").some((p) => p === "." || p === "..")
  )
    return false;
  if (pathname.startsWith('/api/remote-desktop/')) return remote && pathname === '/api/remote-desktop/host';
  if (pathname === '/api/dev/agent-tools') return agent;
  if (/^\/api\/dev\/(?:control-settings|pair(?:-preview|ings)?|unpair|sign-in[^/]*|open-server|onboard|folder|navigation|navigate)(?:\/|$)/.test(pathname)||pathname.startsWith('/desktop/'))
    return false;
  return !/^\/(?:runtime(?:\/|$)|api\/(?:native|devices)(?:\/|$))/.test(
    pathname,
  );
}

export async function relayRequest(
  user: number,
  device: string,
  path: string,
  request: Request,
  remote?: RemoteRelayContext,
  agentCaller?: string,
): Promise<Response> {
  if (isDesktop())
    throw new DevError("Select a remote server to connect to another desktop.");
  if (
    !getDb()
      .prepare("SELECT 1 FROM devices WHERE user_id=? AND id=?")
      .get(user, device)
  )
    throw new DevError("Desktop not found.", 404);
  if (!allowedRelayPath(path, !!remote, !!agentCaller) || (remote && remote.device !== device) ||
      (agentCaller !== undefined && !/^[a-f0-9]{64}$/.test(agentCaller)))
    throw new DevError("Invalid workspace route.", 403);
  const connection = connections.get(device);
  if (!connection)
    throw new DevError(
      "This desktop is offline. Your server dashboard remains available.",
      503,
    );
  if (waiting.size > 256 || connection.channels.size > 64)
    throw new DevError("Too many active workspace requests.", 429);
  const challenge = crypto.randomUUID();
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(challenge);
      reject(new DevError("Desktop did not respond.", 504));
    }, 10_000);
    waiting.set(challenge, { device, resolve, reject, timer });
    connection.ws.send(
      JSON.stringify({
        type: "request",
        id: challenge,
        base: `/runtime/${device}`,
        ...(remote ? { remote } : {}),
        ...(agentCaller ? { agentCaller } : {}),
      }),
    );
  });
  if (request.signal.aborted) {
    ws.terminate();
    throw new DevError("Client disconnected.", 499);
  }
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const key of forwardHeaders) {
      const value = request.headers.get(key);
      if (value) headers[key] = value;
    }
    const req = http.request(
      {
        host: "desktop",
        path,
        method: request.method,
        headers,
        createConnection: () => relaySocket(ws),
      },
      (res) => {
        const out = new Headers({
          "cache-control": "no-store, no-transform",
          pragma: "no-cache",
          "x-accel-buffering": "no",
          "referrer-policy": "no-referrer",
          "x-rimeward-private": "1",
        });
        for (const key of [
          "content-type",
          "content-encoding",
          "content-range",
          "accept-ranges",
          "content-disposition",
          "x-rimeward-frame",
          "x-rimeward-topology",
        ]) {
          const value = res.headers[key];
          if (typeof value === "string") out.set(key, value);
        }
        const location = res.headers.location;
        if (location) {
          if (location.startsWith("/") && !location.startsWith("//"))
            out.set("location", `/runtime/${device}${location}`);
          else out.set("location", location);
        }
        resolve(
          new Response(
            request.method === "HEAD" ||
            [204, 304].includes(res.statusCode ?? 200)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status: res.statusCode ?? 502, headers: out },
          ),
        );
      },
    );
    req.on("error", () => {
      ws.terminate();
      reject(
        new DevError(
          "Desktop disconnected. The last operation may have completed; inspect its state before trying again.",
          502,
        ),
      );
    });
    const abort = () => { req.destroy(); ws.terminate(); };
    request.signal.addEventListener("abort", abort, { once: true });
    ws.once('close', () => request.signal.removeEventListener('abort', abort));
    if (request.signal.aborted) abort();
    ws.on("error", () => req.destroy());
    if (request.body)
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>)
        .on("error", () => req.destroy())
        .pipe(req);
    else req.end();
  });
}
