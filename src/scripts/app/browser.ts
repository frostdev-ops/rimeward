import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
// The browser ward: a live view of a real Chromium session the server runs for
// this ward (lib/browser/session.ts), driven from here by the human and from
// Rime's tools by the agent — one session, two drivers. Frames and input share
// one WebSocket per ward (lib/browser/live.ts): binary jpeg down, command
// batches up, ordered by the server. A ward the desktop relay serves cannot
// upgrade, so a socket closed before its `hello` switches the mount to the
// SSE + POST path for good. The remote viewport follows the surface it is
// shown on — the ward, or the shared expand dialog the SAME element moves
// into — in CSS pixels at the display's scale, so what you see is what you click.
//
// Inside the Rimeward app, a "My computer" ward's Chromium is on this very
// machine: the same UI then drives it directly over CDP (browser-cdp.ts) —
// same events, same commands, no server in the loop for frames or input.

import { RENDERERS, body } from './wards.ts';
import { el, normalizeUrl, postJson } from './dom.ts';
import { icon } from './icon.ts';
import { openMenu, menuItem, closeMenu } from './menu.ts';
import type { BrowserDownload } from '../../lib/browser/downloads.ts';
import { LocalDriver, type Transport } from './browser-cdp.ts';
import { LiveEventSource } from './live-stream.ts';
import { browserScale, type BrowserConfig, type WardInstance } from '../../lib/wards.ts';
import type { BrowserEvent, Cmd } from '../../lib/browser/session.ts';
import type { BrowserExtension } from '../../lib/browser/extensions.ts';

type Tabs = Extract<BrowserEvent, { type: 'tabs' }>;

interface Mount {
  w: WardInstance;
  source: string;
  /** Nav bar + tab strip + view. Moves between the ward body and the dialog. */
  root: HTMLElement;
  view: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  url: HTMLInputElement;
  expand: HTMLButtonElement;
  tabs: HTMLElement;
  toast: HTMLElement;
  /** `ws` until a socket closes before its `hello` (a relayed ward, an old
   *  runtime, nginx without the block): then `sse` for the mount's life. */
  mode: 'ws' | 'sse';
  ws?: WebSocket;
  wsEpoch: number;
  /** Consecutive sockets closed before `hello`: the second one latches `sse`,
   *  so one hiccup (a reload mid-deploy) does not cost the tab its socket. */
  wsRefused: number;
  hello: boolean;
  /** The socket's browser is open (`view` arrived): input may be sent. */
  ready: boolean;
  /** The remote's device scale: a frame is viewport × dsf pixels. */
  dsf: number;
  es?: LiveEventSource;
  /** The local path (inside the app): the driver once open, `opening` meanwhile. */
  driver?: LocalDriver;
  opening?: boolean;
  /** The webview refused the loopback socket: this ward uses the server's view instead. */
  localFailed?: boolean;
  touchT?: ReturnType<typeof setInterval>;
  retryT?: ReturnType<typeof setTimeout>;
  resizeT?: ReturnType<typeof setTimeout>;
  epoch: number;
  stopped?: boolean;
  visible: boolean;
  queue: Cmd[];
  moveIdx: number;
  flushT?: ReturnType<typeof setTimeout>;
  inflight?: Promise<void>;
  closing?: Promise<void>;
  held: Set<string>;
  buttons: Set<number>;
  submittedKeys: Set<string>;
  submittedButtons: Set<number>;
  decoding: boolean;
  pendingFrame?: Blob | string;
  toastT?: ReturnType<typeof setTimeout>;
  ro: ResizeObserver;
  io: IntersectionObserver;
}

const mounts = new Map<string, Mount>();
const browserSource = (w: WardInstance): string => {
  const cfg = w.config as BrowserConfig | undefined;
  return JSON.stringify([cfg?.backend ?? 'local', cfg?.route, w.device]);
};
const editing = () => document.getElementById('wd-grid')?.classList.contains('editing') ?? false;

// ------------------------------------------------------------------ stream

function connect(m: Mount): void {
  if (m.stopped || m.closing || m.es || m.ws || m.driver || m.opening || !m.visible || document.hidden) return;
  if (isLocal(m)) return void connectLocal(m);
  if (m.mode === 'ws') return connectWs(m);
  const es = new LiveEventSource(`/api/browser/stream/${m.w.i}`);
  m.es = es;
  // (Re)connected: the remote viewport must match THIS surface — the size sent
  // at mount may have landed before the ward was saved, or on a browser since
  // closed and relaunched at the default.
  es.onopen = () => { if (m.es === es) scheduleResize(m); };
  for (const type of ['frame', 'nav', 'tabs', 'dialog', 'route', 'download', 'view'] as const) {
    es.addEventListener(type, (e) => { if (m.es === es) onEvent(m, JSON.parse((e as MessageEvent).data) as BrowserEvent); });
  }
  es.onerror = () => {
    if (m.es !== es) return;
    // A closed stream (the server closed the browser) reconnects by itself; a
    // refused one (not a browser ward, too many live browsers) does not.
    if (es.readyState !== EventSource.CLOSED) return;
    m.es = undefined;
    // A ward added in edit mode is not in the STORED layout until Done saves
    // it, and the server resolves wards against the stored layout.
    flash(m, editing() ? 'Press Done to save the layout — the browser starts then.' : 'Browser unavailable — retrying…', 5000);
    m.retryT = setTimeout(() => connect(m), 5000);
  };
}

