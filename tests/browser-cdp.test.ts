import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalDriver, keyEvent, type Transport } from '../src/scripts/app/browser-cdp.ts';
import type { BrowserEvent, Cmd } from '../src/lib/browser/session.ts';

// The local driver against a fake DevTools socket: every command it sends is
// recorded, the handful of replies the driver needs are canned.
class Fake implements Transport {
  sent: { id: number; method: string; params: Record<string, any>; sessionId?: string }[] = [];
  onmessage?: (t: string) => void;
  onclose?: () => void;
  send(text: string): void {
    const m = JSON.parse(text);
    this.sent.push(m);
    const result = this.reply(m);
    queueMicrotask(() => this.onmessage?.(JSON.stringify({ id: m.id, result })));
  }
  close(): void {
    this.onclose?.();
  }
  event(method: string, params: unknown, sessionId?: string): void {
    this.onmessage?.(JSON.stringify({ method, params, sessionId }));
  }
  calls(method: string) {
    return this.sent.filter((s) => s.method === method);
  }
  last(method: string) {
    return this.calls(method).at(-1)!;
  }
  private reply(m: { method: string; params: Record<string, any> }): unknown {
    switch (m.method) {
      case 'Target.getTargets':
        return { targetInfos: [{ targetId: 'T1', type: 'page', url: 'https://a.test/', title: 'A' }, { targetId: 'W', type: 'service_worker', url: '', title: '' }] };
      case 'Target.attachToTarget':
        return { sessionId: `S${m.params.targetId}` };
      case 'Target.createTarget':
        return { targetId: 'T2' };
      case 'Page.getNavigationHistory':
        return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
      default:
        return {};
    }
  }
}

const boot = async (mac = false) => {
  const tr = new Fake();
  const events: BrowserEvent[] = [];
  const d = new LocalDriver(tr, (e) => events.push(e), mac);
  await d.start();
  return { tr, events, d };
};

