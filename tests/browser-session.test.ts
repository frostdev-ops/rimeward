import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { closeSession, killByProfile, normalizeCmds, open, peek, pushState, runCmds, setSound, subscribe, type BrowserEvent } from '../src/lib/browser/session.ts';
import { STREAM_EXTENSION } from '../src/lib/browser/extensions.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';

// The one end-to-end check: a real headless Chromium through session.ts, the
// human's input path (runCmds) and the agent's (browser_snapshot → aria-ref →
// browser_act) on one page. Skips where no chromium is installed.

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

test('normalizeCmds keeps the POST route\'s semantics: malformed entries drop, only the batch shape refuses', () => {
  assert.deepEqual(normalizeCmds([null, 7, { t: 'nope' }, { t: 'reload' }, { key: 'a' }]), [{ t: 'reload' }]);
  assert.throws(() => normalizeCmds(Array(201).fill({ t: 'reload' })), /bad batch/);
  assert.throws(() => normalizeCmds({ t: 'reload' }), /bad batch/);
  assert.throws(() => normalizeCmds(undefined), /bad batch/);
});

test('orphan cleanup terminates only processes using the selected profile root', async () => {
  const root = path.join(process.env.HOMEPAGE_DATA_DIR!, 'browser profiles');
  const children = [root, `${root}-other`].map((dir) => spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${path.join(dir, 'ward')}`],
    { stdio: 'ignore' }));
  try {
    await Promise.all(children.map((child) => once(child, 'spawn')));
    const stopped = once(children[0]!, 'exit', { signal: AbortSignal.timeout(15_000) });
    assert.equal(killByProfile(root + path.sep), 1);
    await stopped;
    assert.equal(children[1]!.exitCode, null);
    assert.equal(children[1]!.signalCode, null);
    process.kill(children[1]!.pid!, 0);
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

test('one session, two drivers', async (t) => {
  const uid = seedUser('bw@test');
  saveDashboard(uid, [{ i: 'bw1', type: 'browser', size: '3x2', config: { backend: 'local' } }]);
  let s;
  try {
    s = await open(uid, 'bw1', { backend: 'local' });
  } catch (err) {
    if (existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) throw err;
    t.skip(`no chromium here: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return;
  }
  try {
    await s.page.setContent(
      `<h1>Sandbox</h1><input aria-label="Name"><button onclick="document.querySelector('h1').textContent='clicked ' + document.querySelector('input').value">Go</button>`
    );
    const ctx = { userId: uid, ward: 'agent', conv: 1 };

    // Agent: snapshot → ref → act.
    const snap = (await TOOLS.browser_snapshot!.run({}, ctx)) as { snapshot: string };
    const button = /button "Go" \[ref=(e\d+)\]/.exec(snap.snapshot);
    const input = /textbox "Name" \[ref=(e\d+)\]/.exec(snap.snapshot);
    assert.ok(button && input, `snapshot lacks refs:\n${snap.snapshot}`);
    await TOOLS.browser_act!.run({ action: 'fill', ref: input![1], text: 'rime' }, ctx);
    await TOOLS.browser_act!.run({ action: 'click', ref: button![1] }, ctx);
    assert.equal(await s.page.textContent('h1'), 'clicked rime');

    // Human: focus the field by clicking it, type, press a key.
    const box = (await s.page.locator('input').boundingBox())!;
    const x = box.x + 5;
    const y = box.y + box.height / 2;
    await runCmds(s, [
      { t: 'down', x, y, button: 0 },
      { t: 'up', x, y, button: 0 },
      { t: 'key', type: 'down', key: 'Meta' }, // a Mac's ⌘A: the server maps it to the remote OS's select-all
      { t: 'key', type: 'down', key: 'a' },
      { t: 'key', type: 'up', key: 'a' },
      { t: 'key', type: 'up', key: 'Meta' },
      { t: 'text', text: 'human' },
      { t: 'key', type: 'down', key: 'NoSuchKey' }, // dropped, never fatal
      { t: 'resize', w: 100, h: 5000 }, // clamped
    ]);
    assert.equal(await s.page.inputValue('input'), 'human');
    assert.deepEqual(s.viewport, { width: 320, height: 1200 });
    await assert.rejects(runCmds(s, [{ t: 'goto', url: 'file:///etc/passwd' }]), /http\(s\)/);

    // Tools refuse a ward that is not the user's browser ward.
    await assert.rejects(() => TOOLS.browser_snapshot!.run({ ward: 'nope' }, ctx) as Promise<unknown>, /not a browser ward/);
  } finally {
    await closeSession(s);
  }
  assert.equal(peek(uid, 'bw1'), undefined);
});