/** The ward's WebSocket. `hello` = the transport is ours; `view` = the browser
 *  is open. Input waits for `view`; a close after `hello` retries in 5 s. */
function connectWs(m: Mount): void {
  const epoch = ++m.wsEpoch;
  m.hello = false; m.ready = false;
  // A document served through the desktop relay: the socket cannot cross it
  // (and would reach the wrong server's ward). Straight to the SSE path.
  if (document.querySelector('meta[name="rimeward-runtime-base"]')) { m.mode = 'sse'; connect(m); return; }
  let ws: WebSocket;
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/browser/ws/${m.w.i}?dsf=${browserScale(devicePixelRatio)}`); }
  catch { m.mode = 'sse'; connect(m); return; }
  ws.binaryType = 'blob';
  m.ws = ws;
  const mine = () => m.ws === ws && m.wsEpoch === epoch;
  ws.onmessage = (e) => {
    if (!mine()) return;
    if (e.data instanceof Blob) { stats(m, e.data.size); void onFrame(m, e.data); return; }
    let ev: BrowserEvent | { type: 'hello' } | { type: 'error'; message: string };
    try { ev = JSON.parse(String(e.data)); } catch { ws.close(); return; }
    if (ev.type === 'hello') { m.hello = true; m.wsRefused = 0; return; }
    if (ev.type === 'error') { flash(m, ev.message, 5000); return; }
    if (ev.type === 'view') {
      m.dsf = ev.dsf;
      // `view` also rides every tab switch's state push: the viewport is
      // negotiated once per socket, not once per tab click.
      if (!m.ready) { m.ready = true; scheduleResize(m); void flush(m); }
      return;
    }
    onEvent(m, ev);
  };
  ws.onclose = () => {
    if (!mine()) return;
    m.ws = undefined; m.ready = false;
    // Whatever was queued or held is stale: the server released this socket's
    // downs itself, and nothing is replayed on the next socket.
    m.queue = []; m.moveIdx = -1; m.held.clear(); m.buttons.clear();
    if (m.stopped || m.closing) return;
    if (!m.hello && ++m.wsRefused >= 2) { m.mode = 'sse'; connect(m); return; }
    flash(m, editing() ? 'Press Done to save the layout — the browser starts then.' : 'Browser unavailable — retrying…', 5000);
    m.retryT = setTimeout(() => connect(m), m.hello ? 5000 : 1500);
  };
}

function disconnect(m: Mount): void {
  if (m.closing) return;
  m.epoch++;
  m.opening = false;
  m.es?.close();
  m.es = undefined;
  const ws = m.ws;
  if (ws) {
    // Ours to end: the callbacks are invalidated first so this close can never
    // read as "the server refused us" and flip the mount to the SSE path.
    m.wsEpoch++;
    m.ws = undefined;
    if (ws.readyState === WebSocket.OPEN && m.ready) {
      const releases: Cmd[] = [
        ...[...m.held].map(key => ({ t: 'key' as const, type: 'up' as const, key })),
        ...[...m.buttons].map(button => ({ t: 'up' as const, x: 0, y: 0, button })),
      ];
      if (releases.length) ws.send(JSON.stringify({ cmds: releases })); // queued before the Close frame
    }
    m.ready = false; m.hello = false;
    m.queue = []; m.moveIdx = -1; m.held.clear(); m.buttons.clear();
    if (m.flushT) clearTimeout(m.flushT);
    m.flushT = undefined;
    if (m.retryT) clearTimeout(m.retryT);
    m.retryT = undefined;
    ws.close();
    connect(m);
    return;
  }
  const d = m.driver;
  m.driver = undefined;
  if (m.touchT) clearInterval(m.touchT);
  m.touchT = undefined;
  if (m.retryT) clearTimeout(m.retryT);
  m.retryT = undefined;
  if (m.flushT) clearTimeout(m.flushT);
  m.flushT = undefined;
  // Discard commands whose outcome is still unknown; only releases may follow
  // the in-flight batch. Physical key-up may itself be waiting in that queue.
  m.queue = []; m.moveIdx = -1;
  const releases: Cmd[] = [
    ...[...new Set([...m.held, ...m.submittedKeys])].map(key => ({ t: 'key' as const, type: 'up' as const, key })),
    ...[...new Set([...m.buttons, ...m.submittedButtons])].map(button => ({ t: 'up' as const, x: 0, y: 0, button })),
  ];
  m.held.clear(); m.buttons.clear();
  const pending = m.inflight;
  m.closing = (async () => {
    await pending;
    if (releases.length) await send(m, releases, d);
  })().finally(() => {
    d?.close();
    m.closing = undefined;
    connect(m);
  });
}

/** Every event either path produces, handled once. */
function onEvent(m: Mount, ev: BrowserEvent): void {
  switch (ev.type) {
    case 'frame':
      void onFrame(m, ev);
      break;
    case 'nav':
      if (document.activeElement !== m.url) m.url.value = ev.url === 'about:blank' ? '' : ev.url;
      break;
    case 'tabs':
      paintTabs(m, ev);
      break;
    case 'dialog':
      flash(m, `${ev.kind}: ${ev.message}`, 8000);
      break;
    case 'route':
      if (!ev.online) flash(m, ev.detail ?? 'Home route offline — open Rimeward on your computer', 8000);
      break;
    case 'view':
      m.dsf = ev.dsf;
      break;
    case 'download':
      flash(m, ev.file.status === 'ready' ? `${ev.file.name} saved — open Downloads to save a copy. Rime can inspect it.`
        : ev.file.status === 'failed' ? `${ev.file.name}: ${ev.file.error}` : `Downloading ${ev.file.name}…`, 8000);
      break;
  }
}

// ------------------------------------------------ local (inside the app)

interface Tauri {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}
const tauri = (): Tauri | undefined => (window as { __TAURI__?: Tauri }).__TAURI__;
const isLocal = (m: Mount): boolean => document.getElementById('instance-status')?.dataset.desktop !== '1' && !m.localFailed && !!tauri() && (m.w.config as BrowserConfig | undefined)?.backend === 'app';

/** The app names the ward's Chromium (launching or downloading it first);
 *  the page then speaks CDP to it over loopback. A webview that refuses the
 *  loopback socket falls back to the server's view of the same browser. */
async function connectLocal(m: Mount): Promise<void> {
  m.opening = true;
  const epoch = m.epoch;
  let info: { ws: string; platform: string };
  try {
    // The display's scale rides the launch: the app's Chromium casts at its
    // process scale, so only a launch can make HiDPI frames (browser-cdp.ts).
    info = (await tauri()!.core.invoke('ward_browser', { ward: m.w.i, dsf: browserScale(devicePixelRatio), sound: (m.w.config as BrowserConfig | undefined)?.sound === true })) as { ws: string; platform: string };
  } catch (err) {
    if (m.epoch !== epoch) return;
    m.opening = false;
    flash(m, String(err), 8000);
    m.retryT = setTimeout(() => connect(m), 5000);
    return;
  }
  if (m.epoch !== epoch) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(info.ws);
  } catch {
    m.opening = false;
    m.localFailed = true;
    connect(m);
    return;
  }
  const tr: Transport = { send: (t) => ws.send(t), close: () => ws.close() };
  ws.onmessage = (e) => tr.onmessage?.(String(e.data));
  const driver = new LocalDriver(tr, (ev) => onEvent(m, ev), info.platform === 'darwin');
  let opened = false;
  ws.onopen = () => {
    if (m.epoch !== epoch) { ws.close(); return; }
    opened = true;
    m.opening = false;
    if (!m.visible || document.hidden) {
      ws.close();
      return;
    }
    m.driver = driver;
    void driver.start().then(() => scheduleResize(m), (err: unknown) => {
      if (m.driver !== driver) return;
      flash(m, String(err), 5000);
      driver.close();
    });
    // The app reaps an instance nobody touched for 10 min; this page is somebody.
    m.touchT = setInterval(() => void tauri()?.core.invoke('ward_touch', { ward: m.w.i }).catch(() => {}), 60_000);
  };
  ws.onclose = () => {
    tr.onclose?.();
    if (m.epoch !== epoch) return;
    m.opening = false;
    if (m.touchT) clearInterval(m.touchT);
    m.touchT = undefined;
    const mine = m.driver === driver;
    if (mine) m.driver = undefined;
    if (!opened) {
      m.localFailed = true;
      connect(m);
      return;
    }
    if (mine && m.visible && !document.hidden) {
      flash(m, 'Local browser closed — reconnecting…', 5000);
      m.retryT = setTimeout(() => connect(m), 3000);
    }
  };
}

/** jpeg bytes (the socket; the scale came with `view`) or CDP's base64 with
 *  its CSS width (the in-app driver; the scale is whatever the frame IS). */
async function onFrame(m: Mount, f: Blob | Extract<BrowserEvent, { type: 'frame' }>): Promise<void> {
  const data = f instanceof Blob ? f : f.data;
  const css = f instanceof Blob ? 0 : f.width;
  if (m.decoding) {
    m.pendingFrame = data; // latest wins — decoding never queues
    return;
  }
  m.decoding = true;
  try {
    let next: Blob | string | undefined = data;
    while (next) {
      const blob = next instanceof Blob ? next : new Blob([Uint8Array.from(atob(next), c => c.charCodeAt(0))], { type: 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      if (css) m.dsf = browserScale(bmp.width / css);
      if (m.canvas.width !== bmp.width || m.canvas.height !== bmp.height) {
        m.canvas.width = bmp.width;
        m.canvas.height = bmp.height;
      }
      m.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      stats(m, 0, true);
      next = m.pendingFrame;
      m.pendingFrame = undefined;
    }
  } catch {
    /* a torn frame — the next one repaints */
  } finally {
    m.decoding = false;
  }
}

// A measurement proxy behind localStorage['fd-bw-debug']: frames painted and
// bytes per second, and ms from the last local input to the NEXT painted
// frame — which is the response only on a page that emits no frames by
// itself (no animation); on any other page it is just the frame cadence.
let debug: boolean | undefined;
const debugStats = { frames: 0, bytes: 0, latency: [] as number[], input: 0, t: 0 };
function stats(m: Mount, bytes: number, painted = false): void {
  debug ??= (() => { try { return localStorage.getItem('fd-bw-debug') === '1'; } catch { return false; } })();
  if (!debug) return;
  const now = performance.now();
  debugStats.bytes += bytes;
  if (painted) { debugStats.frames++; if (debugStats.input) { debugStats.latency.push(now - debugStats.input); debugStats.input = 0; } }
  if (now - debugStats.t < 1000) return;
  if (debugStats.t) console.log(`[bw ${m.w.i}] ${debugStats.frames} fps, ${(debugStats.bytes / 1024).toFixed(0)} KB/s, input→next frame ${debugStats.latency.length ? debugStats.latency.map(x => x.toFixed(0)).join('/') : '-'} ms, ${m.canvas.width}×${m.canvas.height} @${m.dsf}`);
  debugStats.t = now; debugStats.frames = 0; debugStats.bytes = 0; debugStats.latency = [];
}

// ------------------------------------------------------------------- input

/** In socket mode, input exists only for an open, ready socket: what is typed
 *  while connecting or retrying is dropped, never delivered late. (A lone
 *  key-up the server never saw the down of is harmless.) */
const wsReady = (m: Mount): boolean => m.ws?.readyState === WebSocket.OPEN && m.ready;

function push(m: Mount, c: Cmd, urgent = false): void {
  if (m.stopped || m.closing) return;
  if (m.mode === 'ws' && !m.driver && !isLocal(m) && !wsReady(m)) {
    // Silent for the pointer; a click, key or navigation that goes nowhere says so.
    if (c.t !== 'move' && c.t !== 'wheel' && c.t !== 'resize') flash(m, 'Reconnecting to the browser…', 2000);
    return;
  }
  if (debug && (c.t === 'down' || (c.t === 'key' && c.type === 'down'))) debugStats.input = performance.now();
  const tail = m.queue.at(-1);
  if (c.t === 'move') {
    // Coalesce: only the latest position matters.
    if (m.moveIdx >= 0) m.queue[m.moveIdx] = c;
    else m.moveIdx = m.queue.push(c) - 1;
  } else if (c.t === 'wheel' && tail?.t === 'wheel') {
    // A trackpad fling is dozens of small deltas: one summed wheel per flush.
    m.queue[m.queue.length - 1] = { t: 'wheel', x: c.x, y: c.y, dx: tail.dx + c.dx, dy: tail.dy + c.dy };
  } else m.queue.push(c);
  if (urgent) void flush(m);
  else if (!m.flushT) m.flushT = setTimeout(() => void flush(m), 16);
}

/** The socket takes every batch at once (the server orders them); the driver
 *  and the POST path take one at a time — ordering is the point of a batch. */
async function flush(m: Mount): Promise<void> {
  if (m.flushT) clearTimeout(m.flushT);
  m.flushT = undefined;
  if (!m.queue.length || m.closing || m.stopped) return;
  if (!m.driver && m.mode === 'ws') {
    const ws = m.ws;
    if (!ws || !wsReady(m)) return;
    // The server refuses a batch over 200; the rest goes on the next tick.
    const cmds = m.queue.splice(0, 200);
    m.moveIdx = m.queue.findIndex(c => c.t === 'move');
    ws.send(JSON.stringify({ cmds }));
    if (m.queue.length && !m.flushT) m.flushT = setTimeout(() => void flush(m), 0);
    return;
  }
  if (m.inflight) return m.inflight;
  const cmds = m.queue;
  m.queue = [];
  m.moveIdx = -1;
  m.inflight = send(m, cmds, m.driver).finally(() => {
    m.inflight = undefined;
    if (m.queue.length) void flush(m);
  });
  return m.inflight;
}

async function send(m: Mount, cmds: Cmd[], driver?: LocalDriver): Promise<void> {
  for (const c of cmds) {
    if (c.t === 'key' && c.type === 'down') m.submittedKeys.add(c.key);
    if (c.t === 'down') m.submittedButtons.add(c.button ?? 0);
  }
  try {
    if (driver) {
      await driver.run(cmds);
    } else {
      const navigation = cmds.some(c => ['goto', 'back', 'forward', 'reload'].includes(c.t));
      const res = await postJson(`/api/browser/${m.w.i}`, { cmds }, 'POST', { signal: AbortSignal.timeout(navigation ? 35_000 : 5_000) });
      if (!res.ok) throw Error(res.data?.error ?? 'Browser disconnected');
    }
    for (const c of cmds) {
      if (c.t === 'key' && c.type === 'up') m.submittedKeys.delete(c.key);
      if (c.t === 'up') m.submittedButtons.delete(c.button ?? 0);
    }
  } catch (err) {
    m.queue = []; m.moveIdx = -1;
    flash(m, err instanceof Error ? err.message : 'Browser disconnected', 5000);
    if (!m.closing && !m.stopped) disconnect(m);
  }
}

/** Canvas pixel → remote viewport CSS px: the frame is viewport × dsf pixels
 *  drawn object-fit:contain, so it may be letterboxed inside the canvas. */
function toPage(m: Mount, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = m.canvas.getBoundingClientRect();
  const cw = (m.canvas.width || 1) / m.dsf;
  const ch = (m.canvas.height || 1) / m.dsf;
  const scale = Math.min(r.width / cw, r.height / ch) || 1;
  const ox = (r.width - cw * scale) / 2;
  const oy = (r.height - ch * scale) / 2;
  return {
    x: Math.max(0, Math.min(cw, (e.clientX - r.left - ox) / scale)),
    y: Math.max(0, Math.min(ch, (e.clientY - r.top - oy) / scale)),
  };
}

const SKIP_KEYS = new Set(['Dead', 'Unidentified', 'Process']);
/** DOM key → Playwright key name. Modifiers go as pressed; the server maps
 *  ⌘/Ctrl to whatever the remote OS means by them. */
function keyName(e: KeyboardEvent): string {
  if (e.key === ' ') return 'Space';
  if (SKIP_KEYS.has(e.key)) return '';
  return e.key;
}

function wireInput(m: Mount): void {
  const c = m.canvas;
  const modifiers = (e: KeyboardEvent) => {
    // Focus can arrive while a modifier is already held; native WebKit may
    // report only the flags on the shortcut, without a separate keydown.
    for (const [key, down] of [['Alt', e.altKey], ['Control', e.ctrlKey], ['Meta', e.metaKey], ['Shift', e.shiftKey]] as const) {
      if (key === e.key || down === m.held.has(key)) continue;
      if (down) m.held.add(key); else m.held.delete(key);
      push(m, { t: 'key', type: down ? 'down' : 'up', key }, true);
    }
  };
  c.addEventListener('pointerdown', (e) => {
    if (editing()) return;
    e.preventDefault();
    c.focus();
    c.setPointerCapture(e.pointerId);
    m.buttons.add(e.button);
    push(m, { t: 'down', ...toPage(m, e), button: e.button, clicks: e.detail || 1 }, true);
  });
  c.addEventListener('pointermove', (e) => {
    if (editing()) return;
    push(m, { t: 'move', ...toPage(m, e) });
  });
  c.addEventListener('pointerup', (e) => {
    if (editing()) return;
    m.buttons.delete(e.button);
    push(m, { t: 'up', ...toPage(m, e), button: e.button, clicks: e.detail || 1 }, true);
  });
  c.addEventListener(
    'wheel',
    (e) => {
      if (editing()) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? m.canvas.height : 1;
      push(m, { t: 'wheel', ...toPage(m, e), dx: e.deltaX * k, dy: e.deltaY * k });
    },
    { passive: false }
  );
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('keydown', (e) => {
    if (editing()) return;
    modifiers(e);
    // Paste arrives through the paste event with the CLIENT's clipboard; the
    // remote one is empty, so the shortcut itself must not also fire there.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    const key = keyName(e);
    if (!key) return;
    m.held.add(key);
    push(m, { t: 'key', type: 'down', key }, true);
  });
  c.addEventListener('keyup', (e) => {
    if (editing()) return;
    modifiers(e);
    const key = keyName(e);
    if (!key) return;
    m.held.delete(key);
    push(m, { t: 'key', type: 'up', key }, true);
  });
  c.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text') ?? '';
    if (text) push(m, { t: 'text', text }, true);
  });
  // Focus left mid-press (tab switch, dialog): release everything held or the
  // remote page keeps a stuck Shift/button forever.
  c.addEventListener('blur', () => {
    for (const key of m.held) push(m, { t: 'key', type: 'up', key });
    m.held.clear();
    for (const button of m.buttons) push(m, { t: 'up', x: 0, y: 0, button });
    m.buttons.clear();
    void flush(m);
  });
}

// ---------------------------------------------------------------- chrome

function flash(m: Mount, text: string, ms: number): void {
  if (m.stopped) return;
  m.toast.textContent = text;
  m.toast.hidden = false;
  if (m.toastT) clearTimeout(m.toastT);
  m.toastT = setTimeout(() => (m.toast.hidden = true), ms);
}

function paintTabs(m: Mount, t: Tabs): void {
  m.tabs.textContent = '';
  m.tabs.hidden = t.tabs.length < 2;
  t.tabs.forEach((tab, i) => {
    const b = el('button', 'bw-tab', tab.title || tab.url.replace(/^https?:\/\//, '') || 'New tab');
    b.type = 'button';
    b.title = tab.url;
    b.setAttribute('aria-pressed', String(i === t.active));
    b.addEventListener('click', () => push(m, { t: 'tab', i }, true));
    if (i === t.active && t.tabs.length > 1) {
      const x = el('span', 'bw-tab-x'); x.append(icon('close'));
      x.title = 'Close tab';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        push(m, { t: 'closetab', i }, true);
      });
      b.append(x);
    }
    m.tabs.append(b);
  });
}

function navButton(m: Mount, label: string, title: string, cmd: Cmd): HTMLButtonElement {
  const b = el('button', 'btn min-h-0 shrink-0 px-1.5 py-0.5 text-xs', label);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', () => push(m, cmd, true));
  return b;
}

async function showDownloads(m: Mount, button: HTMLButtonElement): Promise<void> {
  try {
    const response = await fetch(`/api/browser/${m.w.i}`, { signal: AbortSignal.timeout(15_000) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? 'Downloads unavailable.');
    if (m.stopped) return;
    const files = value.downloads as BrowserDownload[], rect = button.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 4, menu => {
      menu.style.maxHeight = 'min(60vh, 480px)'; menu.style.overflowY = 'auto';
      if (/^https?:\/\//.test(m.url.value)) menu.append(menuItem('download', 'Download current file', () => {
        void fetch(`/api/browser/${m.w.i}`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'download', args: { url: m.url.value } }), signal: AbortSignal.timeout(30_000) })
          .then(async response => { const result = await response.json(); if (!response.ok || result.error) throw Error(result.error ?? 'Download failed.'); flash(m, 'Download started. Check Downloads for its status.', 6000); })
          .catch(error => flash(m, String(error), 8000));
      }));
      if (!files.length) menu.append(el('p', 'p-2 text-sm', 'No downloads yet. Use a website’s download link (up to 25 MB).'));
      for (const file of files) {
        if (file.status === 'ready') {
          const link = el('a', 'flex items-center gap-2 p-2 text-sm');
          link.href = `/api/browser/${m.w.i}?download=${encodeURIComponent(file.id)}`;
          link.download = file.name;
          link.append(icon('download'), document.createTextNode(file.name));
          link.setAttribute('role', 'menuitem');
          link.addEventListener('click', closeMenu);
          menu.append(link);
        } else menu.append(el('p', 'p-2 text-sm', `${file.name}: ${file.error ?? 'Downloading…'}`));
        if (file.status !== 'downloading') menu.append(menuItem('trash', `Remove ${file.name}`, () => {
          void fetch(`/api/browser/${m.w.i}?download=${encodeURIComponent(file.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
            .then(async response => { if (!response.ok) throw Error((await response.json()).error ?? 'Removal failed.'); })
            .catch(error => flash(m, String(error), 8000));
        }));
      }
      menu.querySelector<HTMLElement>('a')?.focus();
    });
  } catch (error) { flash(m, error instanceof Error ? error.message : 'Downloads unavailable.', 8000); }
}