test('start: pages only, attached flat, Page enabled, viewport set, jpeg screencast on the active session', async () => {
  const { tr, events } = await boot();
  assert.deepEqual(tr.last('Target.attachToTarget').params, { targetId: 'T1', flatten: true });
  assert.equal(tr.last('Page.enable').sessionId, 'ST1');
  assert.deepEqual(tr.last('Emulation.setDeviceMetricsOverride').params, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const cast = tr.last('Page.startScreencast');
  assert.equal(cast.sessionId, 'ST1');
  assert.equal(cast.params.quality, 60);
  assert.deepEqual(events.filter((e) => e.type === 'tabs').at(-1), { type: 'tabs', tabs: [{ url: 'https://a.test/', title: 'A' }], active: 0 });
  assert.deepEqual(events.find((e) => e.type === 'nav'), { type: 'nav', url: 'https://a.test/', title: 'A' });
});

test('commands: the server\'s clamps and vocabulary, translated to CDP', async () => {
  const { tr, d } = await boot(true);
  const run = (...cmds: Cmd[]) => d.run(cmds);

  await run({ t: 'down', x: 5000, y: -3, button: 7, clicks: 9 });
  let m = tr.last('Input.dispatchMouseEvent');
  assert.equal(m.sessionId, 'ST1');
  assert.deepEqual(m.params, { type: 'mousePressed', x: 1280, y: 0, button: 'right', buttons: 2, clickCount: 3, modifiers: 0 });
  await run({ t: 'move', x: 10, y: 10 });
  assert.equal(tr.last('Input.dispatchMouseEvent').params.button, 'right'); // a drag carries the held button
  await run({ t: 'up', x: 10, y: 10, button: 2 });
  assert.equal(tr.last('Input.dispatchMouseEvent').params.buttons, 0);

  await run({ t: 'key', type: 'down', key: 'Shift' }, { t: 'key', type: 'down', key: 'a' });
  let k = tr.last('Input.dispatchKeyEvent').params;
  assert.equal(k.type, 'keyDown');
  assert.equal(k.text, 'a');
  assert.equal(k.modifiers, 8);
  await run({ t: 'key', type: 'up', key: 'Shift' }, { t: 'key', type: 'down', key: 'Meta' }, { t: 'key', type: 'down', key: 'a' });
  k = tr.last('Input.dispatchKeyEvent').params;
  assert.equal(k.text, undefined); // ⌘A is a shortcut, not a character
  assert.deepEqual(k.commands, ['selectAll']);
  assert.equal(k.modifiers, 4);
  await run({ t: 'key', type: 'up', key: 'Meta' }, { t: 'key', type: 'down', key: 'Enter' });
  k = tr.last('Input.dispatchKeyEvent').params;
  assert.equal(k.type, 'rawKeyDown');
  assert.equal(k.windowsVirtualKeyCode, 13);
  await run({ t: 'key', type: 'down', key: 'x'.repeat(21) }); // over the cap: dropped
  assert.equal(tr.last('Input.dispatchKeyEvent').params.windowsVirtualKeyCode, 13);

  await run({ t: 'wheel', x: 1, y: 1, dx: 99_999, dy: -99_999 });
  m = tr.last('Input.dispatchMouseEvent');
  assert.equal(m.params.type, 'mouseWheel');
  assert.equal(m.params.deltaX, 5000);
  assert.equal(m.params.deltaY, -5000);

  await run({ t: 'text', text: 'hi' });
  assert.deepEqual(tr.last('Input.insertText').params, { text: 'hi' });

  await assert.rejects(() => run({ t: 'goto', url: 'javascript:alert(1)' }), /http/);
  await run({ t: 'goto', url: 'https://b.test' });
  assert.equal(tr.last('Page.navigate').params.url, 'https://b.test/');
  await run({ t: 'back' });
  assert.equal(tr.last('Page.navigateToHistoryEntry').params.entryId, 10);
  await run({ t: 'forward' });
  assert.equal(tr.last('Page.navigateToHistoryEntry').params.entryId, 12);
  await run({ t: 'reload' });
  assert.equal(tr.calls('Page.reload').length, 1);

  const casts = tr.calls('Page.startScreencast').length;
  await run({ t: 'resize', w: 10_000, h: 5 });
  assert.deepEqual(tr.last('Emulation.setDeviceMetricsOverride').params, { width: 1920, height: 240, deviceScaleFactor: 1, mobile: false });
  assert.equal(tr.calls('Page.startScreencast').length, casts + 1); // restarted at the new size
  assert.equal(tr.last('Page.startScreencast').params.maxWidth, 1920);
});

test('resize with a scale: HiDPI metrics and a cast at device pixels; a scale-only resize still restarts', async () => {
  const { tr, events, d } = await boot();
  const casts = tr.calls('Page.startScreencast').length;
  await d.run([{ t: 'resize', w: 900, h: 600, dsf: 2 }]);
  assert.deepEqual(tr.last('Emulation.setDeviceMetricsOverride').params, { width: 900, height: 600, deviceScaleFactor: 2, mobile: false });
  assert.equal(tr.calls('Page.startScreencast').length, casts + 1);
  assert.deepEqual([tr.last('Page.startScreencast').params.maxWidth, tr.last('Page.startScreencast').params.maxHeight], [1800, 1200]);
  assert.equal(events.some(e => e.type === 'view'), false, 'the driver never claims a frame scale: browser.ts measures it off the frame');
  // The same CSS size at a new scale is still a resize (scale-only), and 3 clamps to 2, 1.3 to a quarter step.
  await d.run([{ t: 'resize', w: 900, h: 600, dsf: 1.3 }]);
  assert.equal(tr.calls('Page.startScreencast').length, casts + 2);
  assert.equal(tr.last('Emulation.setDeviceMetricsOverride').params.deviceScaleFactor, 1.25);
  assert.equal(tr.last('Page.startScreencast').params.maxWidth, 1125);
  await d.run([{ t: 'resize', w: 900, h: 600, dsf: 3 }]);
  assert.equal(tr.last('Emulation.setDeviceMetricsOverride').params.deviceScaleFactor, 2);
  // No scale on the command keeps the current one; nothing changed → no restart.
  await d.run([{ t: 'resize', w: 900, h: 600 }]);
  assert.equal(tr.calls('Page.startScreencast').length, casts + 3);
  // A tab switch applies the same scale to the new page's metrics.
  await d.run([{ t: 'newtab' }]);
  tr.event('Target.targetCreated', { targetInfo: { targetId: 'T2', type: 'page', url: 'about:blank', title: '' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tr.last('Emulation.setDeviceMetricsOverride').sessionId, 'ST2');
  assert.equal(tr.last('Emulation.setDeviceMetricsOverride').params.deviceScaleFactor, 2);
});

test('tabs, frames and dialogs: a new page takes focus, frames are acked, beforeunload is accepted', async () => {
  const { tr, events, d } = await boot();
  await d.run([{ t: 'newtab' }]);
  assert.equal(tr.calls('Target.createTarget').length, 1);
  tr.event('Target.targetCreated', { targetInfo: { targetId: 'T2', type: 'page', url: 'about:blank', title: '' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tr.last('Target.attachToTarget').params.targetId, 'T2');
  assert.equal(tr.calls('Page.stopScreencast').length, 1); // the old page's cast stopped
  assert.deepEqual(events.filter((e) => e.type === 'tabs').at(-1), { type: 'tabs', tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'about:blank', title: '' }], active: 1 });

  tr.event('Page.screencastFrame', { data: 'abc', sessionId: 7, metadata: { deviceWidth: 640, deviceHeight: 480 } }, 'ST2');
  assert.deepEqual(events.at(-1), { type: 'frame', data: 'abc', width: 640, height: 480 });
  assert.deepEqual(tr.last('Page.screencastFrameAck').params, { sessionId: 7 });
  tr.event('Page.screencastFrame', { data: 'stale', sessionId: 8, metadata: {} }, 'ST1'); // the inactive page's frame: dropped
  assert.equal((events.at(-1) as { data?: string }).data, 'abc');

  tr.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: 'leave?' }, 'ST2');
  assert.deepEqual(events.at(-1), { type: 'dialog', kind: 'beforeunload', message: 'leave?' });
  assert.deepEqual(tr.last('Page.handleJavaScriptDialog').params, { accept: true });
  tr.event('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' }, 'ST2');
  assert.deepEqual(tr.last('Page.handleJavaScriptDialog').params, { accept: false });

  await d.run([{ t: 'tab', i: 0 }]);
  assert.equal(tr.calls('Target.attachToTarget').length, 2); // the first page's session is reused
  assert.equal(tr.last('Target.activateTarget').params.targetId, 'T1');
  await d.run([{ t: 'closetab', i: 1 }]);
  assert.equal(tr.last('Target.closeTarget').params.targetId, 'T2');

  tr.close();
  assert.deepEqual(events.at(-1), { type: 'closed' });
});