test('local desktop browser: tabs, input batches, live frames and native session restore', async (t) => {
  const oldDesktop = process.env.RIMEWARD_DESKTOP, oldToken = process.env.RIMEWARD_NATIVE_TOKEN;
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'browser-fixture';
  const uid = seedUser('desktop-browser@test');
  let s;
  const fixture = async (context: import('playwright-core').BrowserContext) => context.route('https://browser.fixture/**', route =>
    route.fulfill({ contentType: 'text/html', body: `<title>${new URL(route.request().url()).pathname}</title><h1>Generated fixture</h1><input name="draft" aria-label="Draft"><a href="/third" target="_blank">Popup</a>` }));
  try {
    try { s = await open(uid, 'desktop-browser', { backend: 'app' }); await s.streamOpening; }
    catch (err) {
      if (existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) throw err;
      t.skip('no Chromium installed'); return;
    }
    assert.equal(s.backend, 'local', 'My computer on the desktop uses its local runtime, never the server tunnel');
    assert.equal(await open(uid, 'desktop-browser', { backend: 'app' }), s, 'reconnecting reuses the session');
    await fixture(s.context);
    await runCmds(s, [{ t: 'goto', url: 'https://browser.fixture/one' }, { t: 'goto', url: 'https://browser.fixture/two' }]);
    await runCmds(s, [{ t: 'back' }]); assert.equal(s.page.url(), 'https://browser.fixture/one');
    await runCmds(s, [{ t: 'forward' }]); assert.equal(s.page.url(), 'https://browser.fixture/two');
    const first = s.page;
    let tabTitle = '';
    const tabs = (event: import('../src/lib/browser/session.ts').BrowserEvent) => { if (event.type === 'tabs') tabTitle = event.tabs[event.active]?.title ?? ''; };
    const untabs = subscribe(s, tabs, false);
    await runCmds(s, [{ t: 'newtab' }, { t: 'goto', url: 'https://browser.fixture/three' }]);
    for (let attempt = 0; tabTitle !== '/three' && attempt < 100; attempt++) await new Promise(r => setTimeout(r, 20));
    untabs();
    assert.equal(tabTitle, '/three', 'navigation updates the tab caption without switching tabs');
    const second = s.page;
    await first.locator('input').focus(); await second.locator('input').focus();
    await runCmds(s, [{ t: 'tab', i: 0 }, { t: 'text', text: 'first only' }, null, {}, 5]);
    assert.equal(await first.inputValue('input'), 'first only', 'commands after tab selection use the selected page');
    assert.equal(await second.inputValue('input'), '');
    await assert.rejects(runCmds(s, [{ t: 'goto', url: 'javascript:alert(1)' }]), /http/);
    await assert.rejects(runCmds(s, [{ t: 'goto', url: 'file:///private/test' }]), /http/);
    await assert.rejects(runCmds(s, Array(201).fill({ t: 'reload' })), /bad batch/);
    const frame = new Promise<void>(resolve => {
      const off = subscribe(s!, event => { if (event.type === 'frame') { off(); resolve(); } });
    });
    await Promise.race([frame, new Promise((_, reject) => setTimeout(() => reject(Error('no live frame')), 5000))]);
    await runCmds(s, [{ t: 'resize', w: 900, h: 600 }]);
    assert.deepEqual(s.viewport, { width: 900, height: 600 });
    if (process.platform === 'darwin') {
      await closeSession(s);
      s = await open(uid, 'desktop-browser', { backend: 'app' });
      await s.streamOpening;
      const restored = await Promise.all(s.pages.map(async page => {
        const cdp = await s!.context.newCDPSession(page);
        try { const h = await cdp.send('Page.getNavigationHistory'); return h.entries[h.currentIndex]!.url; }
        finally { await cdp.detach(); }
      }));
      assert.deepEqual(restored, ['https://browser.fixture/two', 'https://browser.fixture/three']);
      assert.equal(s.page, s.pages[0], 'native restoration keeps ward tab selection');
      await fixture(s.context);
      await runCmds(s, [{ t: 'back' }]);
      assert.equal(s.page.url(), 'https://browser.fixture/one', 'Chromium retained history; URLs were not replayed');
      await closeSession(s);
      writeFileSync(path.join(process.env.HOMEPAGE_DATA_DIR!, 'browser', String(uid), 'desktop-browser', 'rimeward-view.json'), '{broken');
      s = await open(uid, 'desktop-browser', { backend: 'app' });
      await s.streamOpening;
      assert.equal(s.pages.length, 2, 'invalid optional tab metadata never deletes native restored tabs');
    }
    await fixture(s.context);
    await runCmds(s, [{ t: 'closetab', i: 1 }]);
    assert.equal(s.pages.length, 1);
    const original = s.page;
    const failed = t.mock.method(s.context, 'newPage', async () => { throw Error('fixture page creation failed'); });
    try {
      await assert.rejects(runCmds(s, [{ t: 'closetab', i: 0 }]), /fixture page creation failed/);
      assert.equal(original.isClosed(), false, 'failed replacement preserves the only existing tab');
      assert.equal(s.page, original);
    } finally { failed.mock.restore(); }
    const off = subscribe(s, () => {});
    try {
      await s.cast;
      for (let cycle = 0; cycle < 3; cycle++) {
        const previous: import('playwright-core').Page = s.page;
        const url = `https://browser.fixture/replacement-${cycle}`;
        await runCmds(s, [{ t: 'closetab', i: 0 }, { t: 'goto', url }]);
        assert.equal(s.pages.length, 1, 'closing the final tab completes with exactly one replacement');
        assert.equal(s.context.pages().filter((p: { url: () => string }) => !p.url().startsWith('chrome-extension://')).length, 1, 'close events do not create duplicate replacements (the capture page is not a tab)');
        assert.equal(previous.isClosed(), true);
        assert.equal(s.page, s.pages[0]);
        assert.equal(s.page.url(), url, 'same-batch navigation uses the live replacement immediately');
      }
    } finally { off(); }
    // A stalled Page.startScreencast reply cannot bypass graceful-close's
    // deadline and leave the real Chromium process alive indefinitely.
    s.cast = new Promise(() => {});
    const closed = new Promise<void>(resolve => s!.context.once('close', () => resolve()));
    const started = Date.now();
    await closeSession(s);
    assert.ok(Date.now() - started < 10_000, 'screencast cleanup shares the close deadline');
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('Chromium survived close deadline')), 5000))]);
  } finally {
    if (s) await closeSession(s);
    if (oldDesktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = oldDesktop;
    if (oldToken === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = oldToken;
  }
});

