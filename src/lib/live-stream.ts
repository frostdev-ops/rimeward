import http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { SESSION_COOKIES, getSession } from './auth.ts';

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
// Only existing, authenticated SSE GETs. The original middleware still decides device and ward access.
const route = /^(?:\/runtime\/[a-zA-Z0-9_-]+)?\/api\/(?:status\/stream|logic\/stream|instance\/events|dev\/events|browser\/stream\/[a-zA-Z0-9_-]+)$/;
export function liveUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const refuse = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  let origin: URL;
  try { origin = new URL(req.headers.origin ?? ''); } catch { refuse(403); return; }
  const expected = process.env.PUBLIC_BASE_URL;
  if (expected ? origin.origin !== new URL(expected).origin : origin.host !== req.headers.host) { refuse(403); return; }
  const cookies = new Map((req.headers.cookie ?? '').split(';').map(s => { const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1)]; }));
  const session = SESSION_COOKIES.map(name => cookies.get(name)).find(Boolean);
  if (!getSession(session)) { refuse(401); return; }
  const port = req.socket.localPort;
  if (!port) { refuse(503); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const streams = new Map<number, http.ClientRequest>();
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(1013, 'Slow receiver'); return; }
      ws.send(JSON.stringify(value));
    };
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive || !getSession(session)) { ws.terminate(); return; }
      alive = false; ws.ping();
    }, 25000);
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { clearInterval(heartbeat); for (const stream of streams.values()) stream.destroy(); streams.clear(); });
    ws.on('message', raw => {
      let message: { id: number; path?: string; close?: boolean };
      try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!message || !Number.isSafeInteger(message.id) || message.id < 1) { ws.close(1008, 'Invalid subscription'); return; }
      const { id } = message;
      if (message.close) { streams.get(id)?.destroy(); streams.delete(id); return; }
      if (streams.has(id) || streams.size >= 64 || typeof message.path !== 'string' || message.path.length > 4096) { send({ id, error: 429 }); return; }
      let url: URL;
      try { url = new URL(message.path, 'http://localhost'); } catch { send({ id, error: 400 }); return; }
      if (!message.path.startsWith('/') || url.origin !== 'http://localhost' || !route.test(url.pathname) || url.hash) { send({ id, error: 403 }); return; }
      const upstream = http.get({ hostname: '127.0.0.1', port, path: url.pathname + url.search, agent: false,
        headers: { cookie: req.headers.cookie ?? '', host: req.headers.host ?? origin.host, origin: origin.origin, accept: 'text/event-stream' } });
      streams.set(id, upstream);
      const finish = (error: number) => { if (streams.get(id) !== upstream) return; streams.delete(id); upstream.destroy(); send({ id, error }); };
      // Bounds headers and silent streams; existing SSE routes heartbeat at <=25 seconds.
      upstream.setTimeout(60000, () => finish(504));
      upstream.on('error', () => finish(502));
      upstream.on('response', response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) { finish(response.statusCode ?? 502); return; }
        send({ id, open: true });
        response.setEncoding('utf8');
        response.on('data', (data: string) => send({ id, data }));
        response.on('error', () => finish(502));
        response.on('end', () => finish(502));
        response.on('close', () => finish(502));
      });
    });
  });
}
export function ensureLiveStream(): void {
  (globalThis as typeof globalThis & { __fdLiveUpgrade?: typeof liveUpgrade }).__fdLiveUpgrade = liveUpgrade;
}
