import { expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
// The browser ward: a live view of a real Chromium session the server runs for
// this ward (lib/browser/session.ts), driven from here by the human and from
// Rime's tools by the agent — one session, two drivers. Frames arrive over SSE
// as jpeg; input goes back as batched commands. The remote viewport follows
// the surface it is shown on — the ward, or the shared expand dialog the SAME
// element moves into — 1:1 CSS pixels, so what you see is what you click.
//
// Inside the Rimeward app, a "My computer" ward's Chromium is on this very
// machine: the same UI then drives it directly over CDP (browser-cdp.ts) —
// same events, same commands, no server in the loop for frames or input.

import { RENDERERS, body } from './wards.ts';
import { el, normalizeUrl, postJson } from './dom.ts';
import { icon } from './icon.ts';
import { LocalDriver, type Transport } from './browser-cdp.ts';
import type { BrowserConfig, WardInstance } from '../../lib/wards.ts';
import type { BrowserEvent, Cmd } from '../../lib/browser/session.ts';

type Tabs = Extract<BrowserEvent, { type: 'tabs' }>;

interface Mount {
  w: WardInstance;
  /** Nav bar + tab strip + view. Moves between the ward body and the dialog. */
  root: HTMLElement;
  view: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  url: HTMLInputElement;
  expand: HTMLButtonElement;
  tabs: HTMLElement;
  toast: HTMLElement;
  es?: EventSource;
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
  pendingFrame?: string;
  toastT?: ReturnType<typeof setTimeout>;
  ro: ResizeObserver;
  io: IntersectionObserver;
}

const mounts = new Map<string, Mount>();
const editing = () => document.getElementById('wd-grid')?.classList.contains('editing') ?? false;

// ------------------------------------------------------------------ stream

function connect(m: Mount): void {
  if (m.stopped || m.closing || m.es || m.driver || m.opening || !m.visible || document.hidden) return;
  if (isLocal(m)) return void connectLocal(m);
  const es = new EventSource(`/api/browser/stream/${m.w.i}`);
  m.es = es;
  // (Re)connected: the remote viewport must match THIS surface — the size sent
  // at mount may have landed before the ward was saved, or on a browser since
  // closed and relaunched at the default.
  es.onopen = () => { if (m.es === es) scheduleResize(m); };
  for (const type of ['frame', 'nav', 'tabs', 'dialog', 'route'] as const) {
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

function disconnect(m: Mount): void {
  if (m.closing) return;
  m.epoch++;
  m.opening = false;
  m.es?.close();
  m.es = undefined;
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
    info = (await tauri()!.core.invoke('ward_browser', { ward: m.w.i })) as { ws: string; platform: string };
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

async function onFrame(m: Mount, f: Extract<BrowserEvent, { type: 'frame' }>): Promise<void> {
  if (m.decoding) {
    m.pendingFrame = f.data; // latest wins — decoding never queues
    return;
  }
  m.decoding = true;
  try {
    let data: string | undefined = f.data;
    while (data) {
      const blob = await (await fetch('data:image/jpeg;base64,' + data)).blob();
      const bmp = await createImageBitmap(blob);
      if (m.canvas.width !== bmp.width || m.canvas.height !== bmp.height) {
        m.canvas.width = bmp.width;
        m.canvas.height = bmp.height;
      }
      m.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      data = m.pendingFrame;
      m.pendingFrame = undefined;
    }
  } catch {
    /* a torn frame — the next one repaints */
  } finally {
    m.decoding = false;
  }
}

// ------------------------------------------------------------------- input

function push(m: Mount, c: Cmd, urgent = false): void {
  if (m.stopped || m.closing) return;
  if (c.t === 'move') {
    // Coalesce: only the latest position matters.
    if (m.moveIdx >= 0) m.queue[m.moveIdx] = c;
    else m.moveIdx = m.queue.push(c) - 1;
  } else m.queue.push(c);
  if (urgent) void flush(m);
  else if (!m.flushT) m.flushT = setTimeout(() => void flush(m), 40);
}

/** One batch in flight at a time — ordering is the whole point of a batch. */
async function flush(m: Mount): Promise<void> {
  if (m.flushT) clearTimeout(m.flushT);
  m.flushT = undefined;
  if (m.inflight) return m.inflight;
  if (!m.queue.length || m.closing || m.stopped) return;
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

/** Canvas pixel → remote viewport CSS px. The canvas is object-fit:contain,
 *  so the drawn frame may be letterboxed inside it. */
function toPage(m: Mount, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = m.canvas.getBoundingClientRect();
  const cw = m.canvas.width || 1;
  const ch = m.canvas.height || 1;
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
    root,
    view,
    canvas,
    ctx: canvas.getContext('2d')!,
    url,
    expand,
    tabs,
    toast,
    visible: false,
    epoch: 0,
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
  restoreExpandedWard(w.i, () => openDialog(m));
  bar.append(
    navButton(m, '◀', 'Back', { t: 'back' }),
    navButton(m, '▶', 'Forward', { t: 'forward' }),
    navButton(m, '⟳', 'Reload', { t: 'reload' }),
    url,
    navButton(m, '＋', 'New tab', { t: 'newtab' }),
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
    if (w > 0 && h > 0) push(m, { t: 'resize', w, h });
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
  if (dialogMount) dlg.close();
  dialogMount = m;
  expandedDesktopWard(m.w.i);
  const title = document.querySelector(`[data-wd="${m.w.i}"] [data-wd-title]`)?.textContent ?? 'Browser';
  dlg.querySelector('[data-bw-title]')!.textContent = title;
  m.expand.hidden = true; // the dialog's ✕ is the way out
  dlg.querySelector('[data-bw-host]')!.append(m.root);
  dlg.showModal();
  m.canvas.focus();
}

// -------------------------------------------------------------- renderer

function renderBrowser(w: WardInstance): void {
  const b = body(w.i);
  if (!b) return;
  const old = mounts.get(w.i);
  if (old) destroy(old);
  b.textContent = '';
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
  const m = build(w);
  mounts.set(w.i, m);
  b.append(m.root);
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

RENDERERS.browser = { render: renderBrowser, stop: id => { const m = mounts.get(id); if (m) destroy(m); } }; // event-driven — no poll