test('keyEvent: specials carry a virtual key code, characters carry text, the rest is null', () => {
  assert.deepEqual(keyEvent('Space', 'down', 0, false), { modifiers: 0, type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(keyEvent('F5', 'up', 0, false)!.windowsVirtualKeyCode, 116);
  assert.deepEqual(keyEvent('a', 'down', 2, false), { modifiers: 2, type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }); // Ctrl held: no text
  assert.equal(keyEvent('7', 'down', 0, false)!.code, 'Digit7');
  assert.equal(keyEvent('Dead', 'down', 0, false), null);
});


test('closing a target during activation is harmless; invalid mouse buttons are dropped', async () => {
  const tr = new Fake(), events: BrowserEvent[] = [];
  const send = tr.send.bind(tr);
  tr.send = text => {
    if (JSON.parse(text).method === 'Page.startScreencast')
      tr.event('Target.targetDestroyed', { targetId: 'T1' });
    send(text);
  };
  const driver = new LocalDriver(tr, event => events.push(event));
  await driver.start();
  assert.equal(events.some(event => event.type === 'nav'), false);
  const { tr: active, d } = await boot();
  await d.run([{ t: 'down', x: 1, y: 1, button: 1.5 }]);
  assert.equal(active.calls('Input.dispatchMouseEvent').length, 0);
});
