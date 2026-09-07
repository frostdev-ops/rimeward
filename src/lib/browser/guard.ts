import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { RefusedError, publicAddress } from '../net-guard.ts';

// Every local chromium egresses through a loopback forward proxy from here.
// Chromium hands a proxy HOSTNAMES, never addresses, so each one is vetted and
// resolved exactly once — vettedFetch's rule, same helper — and the socket goes
// wherever the listener's Dial says: the vetted address itself (the shared
// proxy), or a stream the desktop app dials at home (a `route: 'home'` ward
// gets its own listener over tunnel.ts). Chromium bypasses proxies for
// loopback unless told otherwise, which is why session.ts launches with
// bypass '<-loopback>': 127/8, localhost and link-local reach this proxy and
// are refused like everything else private.

/** How a listener reaches `host:port`. Every dial vets the host first. */
export type Dial = (host: string, port: number) => Promise<Duplex>;

/** Resolve once, connect to THAT address. */
export const direct: Dial = async (host, port) => {
  const ip = await publicAddress(host);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, ip, () => { s.setTimeout(0); resolve(s); });
    s.setTimeout(10000, () => s.destroy(new Error('Upstream connection timed out')));
    s.once('error', reject);
  });
};

let ready: Promise<number> | undefined;

/** The shared direct proxy; starts once, resolves to its loopback port. */
export function guardPort(): Promise<number> {
  return (ready ??= guardFor(direct).then((g) => g.port));
}

/** A private listener whose sockets go through `dial` — one per session that
 *  routes somewhere else. Close it with the session. */
export function guardFor(dial: Dial): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const s = http
      .createServer((req, res) => void forward(dial, req, res))
      .on('connect', (req, sock, head) => void tunnel(dial, req, sock as net.Socket, head));
    s.once('error', reject).listen(0, '127.0.0.1', () =>
      resolve({
        port: (s.address() as net.AddressInfo).port,
        close: () => {
          s.closeAllConnections();
          s.close();
        },
      })
    );
    s.unref();
  });
}

/** A vet refusal is the caller's fault (403); anything else is the far end's (502). */
const status = (e: Error) => (e instanceof RefusedError ? 403 : 502);

/** GET http://host/path — forwarded over the dialed socket, Host header intact. */
async function forward(dial: Dial, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '');
    if (url.protocol !== 'http:') throw new Error('not http');
  } catch {
    res.writeHead(400).end();
    return;
  }
  const up = await dial(url.hostname, Number(url.port) || 80).catch((e: Error) => e);
  if (up instanceof Error) {
    if (res.destroyed) return;
    res.writeHead(status(up), { 'content-type': 'text/plain' }).end(up.message);
    return;
  }
  if (res.destroyed) { up.destroy(); return; }
  const out = http.request(
    { createConnection: () => up as net.Socket, method: req.method, path: url.pathname + url.search, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    }
  );
  out.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => { out.destroy(); up.destroy(); });
  req.on('error', () => out.destroy());
  req.pipe(out);
}

/** CONNECT host:port — TLS and every websocket tunnel through here opaque. */
async function tunnel(dial: Dial, req: http.IncomingMessage, sock: net.Socket, head: Buffer): Promise<void> {
  sock.on('error', () => {});
  const target = req.url ?? '';
  const i = target.lastIndexOf(':');
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  if (!host || !(port >= 1 && port <= 65535)) {
    sock.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  const up = await dial(host, port).catch((e: Error) => e);
  if (up instanceof Error) {
    const code = status(up);
    sock.end(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Bad Gateway'}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(up.message)}\r\n\r\n${up.message}`);
    return;
  }
  if (sock.destroyed) {
    up.destroy();
    return;
  }
  sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length) up.write(head);
  up.pipe(sock).pipe(up);
  const drop = () => {
    up.destroy();
    sock.destroy();
  };
  up.on('error', drop).on('close', drop);
  sock.on('close', drop);
}