async function showExtensions(m: Mount): Promise<void> {
  const dialog = el('dialog', 'm-auto rounded-xl border border-line bg-surface-2 p-5 text-ink shadow-xl backdrop:bg-black/60');
  dialog.style.width = 'min(560px, calc(100vw - 32px))';
  dialog.style.maxHeight = '80vh';
  const title = el('h2', 'text-lg font-semibold', 'Browser extensions');
  title.id = `extensions-${m.w.i}`; dialog.setAttribute('aria-labelledby', title.id);
  const status = el('p', 'my-3 text-sm'); status.setAttribute('role', 'status');
  const list = el('div', 'grid gap-3');
  const actions = el('div', 'mt-4 flex flex-wrap gap-2');
  const upload = el('button', 'btn', 'Install ZIP'); upload.type = 'button';
  const restart = el('button', 'btn', 'Restart browser to apply'); restart.type = 'button';
  const glaze = el('button', 'btn', 'Restore Glaze'); glaze.type = 'button';
  const close = el('button', 'btn', 'Close'); close.type = 'button';
  const file = el('input'); file.type = 'file'; file.accept = '.zip,application/zip'; file.hidden = true;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(title, el('p', 'mt-2 text-sm opacity-70', 'Saved for this browser ward. Glaze is included by default. Changes take effect when you restart this browser; finish any open forms first.'), status, list, actions, file);
  actions.append(upload, glaze, restart, close);
  document.body.append(dialog); dialog.showModal();
  let busy = false;
  const run = async (action: string, data: Record<string, unknown> | File = {}) => {
    if (busy) return;
    busy = true; dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = action === 'restart' ? 'Restarting browser…' : 'Saving…';
    try {
      const response = await fetch(`/api/browser/${m.w.i}?extension=${action}`, {
        method: 'POST', headers: { 'content-type': data instanceof File ? 'application/zip' : 'application/json' },
        body: data instanceof File ? data : JSON.stringify(data), signal: AbortSignal.timeout(120_000),
      });
      const result = await response.json();
      if (!response.ok || result.error) throw Error(result.error ?? 'Extension operation failed');
      if (action === 'open') { dialog.close(); return; }
      await refresh();
      status.textContent = action === 'restart' ? 'Browser restarted.' : 'Saved. Restart this browser to apply your changes.';
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Extensions unavailable'; }
    finally { busy = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  };
  const refresh = async () => {
    const response = await fetch(`/api/browser/${m.w.i}?extensions=1`, { signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? 'Extensions unavailable');
    glaze.hidden = result.extensions.some((entry: BrowserExtension) => entry.bundled);
    list.replaceChildren();
    if (result.hosted) list.append(el('p', 'text-sm opacity-70', 'Browserbase supports one enabled extension per session. Disable it before enabling another.'));
    for (const entry of result.extensions as BrowserExtension[]) {
      const row = el('section', 'rounded-lg border border-white/15 p-3');
      row.append(el('h3', 'font-medium', `${entry.name} · ${entry.version}`));
      const permissions = el('p', 'my-2 break-words text-xs opacity-70', `Permissions: ${entry.permissions.join(', ') || 'None'}`);
      row.append(permissions);
      const controls = el('div', 'flex flex-wrap gap-2');
      const toggle = el('button', 'btn text-sm', entry.enabled ? 'Disable' : 'Enable'); toggle.type = 'button';
      toggle.setAttribute('aria-label', `${entry.enabled ? 'Disable' : 'Enable'} ${entry.name}`);
      toggle.addEventListener('click', () => void run('toggle', { id: entry.id, enabled: !entry.enabled }));
      const remove = el('button', 'btn text-sm', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${entry.name}`);
      remove.addEventListener('click', () => void run('remove', { id: entry.id }));
      controls.append(toggle);
      if (entry.popup && entry.enabled) {
        const settings = el('button', 'btn text-sm', 'Settings'); settings.type = 'button';
        settings.setAttribute('aria-label', `Settings for ${entry.name}`);
        settings.addEventListener('click', () => void run('open', { id: entry.id })); controls.append(settings);
      }
      controls.append(remove); row.append(controls); list.append(row);
    }
    if (!result.extensions.length) list.append(el('p', 'text-sm', 'No extensions installed.'));
  };
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const selected = file.files?.[0]; file.value = '';
    if (selected && selected.size > 10 * 1024 * 1024) status.textContent = 'Extension ZIP must be at most 10 MB';
    else if (selected) void run('install', selected);
  });
  restart.addEventListener('click', () => void run('restart', { dsf: browserScale(devicePixelRatio) }));
  glaze.addEventListener('click', () => void run('glaze'));
  try { await refresh(); } catch (error) { status.textContent = String(error); }
}

function build(w: WardInstance): Mount {
  const root = el('div', 'bw flex h-full w-full min-h-0 flex-col gap-1');
  const bar = el('form', 'flex items-center gap-1');
  bar.addEventListener('submit', (e) => e.preventDefault());
  const url = el('input', 'input min-h-0 min-w-0 flex-1 px-2 py-0.5 text-xs');
  url.type = 'text';
  url.placeholder = 'https://…';
  url.autocomplete = 'off';
  url.spellcheck = false;
  url.setAttribute('aria-label', 'Address');
  const tabs = el('div', 'bw-tabs');
  tabs.hidden = true;
  const expand = el('button', 'btn min-h-0 shrink-0 px-1.5 py-0.5 text-xs');
  expand.append(icon('resize'));
  expand.type = 'button';
  expand.title = 'Expand';
  expand.setAttribute('aria-label', 'Expand');
  const view = el('div', 'bw-view');
  const canvas = el('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Remote browser — click to focus, then type');
  const toast = el('div', 'bw-toast');
  toast.hidden = true;
  view.append(canvas, toast);

  const m: Mount = {
    w,
    source: browserSource(w),
    root,
    view,
    canvas,
    // Opaque, and free to skip a vsync of compositor sync: the frame is the whole picture.
    ctx: canvas.getContext('2d', { alpha: false, desynchronized: true })!,
    url,
    expand,
    tabs,
    toast,
    visible: false,
    epoch: 0,
    mode: 'ws',
    wsEpoch: 0,
    wsRefused: 0,
    hello: false,
    ready: false,
    dsf: 1,
    queue: [],
    moveIdx: -1,
    held: new Set(),
    buttons: new Set(),
    submittedKeys: new Set(),
    submittedButtons: new Set(),
    decoding: false,
    ro: new ResizeObserver(() => scheduleResize(m)),
    io: new IntersectionObserver((entries) => {
      m.visible = entries.some((x) => x.isIntersecting);
      if (m.visible) connect(m);
      else disconnect(m);
    }),
  };

  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const href = normalizeUrl(url.value);
      if (href) push(m, { t: 'goto', url: href }, true);
      canvas.focus();
    } else if (e.key === 'Escape') canvas.focus();
  });
  url.addEventListener('focus', () => url.select());
  expand.addEventListener('click', () => openDialog(m));
  const downloads = el('button', 'btn min-h-0 shrink-0 px-1.5 py-0.5 text-xs');
  downloads.type = 'button'; downloads.title = 'Downloads'; downloads.setAttribute('aria-label', 'Downloads');
  downloads.append(icon('download'));
  downloads.addEventListener('click', event => { event.stopPropagation(); void showDownloads(m, downloads); });
  const extensions = el('button', 'btn min-h-0 shrink-0 px-1.5 py-0.5 text-xs');
  extensions.type = 'button'; extensions.title = 'Extensions'; extensions.setAttribute('aria-label', 'Extensions');
  extensions.append(icon('puzzle'));
  extensions.addEventListener('click', () => void showExtensions(m));
  restoreExpandedWard(w.i, () => openDialog(m));
  bar.append(
    navButton(m, '◀', 'Back', { t: 'back' }),
    navButton(m, '▶', 'Forward', { t: 'forward' }),
    navButton(m, '⟳', 'Reload', { t: 'reload' }),
    url,
    navButton(m, '＋', 'New tab', { t: 'newtab' }),
    downloads,
    extensions,
    expand
  );
  root.append(bar, tabs, view);
  wireInput(m);
  m.ro.observe(view);
  m.io.observe(view);
  return m;
}

function scheduleResize(m: Mount): void {
  if (m.stopped) return;
  if (m.resizeT) clearTimeout(m.resizeT);
  m.resizeT = setTimeout(() => {
    const w = Math.round(m.view.clientWidth);
    const h = Math.round(m.view.clientHeight);
    // The server's scale is fixed at launch; the in-app driver follows this display.
    if (w > 0 && h > 0) push(m, m.driver ? { t: 'resize', w, h, dsf: browserScale(devicePixelRatio) } : { t: 'resize', w, h });
  }, 150);
}

function destroy(m: Mount): void {
  m.stopped = true;
  disconnect(m);
  m.ro.disconnect();
  m.io.disconnect();
  if (m.flushT) clearTimeout(m.flushT);
  if (m.resizeT) clearTimeout(m.resizeT);
  if (m.toastT) clearTimeout(m.toastT);
  m.queue = [];
  m.root.remove();
  mounts.delete(m.w.i);
}

// ---------------------------------------------------------- shared dialog

let dialogMount: Mount | null = null;

function dialog(): HTMLDialogElement | null {
  const dlg = document.getElementById('browser-dialog') as (HTMLDialogElement & { __bw?: true }) | null;
  if (!dlg || dlg.__bw) return dlg;
  dlg.__bw = true;
  dlg.querySelector('[data-bw-close]')?.addEventListener('click', () => dlg.close());
  // Escape belongs to the page (menus, modals inside it); the ✕ closes this.
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.addEventListener('close', () => {
    const m = dialogMount;
    dialogMount = null;
    expandedDesktopWard();
    if (!m) return;
    m.expand.hidden = false;
    const home = body(m.w.i);
    if (home) home.append(m.root); // the ResizeObserver shrinks the viewport back
    else destroy(m); // the ward left while the dialog was open
  });
  return dlg;
}

function openDialog(m: Mount): void {
  const dlg = dialog();
  if (!dlg) return;
  if (dialogMount === m && dlg.open) return;
  if (dialogMount && dialogMount !== m) {
    const previous = dialogMount;
    previous.expand.hidden = false;
    const home = body(previous.w.i);
    if (home) home.append(previous.root); else destroy(previous);
  }
  dialogMount = m;
  expandedDesktopWard(m.w.i);
  const title = document.querySelector(`[data-wd="${m.w.i}"] [data-wd-title]`)?.textContent ?? 'Browser';
  dlg.querySelector('[data-bw-title]')!.textContent = title;
  m.expand.hidden = true; // the dialog's ✕ is the way out
  dlg.querySelector('[data-bw-host]')!.append(m.root);
  if (!dlg.open) dlg.showModal();
  m.canvas.focus();
}

// -------------------------------------------------------------- renderer

function renderBrowser(w: WardInstance): void {
  const b = body(w.i);
  if (!b) return;
  const old = mounts.get(w.i);
  if (old && old.source === browserSource(w)) {
    old.w = w;
    if (dialogMount !== old && old.root.parentElement !== b) b.append(old.root);
    if (dialogMount === old) {
      const title = document.querySelector(`[data-wd="${w.i}"] [data-wd-title]`)?.textContent ?? 'Browser';
      dialog()?.querySelector('[data-bw-title]')?.replaceChildren(document.createTextNode(title));
    }
    scheduleResize(old);
    connect(old);
    return;
  }
  const expanded = old && dialogMount === old;
  if (expanded) dialogMount = null;
  if (old) destroy(old);
  b.textContent = '';
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
  const m = build(w);
  mounts.set(w.i, m);
  b.append(m.root);
  if (expanded) openDialog(m);
}

document.addEventListener('fd:layout-saved', () => {
  for (const m of mounts.values()) connect(m);
});
document.addEventListener('visibilitychange', () => {
  for (const m of mounts.values()) if (document.hidden) disconnect(m); else connect(m);
});
window.addEventListener('blur', () => {
  for (const m of mounts.values()) if (document.activeElement === m.canvas) m.canvas.blur();
});

RENDERERS.browser = { preserveBody: true, render: renderBrowser, stop: id => { const m = mounts.get(id); if (m) destroy(m); } }; // event-driven — no poll
