// What a fresh install needs to reach the login page: the runtime CSRF check,
// migrations found from wherever the server starts, a tunnel HELLO that
// survives a missing browsers.json, and a weather ward with no town of its own.
import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { allowedOrigin, csrfBlocked } from '../src/lib/csrf.ts';
import { migrationsDir } from '../src/lib/db.ts';
import { chromiumSpec } from '../src/lib/tunnel.ts';
import { coords } from '../src/lib/weather.ts';
import { config, saveConfig } from '../src/lib/app-config.ts';
import { getSetting } from '../src/lib/settings.ts';

test('allowedOrigin: the base URL origin and loopback, nothing else', () => {
  assert.ok(allowedOrigin('https://example.com', 'https://example.com'));
  assert.ok(allowedOrigin('http://localhost:4321', 'https://example.com'));
  assert.ok(allowedOrigin('http://127.0.0.1:3005', ''));
  assert.equal(allowedOrigin('https://evil.example', 'https://example.com'), false);
  assert.equal(allowedOrigin('http://example.com', 'https://example.com'), false); // scheme counts
  assert.equal(allowedOrigin('https://example.com', ''), false); // no base URL, no trust
  assert.equal(allowedOrigin('null', 'https://example.com'), false);
});

test('csrfBlocked: form posts from elsewhere, nothing without an Origin, never JSON', () => {
  process.env.PUBLIC_BASE_URL = 'https://example.com';
  const req = (method: string, headers: Record<string, string>) =>
    new Request('https://example.com/api/login', { method, headers });
  assert.ok(csrfBlocked(req('POST', { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' })));
  assert.equal(csrfBlocked(req('POST', { origin: 'https://example.com', 'content-type': 'multipart/form-data; boundary=x' })), false);
  assert.equal(csrfBlocked(req('POST', { 'content-type': 'application/x-www-form-urlencoded' })), false);
  assert.equal(csrfBlocked(req('POST', { origin: 'https://evil.example', 'content-type': 'application/json' })), false);
  assert.equal(csrfBlocked(req('GET', { origin: 'https://evil.example' })), false);
});

test('migrationsDir finds the repo folder from src/lib and from a nested build dir', () => {
  const root = path.resolve(import.meta.dirname, '..');
  assert.equal(migrationsDir(), path.join(root, 'migrations'));
  assert.equal(migrationsDir(path.join(root, 'dist/server/chunks')), path.join(root, 'migrations'));
});

test('chromiumSpec names the pinned Chrome for Testing build', () => {
  const spec = chromiumSpec();
  assert.ok(spec && /^\d+\./.test(spec.version), JSON.stringify(spec));
});

test('weather has no built-in town: env or settings, else null', () => {
  delete process.env.WEATHER_LAT;
  delete process.env.WEATHER_LON;
  assert.equal(coords(), null);
  process.env.WEATHER_LAT = '';
  process.env.WEATHER_LON = ' '; // the .env.example lines left blank are unset, not 0°,0°
  assert.equal(coords(), null);
  process.env.WEATHER_LAT = '40.7';
  process.env.WEATHER_LON = 'east'; // half a location is no location
  assert.equal(coords(), null);
  process.env.WEATHER_LON = '-74';
  assert.deepEqual(coords(), { lat: 40.7, lon: -74 });
});

test('sessionId reads the new cookie name, then the legacy one', async () => {
  const { LEGACY_SESSION_COOKIE, SESSION_COOKIE, sessionId } = await import('../src/lib/auth.ts');
  const jar = (m: Record<string, string>) => ({ get: (n: string) => (n in m ? { value: m[n]! } : undefined) });
  assert.equal(sessionId(jar({ [SESSION_COOKIE]: 'new', [LEGACY_SESSION_COOKIE]: 'old' })), 'new');
  assert.equal(sessionId(jar({ [LEGACY_SESSION_COOKIE]: 'old' })), 'old');
  assert.equal(sessionId(jar({})), undefined);
});

// Blank stores "": publicOrigin() is then "" and allowedOrigin() refuses every non-loopback
// form post, including the one that would put the URL back.
test('a blank public URL is refused; a reset to the environment is not', () => {
  saveConfig('PUBLIC_BASE_URL', 'https://example.com', null);
  assert.throws(() => saveConfig('PUBLIC_BASE_URL', '', null), /required/);
  assert.throws(() => saveConfig('PUBLIC_BASE_URL', '   ', null), /required/);
  assert.equal(config('PUBLIC_BASE_URL'), 'https://example.com');
  saveConfig('PUBLIC_BASE_URL', null, null);
  assert.equal(getSetting('config:PUBLIC_BASE_URL'), null);
});
