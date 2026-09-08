// Generated pixels and a protocol fixture. Never captures or inputs into this Mac.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { remoteDownloadSmoke, remoteFolderDownloadSmoke } from './remote-download-smoke.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-remote-ui-'));
const screenshots = process.env.RIMEWARD_GOLDEN_DIR ?? temporary;
const device = '11111111-1111-4111-8111-111111111111', session = '22222222-2222-4222-8222-222222222222';
const calls = [], errors = [];
let browser, controller = null, frame = 0, inflight = 0, peak = 0, hostState = 'available', approval = false;
const display = { display: 1, name: 'Studio display', x: -1920, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 };
const features = { screen: true, input: true, rime: true, clipboard: true, files: false, audio: false };
const fixtureImage = await sharp(Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#14243b"/><rect x="100" y="100" width="1080" height="520" rx="20" fill="#203951"/><text x="160" y="210" fill="#e1f8ff" font-size="38" font-family="sans-serif">Remote Studio</text><text x="160" y="275" fill="#95b6ce" font-size="22" font-family="sans-serif">Dedicated test window · generated screen content</text><rect x="160" y="335" width="420" height="170" rx="12" fill="#315e79"/><text x="195" y="425" fill="#c8f4ff" font-size="26" font-family="sans-serif">Your paired computer</text></svg>')).jpeg().toBuffer();
const child = spawn(process.execPath, ['desktop-runtime.mjs'], { env: { PATH: process.env.PATH, HOME: temporary }, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Runtime startup timeout: ' + logs.slice(-1000))), 25000);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      const m = JSON.parse(line);
      if (m.type === 'ready') { clearTimeout(timer); resolve(m.url); }
      if (m.type === 'vault') child.stdin.write(JSON.stringify({ id: m.id, value: '[]' }) + '\n');
      if (m.type === 'desktop') child.stdin.write(JSON.stringify({ id: m.id, value: { enabled: false, generation: 0, pending: [] } }) + '\n');
    } catch {}
  });
  child.once('exit', code => { clearTimeout(timer); reject(Error('Runtime exited: ' + code)); });
});
child.stdin.write(JSON.stringify({ key: Buffer.alloc(32, 8).toString('base64'), data: path.join(temporary, 'state'), browsers: path.resolve('desktop/runtime/browsers') }) + '\n');
try {
  const url = await ready;
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/remote-desktop/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? {} : request.postDataJSON();
    if (path.endsWith('/devices')) return route.fulfill({ json: [{ id: device, name: 'Studio Mac', platform: 'macOS', online: true }] });
    if (path.endsWith('/capabilities')) return route.fulfill(hostState === 'offline' ? { status: 503, json: { error: 'This computer is offline. Open Rimeward on Studio Mac to reconnect.' } } : { json: { protocol: 1, features: { ...features, screen: hostState === 'available' }, state: hostState } });
    if (path.endsWith('/sessions')) { controller = null; frame = 0; return route.fulfill({ json: { id: session, features, display: 1, displays: [display], controller, topology: 1, state: approval ? 'pending-approval' : 'connected', transport: 'compatibility' } }); }
    if (path.endsWith('/policy')) return route.fulfill({ json: { revision: 0, connection: 'account', persistence: 'remember', ...features } });
    calls.push(body);
    if (body.action === 'status') return route.fulfill({ json: { state: approval ? 'pending-approval' : 'connected', controller, topology: 1 } });
    if (body.action === 'acquire') { controller = { id: session, kind: 'human', generation: 1 }; return route.fulfill({ json: { ownership: 1, topology: 1 } }); }
    if (body.action === 'release' || body.action === 'disconnect') controller = null;
    if (body.action === 'frame') {
      inflight++; peak = Math.max(peak, inflight);
      assert.equal(body.ack, frame, 'every received frame must be acknowledged');
      await new Promise(resolve => setTimeout(resolve, 80));
      frame++; inflight--;
      return route.fulfill({ contentType: 'image/jpeg', headers: { 'x-rimeward-frame': String(frame), 'x-rimeward-topology': '1' }, body: fixtureImage });
    }
    return route.fulfill({ json: { sent: true } });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue without connecting' }).click();
  await page.waitForURL('**/dash');
  await page.evaluate(async device => {
    const response = await fetch('/api/dashboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      layout: [{ i: 'remote-test', type: 'remote-desktop', title: 'Studio Mac', size: '6x5', device, config: { diagnostics: true } }], pages: [],
    }) });
    if (!response.ok) throw Error(await response.text());
  }, device);
  await page.reload();
  const ward = page.locator('[data-wd="remote-test"]');
  await ward.getByRole('button', { name: 'Connect', exact: true }).waitFor();
  assert.equal(calls.some(c => c.action === 'acquire'), false);
  await ward.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-disconnected.png'), animations: 'disabled' });
  await ward.getByRole('button', { name: 'Connect', exact: true }).click();
  await ward.locator('.rd-pill').filter({ hasText: /Compatibility.*View-only/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('.rd-screen')?.width === 1280);
  assert.equal(calls.some(c => c.action === 'acquire'), false, 'viewing never acquires input');
  // The card header mirrors the pill so the state shows when the toolbar is hidden.
  assert.match(await ward.locator('.wd-status').textContent(), /Compatibility.*View-only/);
  await ward.getByRole('button', { name: 'Fullscreen', exact: true }).waitFor();
  await ward.locator('.rd-stats').filter({ hasText: /HTTPS relay/ }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-desktop.png'), animations: 'disabled' });
  await ward.getByRole('button', { name: 'Take control', exact: true }).click();
  await ward.getByRole('button', { name: 'Release control', exact: true }).waitFor();
  await ward.locator('.rd-pill').filter({ hasText: /You control/ }).waitFor();
  await ward.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-control.png') });
  await ward.locator('canvas').click({ position: { x: 100, y: 100 } });
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  assert.ok(calls.some(c => c.action === 'input' && c.events.some(e => e.type === 'key' && e.key === 'ArrowRight')));
  await page.keyboard.type('hi');
  await page.waitForTimeout(150);
  assert.equal(calls.filter(c => c.action === 'input').flatMap(c => c.events).filter(e => e.type === 'text').map(e => e.text).join(''), 'hi', 'printable keys arrive as text');
  await ward.getByRole('button', { name: 'Keys', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ctrl+Alt+Del', exact: true }).click();
  await page.waitForTimeout(150);
  const sequence = calls.find(c => c.action === 'input' && c.events.some(e => e.key === 'Delete'));
  assert.deepEqual(sequence.events.map(e => `${e.key}:${e.down ? 'down' : 'up'}`),
    ['Control:down', 'Alt:down', 'Delete:down', 'Delete:up', 'Alt:up', 'Control:up'], 'a key sequence presses down in order and releases in reverse');
  await ward.getByRole('button', { name: 'Stats', exact: true }).click();
  assert.equal(await ward.locator('.rd-stats').isVisible(), false);
  await ward.getByRole('button', { name: 'Stats', exact: true }).click();
  await ward.getByRole('button', { name: 'Expand', exact: true }).click();
  const dialog = page.locator('.rd-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('canvas').count(), 1);
  assert.equal(await ward.locator('canvas').count(), 0, 'expand moves the same element');
  await page.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-expanded.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await ward.locator('canvas').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => { const bar = document.querySelector('.rd-bar'); return bar.scrollWidth <= bar.clientWidth + 1; }), true, 'the toolbar folds into the More menu instead of overflowing');
  await page.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-phone.png'), animations: 'disabled' });
  await ward.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.ok(calls.some(c => c.action === 'disconnect'));
  assert.equal(peak, 1, 'only one frame can be in flight');
  await page.setViewportSize({ width: 1440, height: 1000 });
  approval = true;
  await ward.getByRole('button', { name: 'Connect', exact: true }).click();
  await ward.getByText('Approve this connection on the host Connections page.').waitFor();
  assert.equal(await ward.getByRole('button', { name: 'Take control', exact: true }).isDisabled(), true);
  await ward.screenshot({ path: path.join(screenshots, 'rimeward-remote-desktop-approval.png') });
  await ward.getByRole('button', { name: 'Disconnect', exact: true }).click();
  approval = false;
  for (const state of ['permission-required', 'offline']) {
    hostState = state;
    await ward.getByRole('button', { name: 'Connect', exact: true }).click();
    await ward.getByText(state === 'offline' ? /This computer is offline/ : /Screen access unavailable/).waitFor();
    await ward.screenshot({ path: path.join(screenshots, `rimeward-remote-desktop-${state}.png`) });
  }
  await remoteDownloadSmoke(page);
  await remoteFolderDownloadSmoke(page);
  assert.deepEqual(errors, []);
  console.log('remote desktop UI smoke passed: view-only, acknowledged frames, control, text + key input, key sequences, stats, expansion, phone layout, disconnect');
} finally {
  await browser?.close();
  const exit = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 10000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
