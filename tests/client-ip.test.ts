import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../src/lib/net-guard.ts';

const req = (headers: Record<string, string>) => new Request('https://frostdev.io/api/login', { headers });

test('a loopback peer is the local proxy: X-Real-IP, and only X-Real-IP, is trusted', () => {
  assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.2' }), '127.0.0.1'), '198.51.100.2');
  assert.equal(clientIp(req({ 'x-real-ip': '2001:db8::1' }), '::1'), '2001:db8:0:0:0:0:0:1');
  // nginx overwrites X-Real-IP; these two are whatever the client typed.
  assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' }), '127.0.0.1'), '127.0.0.1');
  // a client header can never outrank the proxy's own
  assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '198.51.100.2' }), '127.0.0.1'), '198.51.100.2');
});

test('an IPv4-mapped IPv6 loopback peer is still loopback', () => {
  assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.2' }), '::ffff:127.0.0.1'), '198.51.100.2');
});

test('an X-Real-IP that is not an address falls through to the peer', () => {
  assert.equal(clientIp(req({ 'x-real-ip': 'not-an-ip' }), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientIp(req({ 'x-real-ip': '' }), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.2, 203.0.113.7' }), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientIp(req({}), '127.0.0.1'), '127.0.0.1');
});

test('a direct client never chooses its own bucket', () => {
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), '198.51.100.9'), '198.51.100.9');
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), '2001:db8::99'), '2001:db8:0:0:0:0:0:99');
  // NAT64 and ::a.b.c.d route, so they are not this machine — canonicalAddress folds them to the v4 peer.
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), '::ffff:198.51.100.9'), '198.51.100.9');
});

test('on the desktop runtime the loopback peer is the browser, not a proxy', () => {
  const { RIMEWARD_DESKTOP, RIMEWARD_NATIVE_TOKEN } = process.env; // isDesktop() reads both, per dev/runtime.ts
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN = 'test-token';
  try {
    assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), '127.0.0.1'), '127.0.0.1');
    assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), '::ffff:127.0.0.1'), '127.0.0.1');
  } finally {
    if (RIMEWARD_DESKTOP === undefined) delete process.env.RIMEWARD_DESKTOP;
    else process.env.RIMEWARD_DESKTOP = RIMEWARD_DESKTOP;
    if (RIMEWARD_NATIVE_TOKEN === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN;
    else process.env.RIMEWARD_NATIVE_TOKEN = RIMEWARD_NATIVE_TOKEN;
  }
});