test('the capture page: never a tab, frames only while a viewer wants them, view carries the viewport, sound mutes tabs', async (t) => {
  const uid = seedUser('bw-stream@test');
  saveDashboard(uid, [{ i: 'bw2', type: 'browser', size: '3x2', config: { backend: 'local' } }]);
  let s;
  try {
    s = await open(uid, 'bw2', { backend: 'local' });
  } catch (err) {
    if (existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) throw err;
    t.skip(`no chromium here: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return;
  }
  const until = async (pred: () => boolean, ms: number, what: string) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); } };
  try {
    await until(() => !!s.stream, 15_000, 'capture page');
    // One more page in the context than the ward has tabs, and it is the extension's.
    assert.equal(s.context.pages().length, s.pages.length + 1);
    assert.ok(s.context.pages().some((p: { url: () => string }) => p.url() === `chrome-extension://${STREAM_EXTENSION.id}/stream.html`));
    assert.ok(!s.pages.some((p: { url: () => string }) => p.url().startsWith('chrome-extension://')));

    const events: BrowserEvent[] = [];
    const unsub = subscribe(s, (e) => events.push(e));
    await pushState(s);
    assert.deepEqual(events.find((e) => e.type === 'view'), { type: 'view', dsf: 1, width: 1280, height: 800 });
    const tabs = events.find((e) => e.type === 'tabs') as Extract<BrowserEvent, { type: 'tabs' }>;
    assert.ok(tabs && !tabs.tabs.some((x) => x.url.startsWith('chrome-extension://')), 'the tab strip never lists the capture page');

    // JPEG frames flow for a viewer that wants them and stop when it does not.
    await until(() => events.some((e) => e.type === 'frame'), 10_000, 'first frame');
    unsub.jpeg(false);
    await until(() => !s.cast, 5_000, 'cast stopped');
    const n = events.filter((e) => e.type === 'frame').length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(events.filter((e) => e.type === 'frame').length, n, 'no frames reach a viewer on WebRTC');
    unsub.jpeg(true);
    await until(() => !!s.cast, 5_000, 'cast resumed');
    await runCmds(s, [{ t: 'resize', w: 640, h: 480 }]);
    assert.deepEqual(events.filter((e) => e.type === 'view').at(-1), { type: 'view', dsf: 1, width: 640, height: 480 });

    // The ward's sound is off: its tabs are muted browser-side, the capture page itself never.
    const muted = () => s.stream!.page.evaluate(() => (globalThis as unknown as { chrome: { tabs: { query: (q: object) => Promise<{ url?: string; mutedInfo?: { muted: boolean } }[]> } } }).chrome.tabs.query({})
      .then((ts) => ts.map((x) => ({ url: x.url ?? '', muted: !!x.mutedInfo?.muted })))) as Promise<{ url: string; muted: boolean }[]>;
    let state = await muted();
    assert.ok(state.find((x) => x.url === 'about:blank')?.muted === true && state.find((x) => x.url.startsWith('chrome-extension://'))?.muted === false, JSON.stringify(state));
    setSound(uid, 'bw2', true);
    for (let i = 0; i < 40 && state.find((x) => x.url === 'about:blank')?.muted; i++) { await new Promise((r) => setTimeout(r, 50)); state = await muted(); }
    assert.equal(state.find((x) => x.url === 'about:blank')?.muted, false, 'sound on unmutes the tabs live, no relaunch');
    unsub();
  } finally {
    await closeSession(s);
  }
});
