import { liveStreamFixture } from './live-stream-fixture.mjs';
// Generated frames and isolated runtime state; never opens the user's browser profiles.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-browser-ui-'));
const frameBytes = await sharp(Buffer.from('<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="480" fill="#14354b"/><text x="40" y="100" font-size="28" fill="white">Generated browser fixture</text></svg>')).jpeg().toBuffer();
const frame = frameBytes.toString('base64');
// The ward socket's frame: the same page at 2× (a 1280×960 jpeg of a 640×480 viewport).
const hidpiFrame = await sharp(frameBytes).resize(1280, 960).jpeg().toBuffer();
const child = spawn(process.execPath, ['desktop-runtime.mjs'], { env: { PATH: process.env.PATH, HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
let browser, logs = '';
child.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Runtime startup: ' + logs.slice(-1000))), 20000);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    const m = JSON.parse(line);
    if (m.type === 'ready') { clearTimeout(timer); resolve(m.url); }
    if (m.type === 'vault') child.stdin.write(JSON.stringify({ id: m.id, value: '[]' }) + '\n');
    if (m.type === 'desktop') child.stdin.write(JSON.stringify({ id: m.id, value: {} }) + '\n');
  });
  child.once('exit', code => { clearTimeout(timer); reject(Error('Runtime exit: ' + code)); });
});
child.stdin.write(JSON.stringify({ key: Buffer.alloc(32, 9).toString('base64'), data: path.join(temp, 'state'), browsers: process.env.PLAYWRIGHT_BROWSERS_PATH }) + '\n');
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const calls = [], errors = [];
  let delayControl = false, finishControl, blackhole = false, finishBlackhole;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(frame => {
    window.__nativeCalls = []; window.__browserStreams = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => timeout(window.__shortBrowserTimeouts ? Math.min(ms, 200) : ms);
    window.__TAURI__ = { core: { invoke: async (command) => {
      window.__nativeCalls.push(command);
      if (command === 'macos_permissions') return { screen: true, input: true };
      throw Error('This server is not the active browser route');
    } } };
  }, frame);
  // Registered BEFORE the live-stream fixture, whose class captures window.WebSocket.
  // The ward WebSocket (lib/browser/live.ts), faked in-page: browser-one gets
  // the full handshake and records every batch; browser-two is closed before
  // its `hello`, which is how a relayed ward looks, so it falls back to the
  // SSE + POST path the assertions below have always covered.
  const wsBatches = [];
  let wsSockets = 0, wsTwo = 0, dropOne;
  await page.routeWebSocket('**/api/browser/ws/*', ws => {
    const ward = new URL(ws.url()).pathname.split('/').at(-1);
    if (ward !== 'browser-one') { wsTwo++; ws.close(); return; }
    wsSockets++;
    dropOne = () => ws.close({ code: 1000 });
    ws.send(JSON.stringify({ type: 'hello' }));
    ws.onMessage(raw => wsBatches.push({ beforeView: false, cmds: JSON.parse(raw).cmds }));
    // The browser "launches" after a beat — anything sent before `view` would be a protocol error.
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'view', dsf: 2 }));
      ws.send(hidpiFrame);
      ws.send(JSON.stringify({ type: 'nav', url: 'https://browser.fixture/one', title: 'Generated fixture' }));
      ws.send(JSON.stringify({ type: 'tabs', tabs: [{ url: 'https://browser.fixture/one', title: 'One' }, { url: 'https://browser.fixture/two', title: 'Two' }], active: 0 }));
    }, 150);
  });
  await page.addInitScript(liveStreamFixture, { browserFrame: frame });
  await page.route('**/api/browser/*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const call = { ward: new URL(route.request().url()).pathname.split('/').at(-1), cmds: route.request().postDataJSON().cmds };
    calls.push(call);
    if (delayControl && call.cmds.some(c => c.t === 'key' && c.key === 'Control' && c.type === 'down'))
      await new Promise(resolve => { finishControl = resolve; });
    if (blackhole && call.cmds.some(c => c.t === 'key' && c.key === 'q' && c.type === 'down'))
      await new Promise(resolve => { finishBlackhole = resolve; });
    await route.fulfill({ json: { ok: true } }).catch(() => {}); // the timeout fixture deliberately aborts its request
  });
  await page.goto(await ready);
  await page.getByRole('button', { name: 'Continue without connecting' }).click();
  await page.waitForURL('**/dash');
  await page.evaluate(async () => {
    const r = await fetch('/api/dashboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: [
      { i: 'browser-one', type: 'browser', size: '3x3', page: 'browser-check', config: { backend: 'app' } },
      { i: 'browser-two', type: 'browser', size: '3x3', page: 'browser-check', config: { backend: 'app' } },
    ], pages: [{ id: 'browser-check', title: 'Browser check' }, { id: 'other', title: 'Other' }] }) });
    if (!r.ok) throw Error(await r.text());
  });
  await page.reload();
  try {
    await page.waitForFunction(() => {
      const widths = [...document.querySelectorAll('.bw canvas')].map(c => c.width).sort((a, b) => a - b);
      return widths.length === 2 && widths[0] === 640 && widths[1] === 1280;
    });
  } catch (error) {
    console.error('canvases', await page.evaluate(() => [...document.querySelectorAll('.bw canvas')].map(c => [c.closest('[data-wd]')?.dataset.wd, c.width, c.height])),
      'toasts', await page.evaluate(() => [...document.querySelectorAll('.bw-toast')].map(t => t.textContent)), 'sockets', wsSockets, wsTwo, 'batches', wsBatches.length, 'errors', errors);
    throw error;
  }
  assert.equal(await page.locator('#instance-status').getAttribute('data-desktop'), '1');
  assert.equal(await page.evaluate(() => window.__nativeCalls.some(c => c === 'ward_browser')), false, 'local runtime never uses paired-server native browser routing');
  await page.waitForTimeout(400);
  assert.equal(wsSockets, 1, 'the served ward opened one socket');
  assert.ok(wsTwo >= 1, 'the refused ward tried the socket first');
  assert.equal(new Set(calls.filter(c => c.cmds.some(x => x.t === 'resize')).map(c => c.ward)).size, 1, 'only the fallback ward resizes over POST');
  assert.equal(calls.some(c => c.ward === 'browser-one'), false, 'a ward on its socket never POSTs input');
  assert.ok(wsBatches.some(b => b.cmds.some(x => x.t === 'resize')), 'the socket ward resizes over the socket');
  assert.ok(wsBatches.every(b => b.cmds.every(x => x.t === 'resize' && x.dsf === undefined)), 'nothing but the resize went before any input, and the server\'s scale is not the client\'s to set');
  const ward = page.locator('[data-wd="browser-one"]');
  const canvas = ward.locator('canvas');
  await canvas.evaluate(c => { c.dataset.sameElement = 'yes'; });
  // A click lands in remote CSS px: the 2× frame (1280×960 of a 640×480 page)
  // is object-fit inside the canvas box, so its centre is the page's centre.
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForTimeout(100);
  const down = wsBatches.flatMap(b => b.cmds).find(x => x.t === 'down');
  assert.ok(down, 'the click reached the socket');
  assert.ok(Math.abs(down.x - 320) < 2 && Math.abs(down.y - 240) < 2, `click mapped through the 2× frame: ${JSON.stringify(down)}`);
  const beforeShortcut = wsBatches.length;
  await canvas.evaluate(c => {
    // A native shortcut (or focus gained mid-modifier) can carry the modifier
    // flag without the canvas having received its separate keydown.
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, cancelable: true, bubbles: true }));
    c.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', metaKey: false, bubbles: true }));
  });
  await page.waitForTimeout(100);
  assert.deepEqual(wsBatches.slice(beforeShortcut).flatMap(c => c.cmds).filter(c => c.t === 'key').map(c => [c.key, c.type]),
    [['Meta', 'down'], ['a', 'down'], ['Meta', 'up'], ['a', 'up']], 'modifier flags preserve shortcut ordering and release');
  assert.equal(await canvas.evaluate(c => c.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, cancelable: true, bubbles: true }))), true, 'paste shortcut allows the client paste event');
  await canvas.evaluate(c => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'generated paste');
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(100);
  assert.ok(wsBatches.some(c => c.cmds.some(x => x.t === 'text' && x.text === 'generated paste')));
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight');
  await ward.getByRole('textbox', { name: 'Address' }).click();
  await page.waitForTimeout(100);
  assert.ok(wsBatches.some(c => c.cmds.some(x => x.t === 'key' && x.key === 'Shift' && x.type === 'up')), 'blur releases held keys');
  await page.keyboard.up('Shift');
  await ward.getByRole('textbox', { name: 'Address' }).fill('example.com');
  await ward.getByRole('textbox', { name: 'Address' }).press('Enter');
  await page.waitForTimeout(100);
  assert.ok(wsBatches.some(c => c.cmds.some(x => x.t === 'goto' && new URL(x.url).href === 'https://example.com/')));
  assert.equal(calls.some(c => c.ward === 'browser-one'), false, 'still nothing over POST for the socket ward');
  // The server dropping the socket AFTER hello is a retry, never a fallback: the
  // queue and held state reset, the next attempt is a socket again, no POST.
  await canvas.click();
  await page.keyboard.down('Shift');
  await page.waitForTimeout(50);
  const socketsBeforeDrop = wsSockets, postsBeforeDrop = calls.length, batchesBeforeDrop = wsBatches.length;
  dropOne();
  await ward.getByText('Browser unavailable — retrying…').waitFor();
  await page.keyboard.up('Shift');
  await page.keyboard.press('ArrowDown'); // typed while reconnecting: dropped, never delivered late
  await page.waitForTimeout(5800); // 5 s retry + the fixture's launch beat + the resize debounce
  assert.equal(wsSockets, socketsBeforeDrop + 1, 'reconnected over the socket');
  assert.equal(calls.length, postsBeforeDrop, 'no POST while the socket was down');
  assert.equal(wsBatches.slice(batchesBeforeDrop).some(b => b.cmds.some(x => x.t === 'key')), false, 'input typed while the socket was down is dropped, never delivered late');
  assert.ok(wsBatches.slice(batchesBeforeDrop).some(b => b.cmds.some(x => x.t === 'resize')), 'the new socket re-sends the viewport');
  const before = await page.evaluate(() => window.__browserStreams.length);
  await ward.getByRole('button', { name: 'Expand', exact: true }).click();
  const dialog = page.locator('#browser-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('canvas').getAttribute('data-same-element'), 'yes');
  await dialog.locator('[data-bw-close]').click();
  assert.equal(await canvas.getAttribute('data-same-element'), 'yes');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__browserStreams.length), before, 'expand retains the live session');
  assert.equal(wsSockets, socketsBeforeDrop + 1, 'expand keeps the socket too');
  // The rest drives the FALLBACK ward (browser-two: SSE + POST), unchanged.
  const wardTwo = page.locator('[data-wd="browser-two"]');
  const canvasTwo = wardTwo.locator('canvas');
  delayControl = true;
  await canvasTwo.click();
  await page.keyboard.down('Control');
  for (let attempt = 0; !finishControl && attempt < 50; attempt++) await page.waitForTimeout(20);
  assert.ok(finishControl, 'slow input batch is in flight');
  await page.keyboard.up('Control'); // its release is queued, no longer in the physical held set
  const beforeHide = calls.length;
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(calls.slice(beforeHide).some(c => c.cmds.some(x => x.t === 'key' && x.key === 'Control' && x.type === 'up')), false, 'release waits for the ordered in-flight batch');
  finishControl(); delayControl = false;
  await page.waitForTimeout(150);
  assert.ok(calls.slice(beforeHide).some(c => c.cmds.some(x => x.t === 'key' && x.key === 'Control' && x.type === 'up')), 'hidden ward releases a submitted key even when physical key-up was queued');
  assert.equal(await page.evaluate(() => window.__browserStreams.filter(s => s.readyState === 1).length), 0, 'hidden wards close streams');
  const socketsBeforeReturn = wsSockets;
  await page.getByRole('button', { name: 'Browser check', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__browserStreams.filter(s => s.readyState === 1).length), 1, 'returning reconnects the fallback ward once');
  assert.equal(wsSockets, socketsBeforeReturn + 1, 'returning reconnects the socket ward once');
  await page.evaluate(() => window.__browserStreams.findLast(s => s.url.endsWith('browser-two')).fail());
  await wardTwo.getByText('Browser unavailable — retrying…').waitFor();
  await page.waitForTimeout(5300);
  assert.equal(await page.evaluate(() => window.__browserStreams.filter(s => s.readyState === 1).length), 1, 'closed stream recovers');
  await page.setViewportSize({ width: 390, height: 844 });
  await ward.screenshot({ path: path.join(process.env.RIMEWARD_GOLDEN_DIR ?? temp, 'rimeward-browser-local-phone.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(process.env.RIMEWARD_GOLDEN_DIR ?? temp, 'rimeward-browser-local.png') });
  // Removing the SOCKET ward mid-press: its releases go out on the socket before it closes.
  await canvas.click();
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.waitForTimeout(80);
  const beforeRemove = wsBatches.length, postsBeforeRemove = calls.length;
  await page.evaluate(async () => {
    const layout = JSON.parse(document.getElementById('layout-data').textContent);
    const r = await fetch('/api/dashboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: layout.filter(w => w.i !== 'browser-one') }) });
    if (!r.ok) throw Error(await r.text());
  });
  await ward.waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
  assert.ok(wsBatches.slice(beforeRemove).some(c => c.cmds.some(x => x.t === 'key' && x.key === 'Alt' && x.type === 'up')), 'removing a focused ward releases keys on its socket before closing it');
  assert.ok(wsBatches.slice(beforeRemove).some(c => c.cmds.some(x => x.t === 'up' && x.button === 0)), 'removing a captured pointer releases its button');
  assert.equal(calls.slice(postsBeforeRemove).some(c => c.ward === 'browser-one'), false, 'no POST release for a socket ward');
  await page.keyboard.up('Alt');
  await page.mouse.up();
  const remaining = page.locator('[data-wd="browser-two"] canvas');
  await remaining.click();
  await page.evaluate(() => { window.__shortBrowserTimeouts = true; });
  const beforeTimeout = calls.length;
  const streamsBeforeTimeout = await page.evaluate(() => window.__browserStreams.length);
  blackhole = true;
  await page.keyboard.down('q');
  for (let attempt = 0; !finishBlackhole && attempt < 50; attempt++) await page.waitForTimeout(5);
  assert.ok(finishBlackhole);
  await page.keyboard.up('q');
  await page.keyboard.press('ArrowDown'); // queued behind the uncertain request; must never be replayed
  await page.waitForTimeout(700);
  assert.equal(calls.slice(beforeTimeout).filter(c => c.cmds.some(x => x.t === 'key' && x.type === 'down')).length, 1, 'failed batch never replays uncertain or queued input');
  assert.ok(calls.slice(beforeTimeout).some(c => c.cmds.some(x => x.t === 'key' && x.key === 'q' && x.type === 'up')), 'timeout still attempts safe releases');
  assert.ok(await page.evaluate(n => window.__browserStreams.length > n && window.__browserStreams.some(s => s.readyState === 1), streamsBeforeTimeout), 'view reconnects after a blackholed input request');
  finishBlackhole(); blackhole = false;
  await page.evaluate(() => { window.__shortBrowserTimeouts = false; });
  assert.deepEqual(errors, []);
  console.log('browser UI smoke passed: socket handshake + 2× click mapping + drop/retry, SSE fallback, pointer/keyboard, blur release, address, same-element expansion, hidden pages and reconnect, phone layout');
} finally {
  await browser?.close();
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(temp, { recursive: true, force: true });
}
