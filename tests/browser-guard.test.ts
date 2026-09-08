import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { guardPort, guardFor } from '../src/lib/browser/guard.ts';

const connect = (port: number, target: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, method: 'CONNECT', path: target })
      .on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode!); })
      .on('response', (res) => resolve(res.statusCode!))
      .on('error', reject)
      .end();
  });

const get = (port: number, url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      })
      .on('error', reject);
  });

test('guard refuses every private target, tunnel and plain alike', async () => {
  const port = await guardPort();
  for (const target of [
    '127.0.0.1:3000',
    'localhost:5050',
    '[::1]:443',
    '10.0.0.1:443',
    '172.16.0.1:443',
    '192.168.1.1:8080',
    '169.254.169.254:80',
    '100.64.0.1:443',
    '0.0.0.0:80',
  ]) {
    assert.equal(await connect(port, target), 403, target);
  }
  const plain = await get(port, 'http://127.0.0.1:3000/api/status');
  assert.equal(plain.status, 403);
  assert.match(plain.body, /private address/);
  assert.equal((await get(port, 'http://localhost:5050/')).status, 403);
});

test('guard rejects malformed targets outright', async () => {
  const port = await guardPort();
  assert.equal(await connect(port, 'nonsense'), 400);
  assert.equal(await connect(port, 'example.com:99999'), 400);
  assert.equal((await get(port, '/relative')).status, 400);
  assert.equal((await get(port, 'ftp://example.com/')).status, 400);
});

test('CONNECT status checks close the upgraded socket even when the response body arrives later', async () => {
  let closed: Promise<unknown> | undefined;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    socket.once('data', () => {
      socket.write('HTTP/1.1 403 Forbidden\r\ncontent-length: 12\r\n\r\n');
      const timer = setTimeout(() => socket.end('private host'), 20);
      socket.once('close', () => clearTimeout(timer));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    assert.equal(await connect((server.address() as net.AddressInfo).port, '127.0.0.1:1'), 403);
    assert.ok(closed);
    await closed;
  } finally { for (const socket of sockets) socket.destroy(); server.close(); }
});

test('closing a browser request closes its unfinished upstream connection', async () => {
  const upstream = http.createServer(); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = (upstream.address() as net.AddressInfo).port;
  const guard = await guardFor(() => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket)); socket.once('error', reject);
  }));
  const received = once(upstream, 'request');
  const request = http.get({ host: '127.0.0.1', port: guard.port, path: 'http://fixture.test/slow' });
  request.on('error', () => {});
  try {
    const [, response] = await received;
    const closed = once(response, 'close', { signal: AbortSignal.timeout(2000) });
    request.destroy(); await closed;
  } finally { request.destroy(); guard.close(); upstream.closeAllConnections(); upstream.close(); }
});

test('a browser CONNECT client sending FIN closes its upstream without waiting for the peer', async () => {
  const peers = new Set<net.Socket>();
  const upstream = net.createServer({ allowHalfOpen: true }, socket => { peers.add(socket); socket.resume(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let outbound: net.Socket | undefined;
  const guard = await guardFor(() => new Promise((resolve, reject) => {
    outbound = net.connect((upstream.address() as net.AddressInfo).port, '127.0.0.1', () => resolve(outbound!));
    outbound.once('error', reject);
  }));
  const client = net.connect(guard.port, '127.0.0.1');
  try {
    await once(client, 'connect');
    const response = once(client, 'data');
    client.write('CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test\r\n\r\n');
    assert.match(String((await response)[0]), /200 Connection Established/);
    const closed = once(outbound!, 'close', { signal: AbortSignal.timeout(2000) });
    client.end();
    await closed;
    assert.equal(outbound!.destroyed, true);
  } finally {
    client.destroy(); outbound?.destroy();
    for (const peer of peers) peer.destroy();
    guard.close(); upstream.close();
  }
});
