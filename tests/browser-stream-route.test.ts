import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { APIContext } from 'astro';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { closeSession, peek } from '../src/lib/browser/session.ts';
import { GET } from '../src/pages/api/browser/stream/[ward].ts';

// The SSE route as a desktop answering the server's relay: the first bytes are the
// viewport and the tab strip, then the stream's `rtc` for this viewer (ICE, then an offer).

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

/** Read the stream until `until` matches or `ms` pass; the events seen, in order. */
async function readEvents(res: Response, until: RegExp, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let got = '';
  const deadline = Date.now() + ms;
  try {
    while (!until.test(got) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), Math.max(1, deadline - Date.now())))]);
      if (next.done) break;
      got += dec.decode(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return got.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, '"data":"<jpeg>"');
}

test('the stream route on a desktop answering the relay: view and tabs at once, then the stream offer', async (t) => {
  const env = { desktop: process.env.RIMEWARD_DESKTOP, token: process.env.RIMEWARD_NATIVE_TOKEN, direct: process.env.RIMEWARD_RTC_DIRECT };
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'route-fixture'; process.env.RIMEWARD_RTC_DIRECT = '1';
  const uid = seedUser('stream-route@test');
  saveDashboard(uid, [{ i: 'bw', type: 'browser', size: '3x2', config: { backend: 'app' } }]);
  const request = new Request('https://x.invalid/api/browser/stream/bw?share=abcdefghijkl', { headers: {
    'x-rimeward-relayed': '1', 'x-rimeward-native-token': 'route-fixture', 'x-rimeward-rtc': JSON.stringify({ host: [], viewer: [] }) } });
  const ctx = { params: { ward: 'bw' }, locals: { user: { userId: uid } }, request, url: new URL(request.url) } as unknown as APIContext;
  try {
    const res = await GET(ctx);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const got = await readEvents(res, /event: rtc\ndata: [^\n]*"sdp"/, 20_000);
    if (/event: route/.test(got) && !existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) { t.skip('no chromium here'); return; }
    const events = [...got.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.equal(events[0], 'view', `the first event is the viewport, got: ${events.join(',')}\n${got.slice(0, 400)}`);
    assert.ok(events.includes('tabs'));
    assert.match(got, /event: rtc\ndata: \{"type":"rtc","conn":"[0-9a-f]{32}","ice":\[\]\}/, 'the viewer\'s ICE');
    assert.match(got, /"sdp":"v=0/, 'the capture page\'s offer');
  } finally {
    const s = peek(uid, 'bw');
    if (s) await closeSession(s);
    if (env.desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = env.desktop;
    if (env.token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = env.token;
    if (env.direct === undefined) delete process.env.RIMEWARD_RTC_DIRECT; else process.env.RIMEWARD_RTC_DIRECT = env.direct;
  }
});
