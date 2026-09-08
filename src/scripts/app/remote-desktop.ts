// The Remote Desktop ward: one compact icon toolbar over a viewport that fills
// the card, popovers for the secondary controls, an expand dialog shared by
// every instance (the SAME element moves — one stream, one canvas) and true
// fullscreen on the ward root. Input rules never soften here: viewing starts
// view-only, a hidden or blurred viewer releases control, and the wire
// protocol is exactly the one src/lib/dev/remote-desktop.ts speaks.
import { expandedDesktopWard, restoreExpandedWard } from './desktop-state.ts';
import { RENDERERS, body, readLayout } from './wards.ts';
import { el, toast } from './dom.ts';
import { icon } from './icon.ts';
import { menuItem } from './menu.ts';
import type { WardInstance } from '../../lib/wards.ts';
import type { DeviceCapabilities, RemoteController, RemoteDisplay } from '../../lib/dev/remote-desktop-contract.ts';
import '../../styles/remote-desktop.css';
import { remoteFiles } from './remote-files.ts';
import { remoteMedia } from './remote-media.ts';
import { MODS, type Mod, modLabel, platformOf, press, sequences, wireInput, type RemoteEvent } from './remote-input.ts';

const mounts = new Map<string, () => void>();
const base = '/api/remote-desktop/';
async function request(path: string, value?: unknown, method = 'POST', signal?: AbortSignal) {
  const response = await fetch(base + path, { method: value === undefined ? 'GET' : method, cache: 'no-store', signal,
    ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(response.status === 404 ? error.error ?? 'Computer unavailable. Update the host app if needed.' : error.error ?? `Connection failed (${response.status}).`);
  }
  return response;
}
interface Device { id: string; name: string; platform: string; online: boolean; remoteDesktop?: number }
type Ctl = 'view' | 'you' | 'other' | 'rime';
const CTL: Record<Ctl, string> = { view: 'View-only', you: 'You control', other: 'Another viewer controls', rime: 'Rime controls' };
const QUALITY: Record<string, string> = { saver: 'Bandwidth saver', auto: 'Auto', sharp: 'Sharp' };
const SCALING: Record<string, string> = { fit: 'Fit', fill: 'Fill', actual: 'Actual size' };

// ---- popovers live INSIDE the ward root: the expand dialog is modal (the rest
// of the page is inert) and fullscreen paints only the fullscreen element; the
// top layer lifts them over the card's overflow either way.
let popClosed = { at: 0, anchor: null as HTMLElement | null };
function showPop(host: HTMLElement, anchor: HTMLElement, panel: HTMLElement, transient: boolean): boolean {
  if (popClosed.anchor === anchor && Date.now() - popClosed.at < 300) return false; // the click that light-dismissed it
  if (!panel.isConnected) host.append(panel);
  panel.popover = 'auto'; panel.classList.add('rd-pop');
  const onToggle = (e: Event) => {
    if ((e as ToggleEvent).newState !== 'closed') return;
    popClosed = { at: Date.now(), anchor }; panel.removeEventListener('toggle', onToggle);
    if (transient) panel.remove();
  };
  panel.addEventListener('toggle', onToggle);
  panel.showPopover();
  const r = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - p.width - 8))}px`;
  panel.style.top = `${r.bottom + 4 + p.height <= innerHeight ? r.bottom + 4 : Math.max(8, r.top - p.height - 4)}px`;
  return true;
}
const hidePop = (panel: HTMLElement) => { if (panel.matches(':popover-open')) panel.hidePopover(); };
const swapIcon = (b: HTMLElement, id: string) => b.firstChild?.replaceWith(icon(id));
const button = (id: string, label: string, cls = 'btn rd-b') => {
  const b = el('button', cls); b.type = 'button'; b.append(icon(id)); b.title = label; b.setAttribute('aria-label', label); return b;
};

// ---- the shared expand dialog (RemoteDesktopDialog.astro), exactly the browser ward's
let dialogMount: { root: HTMLElement; home: () => void } | null = null;
function dialog(): HTMLDialogElement | null {
  const dlg = document.getElementById('remote-desktop-dialog') as (HTMLDialogElement & { __rd?: true }) | null;
  if (!dlg || dlg.__rd) return dlg;
  dlg.__rd = true;
  dlg.querySelector('[data-rd-close]')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('form')?.addEventListener('submit', e => e.preventDefault());
  // Keep Escape available to the remote computer only while controlling.
  dlg.addEventListener('cancel', e => { if (dlg.querySelector('.rd-stage[data-ctl="you"]')) e.preventDefault(); });
  dlg.addEventListener('close', () => { if (dlg.open) return; const m = dialogMount; dialogMount = null; expandedDesktopWard(); m?.home(); });
  return dlg;
}

function render(w: WardInstance) {
  mounts.get(w.i)?.();
  const container = body(w.i); if (!container) return;
  container.classList.add('flex'); container.classList.remove('overflow-y-auto');
  // ---- DOM
  const root = el('div', 'rd-root'), bar = el('div', 'rd-bar'), stage = el('div', 'rd-stage'), viewport = el('div', 'rd-viewport'), frame = el('div', 'rd-frame');
  const canvas = el('canvas', 'rd-screen'), video = el('video', 'rd-video');
  video.autoplay = true; video.playsInline = true; video.muted = true; video.hidden = true;
  canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Remote desktop. Take control before using the keyboard or pointer.');
  const context = canvas.getContext('2d'); if (!context) return;
  const catcher = el('textarea', 'rd-key'); catcher.tabIndex = -1; catcher.autocapitalize = 'off'; catcher.autocomplete = 'off'; catcher.spellcheck = false;
  catcher.setAttribute('autocorrect', 'off'); catcher.setAttribute('aria-label', 'Keyboard input for the remote computer');
  const cursor = el('div', 'rd-cursor'); cursor.hidden = true;
  const stats = el('div', 'rd-stats'); stats.hidden = w.config?.diagnostics !== true;
  const mods = el('div', 'rd-mods'); mods.hidden = true;
  const veil = el('div', 'rd-veil'), veilText = el('p', 'rd-veil-text'); veilText.setAttribute('role', 'status'); veilText.setAttribute('aria-live', 'polite');
  const empty = el('div', 'rd-empty'), emptyHead = el('div', 'rd-empty-head'), emptyTitle = el('span', undefined, 'Remote Desktop');
  const picker = el('select', 'input'); picker.setAttribute('aria-label', 'Computer'); picker.append(new Option('Choose a computer', ''));
  const connect = el('button', 'btn-primary', 'Connect'); connect.type = 'button';
  const message = el('p', 'rd-msg'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  emptyHead.append(icon('host'), emptyTitle); empty.append(emptyHead, picker, connect, message);
  veil.append(el('span', 'spinner'), veilText, empty);
  frame.append(video, canvas); viewport.append(frame); stage.append(viewport, cursor, stats, mods, veil, catcher);
  const drawer = el('div', 'rd-drawer');
  root.append(bar, stage, drawer); container.replaceChildren(root);
  const header = document.querySelector<HTMLElement>(`[data-wd="${w.i}"] .wd-status`);
  // ---- state
  let session = '', ack = 0, sequence = 0, ownership: number | undefined, topology = 0, display = 0;
  let stopped = false, visible = true, pending = false, otherHuman = false, rimeHas = false, requestBusy = false, frameBusy = false, connecting = false, dropped = false;
  let timer: ReturnType<typeof setTimeout> | undefined, hiddenTimer: ReturnType<typeof setTimeout> | undefined, barTimer: ReturnType<typeof setTimeout> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined, inputBusy = false;
  let paused = false, detached = false, acquiring = false, controlRevision = 0, viewRevision = 0;
  let visibilityWork = Promise.resolve();
  let queue: RemoteEvent[] = [];
  let lastClipboard = '', syncingClipboard = false, clipboardRevision = 0, controllerId = '';
  let preferWebRTC = false, listening = false, turn = false, quality = String(w.config?.quality ?? 'auto');
  let allowInput = false, allowRime = false, allowText = false;
  let features: Record<string, boolean> = {}, displays: RemoteDisplay[] = [], devices: Device[] = [];
  let scaling = ['fill', 'actual'].includes(String(w.config?.view)) ? String(w.config?.view) : 'fit', zoom = 1, touchpad = false, pinned = false;
  let fps = 0, cFrames = 0, cBytes = 0, cRtt = 0, lastBytes = 0, statAt = performance.now();
  const sticky = new Set<Mod>();
  const coarse = matchMedia('(pointer: coarse)').matches;
  const abort = new AbortController();
  const platform = () => platformOf(devices.find(d => d.id === w.device)?.platform);
  const fullscreen = () => document.fullscreenElement === root;
  const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
  const report = (error: unknown) => {
    if (stopped) return;
    const text = error instanceof Error ? error.message : String(error);
    if (session) toast(text, undefined, true); else message.textContent = text;
  };
  // ---- input plumbing (the queue keeps the coalescing, 16 ms flush, 128 cap and release-on-error rules)
  const flush = async () => {
    if (inputBusy || ownership === undefined || paused || !queue.length) return;
    const events = queue, current = session, generation = ownership; queue = []; inputBusy = true;
    try {
      const batch = { ownership, topology, sequence: ++sequence, display, events };
      if (!preferWebRTC || !media.send(batch)) await action('input', batch);
    } catch (error) { if (current === session && generation === ownership) { await release(); report(error); } }
    finally { inputBusy = false; if (queue.length) void flush(); }
  };
  const send = (events: RemoteEvent[]) => {
    if (ownership === undefined || paused || !visible || document.hidden) return;
    for (const event of events) {
      if (queue.length >= 128) { void release(); report('Input queue full. Take control again.'); return; }
      if (event.type === 'move' && queue.at(-1)?.type === 'move') queue[queue.length - 1] = event;
      else queue.push(event);
    }
    clearTimeout(inputTimer); inputTimer = setTimeout(() => void flush(), 16);
  };
  const input = wireInput({
    canvas, frame, catcher, cursor, send, sticky, coarse,
    controlling: () => ownership !== undefined, textOK: () => allowText, touchpad: () => touchpad,
    stickyChanged: () => paint(), fullscreenKey: () => toggleFs(), cancelled: () => void release(),
    scrollUnit: () => viewport.clientHeight / 40,
    blurred: () => {
      queue = []; clearTimeout(inputTimer); controlRevision++;
      if (ownership !== undefined) void action('clear', { ownership, topology, sequence: ++sequence }).catch(error => { void release(); report(error); });
    },
  });
  // ---- layout
  const fit = () => {
    const cw = canvas.width || 1, ch = canvas.height || 1, vw = viewport.clientWidth, vh = viewport.clientHeight;
    const s = scaling === 'actual' ? zoom : scaling === 'fill' ? Math.max(vw / cw, vh / ch) : Math.min(vw / cw, vh / ch);
    frame.style.width = `${Math.max(1, Math.round(cw * s))}px`; frame.style.height = `${Math.max(1, Math.round(ch * s))}px`;
    viewport.dataset.scaling = scaling; input.drawCursor();
  };
  const resize = new ResizeObserver(fit); resize.observe(viewport);
  // ---- toolbar
  interface Control { b: HTMLButtonElement; icon: () => string; label: () => string; run: (anchor: HTMLElement) => void; on?: () => boolean; reason?: () => string; pressed?: () => boolean; hide?: () => boolean }
  const controls: Control[] = [];
  const control = (c: Omit<Control, 'b'>) => { const b = button(c.icon(), c.label()); b.onclick = () => c.run(b); controls.push({ ...c, b }); return b; };
  const primary = el('button', 'btn rd-b rd-primary'); primary.type = 'button';
  const primaryLabel = el('span'); primary.append(icon('mouse'), primaryLabel);
  const expand = button('resize', 'Expand'), fs = button('fullscreen', 'Fullscreen'), pill = el('span', 'rd-pill');
  const more = button('more', 'More'), pin = button('pin', 'Pin toolbar'), disconnectButton = button('stop', 'Disconnect');
  pill.hidden = true; pill.ondblclick = () => toggleFs();
  const menu = (anchor: HTMLElement, build: (m: HTMLElement, close: () => void) => void) => {
    const m = el('div', 'ctx-menu'); m.setAttribute('role', 'menu');
    const close = () => hidePop(m);
    build(m, close);
    if (showPop(root, anchor, m, true)) m.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  };
  const item = (m: HTMLElement, close: () => void, id: string, label: string, fn: () => void, disabled = false) => {
    const b = menuItem(id, label, () => { close(); fn(); }) as HTMLButtonElement; b.setAttribute('aria-label', label); b.disabled = disabled; m.append(b); return b;
  };
  /** A menu row that stays open and repaints its check mark. */
  const toggleItem = (m: HTMLElement, label: string, get: () => boolean, set: () => void) => {
    const b = menuItem(get() ? 'check' : 'square', label, () => { set(); swapIcon(b, get() ? 'check' : 'square'); b.setAttribute('aria-checked', String(get())); });
    b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-label', label);
    b.setAttribute('aria-checked', String(get())); m.append(b); return b;
  };
  const refocus = () => { if (ownership !== undefined && !coarse) catcher.focus({ preventScroll: true }); };
  const restartMedia = async () => {
    const current = session;
    try {
      await release();
      if (!current || current !== session || stopped || paused) return;
      media.stop(); await action('media', { command: 'stop' });
      if (current === session) await startMedia();
    } catch (error) { if (current === session) report(error); }
  };
  // clipboard panel (persistent — its text survives closing)
  const clip = el('div', 'rd-panel'), clipboardText = el('textarea', 'input'), clipRow = el('div', 'rd-row');
  clipboardText.setAttribute('aria-label', 'Clipboard text'); clipboardText.maxLength = 1024 * 1024; clipboardText.placeholder = 'Text to exchange with the remote clipboard';
  const clipboardSend = el('button', 'btn', 'Send text'), clipboardReceive = el('button', 'btn', 'Receive text'), pngSend = el('button', 'btn', 'Send PNG'), pngReceive = el('button', 'btn', 'Receive PNG');
  const syncLabel = el('label', 'switch'), syncText = el('input'); syncText.type = 'checkbox';
  syncLabel.append(syncText, document.createTextNode('Sync text while I control and this viewer is focused'));
  for (const b of [clipboardSend, clipboardReceive, pngSend, pngReceive]) b.type = 'button';
  clipRow.append(clipboardSend, clipboardReceive, pngSend, pngReceive); clip.append(el('div', 'rd-panel-title', 'Clipboard'), clipboardText, clipRow, syncLabel);
  // audio panel
  const audioPanel = el('div', 'rd-panel'), listenLabel = el('label', 'switch'), listen = el('input'); listen.type = 'checkbox';
  listenLabel.append(listen, document.createTextNode('Listen to the computer’s audio'));
  const volumeLabel = el('label', 'rd-range'), volume = el('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.value = '100'; volume.setAttribute('aria-label', 'Remote audio volume');
  volumeLabel.append(icon('volume'), volume); audioPanel.append(el('div', 'rd-panel-title', 'Audio'), listenLabel, volumeLabel);
  volume.oninput = () => { video.volume = Number(volume.value) / 100; };
  listen.onchange = () => { listening = listen.checked; paint(); void restartMedia(); };
  const zoomLabel = el('label', 'rd-range'), zoomRange = el('input'); zoomRange.type = 'range'; zoomRange.min = '50'; zoomRange.max = '200'; zoomRange.step = '10'; zoomRange.value = '100'; zoomRange.setAttribute('aria-label', 'Zoom');
  const zoomValue = el('span', undefined, '100%'); zoomLabel.append(icon('search'), zoomRange, zoomValue);
  zoomRange.oninput = () => { zoom = Number(zoomRange.value) / 100; zoomValue.textContent = `${zoomRange.value}%`; fit(); };
  bar.append(primary, expand, fs, el('span', 'rd-spacer'), pill);
  control({ icon: () => 'monitor', label: () => 'Monitor', hide: () => !session || displays.length < 2, run: anchor => menu(anchor, (m, close) => {
    for (const d of displays) item(m, close, d.display === display ? 'check' : 'monitor', `${d.name ?? `Display ${d.display}`} · ${d.width}×${d.height}`, () => {
      viewRevision++; display = d.display; media.stop();
      void release().then(() => action('monitor', { display })).then(async () => { ack = 0; await startMedia(); }).catch(report);
    });
  }) });
  control({ icon: () => 'scaling', label: () => 'Scaling', hide: () => !session, run: anchor => menu(anchor, m => {
    const rows = Object.keys(SCALING).map(mode => toggleItem(m, SCALING[mode], () => scaling === mode, () => {
      scaling = mode; zoomRange.disabled = mode !== 'actual'; fit();
      for (const [i, other] of Object.keys(SCALING).entries()) { swapIcon(rows[i], scaling === other ? 'check' : 'square'); rows[i].setAttribute('aria-checked', String(scaling === other)); }
    }));
    zoomRange.disabled = scaling !== 'actual'; m.append(zoomLabel);
  }) });
  control({ icon: () => 'quality', label: () => 'Quality', hide: () => !session, run: anchor => menu(anchor, (m, close) => {
    for (const q of Object.keys(QUALITY)) item(m, close, q === quality ? 'check' : 'quality', QUALITY[q], () => {
      quality = q; if (preferWebRTC) void restartMedia();
    });
  }) });
  control({ icon: () => listening ? 'volume' : 'volume-off', label: () => 'Audio', hide: () => !session, pressed: () => listening,
    on: () => !!features.audio && preferWebRTC, reason: () => preferWebRTC ? 'System audio unavailable on this host' : 'Audio is unavailable in Compatibility mode',
    run: anchor => { listen.checked = listening; showPop(root, anchor, audioPanel, false); } });
  control({ icon: () => 'keyboard', label: () => 'Keys', hide: () => !session, on: () => ownership !== undefined, reason: () => 'Take control first', run: anchor => menu(anchor, (m, close) => {
    if (coarse) item(m, close, 'keyboard', 'Show keyboard', () => catcher.focus());
    for (const mod of Object.keys(MODS) as Mod[]) toggleItem(m, `Hold ${modLabel(mod, platform())}`, () => sticky.has(mod), () => { if (!sticky.delete(mod)) sticky.add(mod); paint(); });
    for (const s of sequences(platform())) item(m, close, 'keyboard', s.label, () => { send(press(s.keys)); refocus(); });
  }) });
  control({ icon: () => 'touchpad', label: () => 'Touchpad mode', hide: () => !session || !coarse, pressed: () => touchpad, run: () => { touchpad = !touchpad; input.resetCursor(); paint(); } });
  control({ icon: () => 'clipboard', label: () => 'Clipboard', hide: () => !session, on: () => !!features.clipboard, reason: () => 'Clipboard unavailable on this host', run: anchor => showPop(root, anchor, clip, false) });
  control({ icon: () => 'folders', label: () => 'Files', hide: () => !session, on: () => !!features.files, reason: () => 'File transfers unavailable on this host', run: () => transfer.open() });
  control({ icon: () => 'bot', label: () => 'Give control to Rime', hide: () => !session, on: () => allowRime && !pending, reason: () => 'Rime input is disabled or requires host OS permission', run: anchor => menu(anchor, (m, close) => {
    const agents = readLayout().filter(x => x.type === 'agent');
    if (!agents.length) item(m, close, 'bot', 'No Rime ward on this dashboard', () => {}, true);
    for (const agent of agents) item(m, close, 'bot', agent.title ?? `Rime · ${agent.i}`, () => {
      void action('rime', { ward: agent.i }).then(() => {
        ownership = undefined; controlRevision++; input.reset(); sticky.clear(); queue = []; syncText.checked = false; lastClipboard = ''; clipboardRevision++; clipboardText.value = ''; paint();
        toast('Rime controls. No task was sent; enter your task in the Rime ward.');
      }).catch(report);
    });
  }) });
  control({ icon: () => 'gauge', label: () => 'Stats', hide: () => !session, pressed: () => !stats.hidden, run: () => { stats.hidden = !stats.hidden; paint(); } });
  for (const c of controls) bar.append(c.b);
  bar.append(more, pin, disconnectButton);
  let overflowed: Control[] = [];
  more.onclick = () => menu(more, (m, close) => {
    for (const c of overflowed) item(m, close, c.icon(), c.label(), () => c.run(more), c.on ? !c.on() : false);
  });
  const fitBar = () => {
    for (const c of controls) c.b.hidden = c.hide?.() ?? false;
    more.hidden = true; overflowed = [];
    const shown = controls.filter(c => !c.b.hidden);
    while (bar.scrollWidth > bar.clientWidth + 1) { const c = shown.pop(); if (!c) break; c.b.hidden = true; overflowed.unshift(c); more.hidden = false; }
  };
  const barResize = new ResizeObserver(fitBar); barResize.observe(bar);
  // sticky modifier row for touch
  const modButtons = (Object.keys(MODS) as Mod[]).map(mod => {
    const b = el('button', 'btn rd-mod'); b.type = 'button';
    b.onclick = () => { if (!sticky.delete(mod)) sticky.add(mod); paint(); refocus(); };
    mods.append(b); return [mod, b] as const;
  });
  // ---- paint: one writer for every label, state and the header's status slot
  const paint = () => {
    const ctl: Ctl = ownership !== undefined ? 'you' : rimeHas ? 'rime' : otherHuman ? 'other' : 'view';
    const transport = pending ? 'Awaiting approval' : preferWebRTC ? media.connected() ? turn ? 'TURN' : 'WebRTC' : 'Connecting media' : 'Compatibility';
    const text = session ? [transport, CTL[ctl], fps ? `${fps} fps` : ''].filter(Boolean).join(' · ') : '';
    pill.textContent = text; pill.title = `${text}${session ? ' — double-click for fullscreen' : ''}`; pill.hidden = !session; pill.dataset.ctl = ctl; stage.dataset.ctl = ctl;
    if (header) header.textContent = text;
    stage.dataset.state = session ? pending ? 'pending' : preferWebRTC && video.hidden ? 'media' : 'live' : connecting ? 'connecting' : dropped ? 'dropped' : 'empty';
    veilText.textContent = pending ? 'Approve this connection on the host Connections page.' : connecting ? 'Connecting…' : stage.dataset.state === 'media' ? 'Negotiating media…' : '';
    emptyTitle.textContent = dropped ? 'Connection dropped' : 'Remote Desktop'; connect.textContent = dropped ? 'Reconnect' : 'Connect';
    const label = ownership !== undefined ? 'Release control' : otherHuman ? 'Take over' : 'Take control';
    primaryLabel.textContent = label; primary.setAttribute('aria-label', label); primary.hidden = !session;
    primary.disabled = !session || pending || paused || acquiring || !allowInput; primary.title = allowInput ? label : 'Input is disabled or requires host OS permission';
    swapIcon(primary, ownership !== undefined ? 'stop' : 'mouse');
    expand.hidden = dialogMount?.root === root || fullscreen();
    swapIcon(fs, fullscreen() ? 'fullscreen-exit' : 'fullscreen');
    fs.title = fs.ariaLabel = fullscreen() ? 'Exit fullscreen' : typeof root.requestFullscreen === 'function' ? 'Fullscreen' : 'Fullscreen is unavailable in this browser';
    fs.disabled = typeof root.requestFullscreen !== 'function';
    pin.hidden = !fullscreen(); pin.setAttribute('aria-pressed', String(pinned)); pin.title = pin.ariaLabel = pinned ? 'Unpin toolbar' : 'Pin toolbar';
    disconnectButton.hidden = !session;
    for (const c of controls) {
      swapIcon(c.b, c.icon());
      const on = c.on?.() ?? true; c.b.disabled = !on; c.b.title = on ? c.label() : `${c.label()} — ${c.reason?.() ?? 'unavailable'}`; c.b.setAttribute('aria-label', c.label());
      if (c.pressed) c.b.setAttribute('aria-pressed', String(c.pressed()));
    }
    mods.hidden = !(coarse && ownership !== undefined);
    for (const [mod, b] of modButtons) { b.textContent = modLabel(mod, platform()); b.setAttribute('aria-pressed', String(sticky.has(mod))); }
    cursor.hidden = !(touchpad && ownership !== undefined);
    if (kb?.lock) { if (ownership !== undefined && fullscreen()) kb.lock().catch(() => {}); else kb.unlock?.(); }
    fitBar();
  };
  // ---- session
  const action = async (name: string, value: Record<string, unknown> = {}) => {
    if (!session) throw Error('Connect first.');
    const current = session;
    const response = await request(`sessions/${current}`, { ...value, action: name }, 'POST', abort.signal);
    if (current !== session || stopped) { await response.body?.cancel(); throw Error('Session changed; the previous operation was not replayed.'); }
    return response;
  };
  const transfer = remoteFiles(value => action('files', value), () => session, () => w.device ?? '', report);
  drawer.append(transfer.panel);
  const media = remoteMedia(video, value => action('media', value), error => {
    preferWebRTC = false; listening = false; fps = 0;
    void release(); report(`${error instanceof Error ? error.message : error} Switching to Compatibility mode; audio is unavailable.`);
    clearTimeout(timer); paint(); void loop();
  }, (capability, reason) => {
    if (capability === 'audio') { listening = false; features.audio = false; paint(); void restartMedia(); }
    report(reason);
  });
  video.onresize = video.onloadeddata = () => {
    if (!preferWebRTC) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight; context.clearRect(0, 0, canvas.width, canvas.height); fit(); paint();
  };
  video.addEventListener('playing', paint);
  const startMedia = async () => {
    if (!session || stopped || paused || !visible || document.hidden || !preferWebRTC || pending) return;
    const current = session;
    try { await media.start(quality, listening); }
    catch (error) { if (current !== session || stopped || paused || error instanceof DOMException && error.name === 'AbortError') return; preferWebRTC = false; media.stop(); await action('media', { command: 'stop' }).catch(() => {}); report(error); }
  };
  const release = async () => {
    queue = []; clearTimeout(inputTimer); sticky.clear(); controlRevision++; input.reset();
    const held = ownership; ownership = undefined; paint();
    lastClipboard = ''; syncText.checked = false; clipboardRevision++; clipboardText.value = '';
    if (held !== undefined && session) await action('release').catch(report);
  };
  /** `keep` leaves the last frame up, dimmed under a Reconnect panel (an unexpected drop). */
  const disconnect = async (keep = false) => {
    clearTimeout(timer); clearTimeout(hiddenTimer); clearTimeout(inputTimer);
    const old = session; session = ''; paused = false; detached = false; controlRevision++; input.reset(); ownership = undefined; queue = []; pending = false; otherHuman = false; rimeHas = false; sticky.clear();
    lastClipboard = ''; syncText.checked = false; clipboardRevision++; clipboardText.value = ''; hidePop(clip); hidePop(audioPanel);
    transfer.reset(); media.stop(); preferWebRTC = false; listening = false; turn = false; fps = 0; dropped = keep;
    if (!keep) context.clearRect(0, 0, canvas.width, canvas.height);
    stats.textContent = ''; catcher.value = ''; cFrames = 0; cBytes = 0; lastBytes = 0;
    paint();
    if (!stopped) void loadDevices().catch(() => {});
    if (old) await request(`sessions/${old}`, { action: 'disconnect' }).catch(() => {});
  };
  const updateControl = (controller: RemoteController | null) => {
    const nextController = controller ? `${controller.id}:${controller.generation}` : '';
    if (controllerId !== nextController) { controllerId = nextController; clipboardRevision++; clipboardText.value = ''; lastClipboard = ''; syncText.checked = false; }
    if (controller?.id !== session || controller.generation !== ownership) {
      ownership = undefined; queue = []; clearTimeout(inputTimer); sticky.clear(); input.reset();
    }
    otherHuman = !!controller && controller.kind === 'human' && controller.id !== session;
    rimeHas = controller?.kind === 'rime';
    paint();
  };
  const tickStats = async () => {
    const now = performance.now(), secs = (now - statAt) / 1000;
    if (secs < 1) return;
    statAt = now;
    if (preferWebRTC) {
      const s = await media.stats(); if (!s) return;
      turn = s.transport === 'turn'; fps = s.frames;
      const kbps = lastBytes ? Math.max(0, Math.round((s.bytes - lastBytes) * 8 / secs / 1000)) : 0; lastBytes = s.bytes;
      stats.textContent = `${turn ? 'TURN' : 'WebRTC'} · ${fps} fps · ${s.rtt} ms · ${video.videoWidth}×${video.videoHeight} · ${kbps} kbit/s`;
    } else {
      fps = Math.round(cFrames / secs);
      stats.textContent = `HTTPS relay · ${fps} fps · ${cRtt} ms · ${canvas.width}×${canvas.height} · ${Math.round(cBytes * 8 / secs / 1000)} kbit/s`;
      cFrames = 0; cBytes = 0;
    }
  };
  let lastStatus = 0;
  const loop = async () => {
    if (stopped || !session || paused || !visible || document.hidden || frameBusy) return;
    frameBusy = true;
    const current = session, revision = viewRevision;
    let wait = quality === 'saver' ? 250 : 125;
    try {
      if (Date.now() - lastStatus >= 2000) {
        const controlAtRequest = controlRevision;
        const state = await (await action('status')).json();
        if (session !== current || revision !== viewRevision || stopped || paused || !visible || document.hidden) return;
        const approved = pending && state.state !== 'pending-approval'; pending = state.state === 'pending-approval';
        if (state.features) { features = { ...state.features }; allowInput = !!features.input; allowRime = !!features.rime; }
        if (state.textInput) allowText = state.textInput.available;
        if (topology !== state.topology) {
          await release(); media.stop(); topology = state.topology; ack = 0;
          if (state.displays) { displays = state.displays; display = state.display; }
          await startMedia();
        }
        else if (approved) await startMedia();
        lastStatus = Date.now(); await tickStats();
        if (current === session && controlAtRequest === controlRevision) updateControl(state.controller);
      }
      if (!paused && visible && !document.hidden && !pending && !preferWebRTC) {
        // One request in flight; the next starts `wait` after THIS one started, not after it finished.
        const frameTopology = topology, frameDisplay = display;
        const at = performance.now(), response = await action('frame', { ack });
        if (response.status !== 204) {
          if (current === session && frameTopology === topology && frameDisplay === display && !detached) ack = Number(response.headers.get('x-rimeward-frame'));
          const blob = await response.blob(), bitmap = await createImageBitmap(blob);
          try {
            if (session !== current || revision !== viewRevision || stopped || paused || !visible || document.hidden) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; fit(); }
            context.drawImage(bitmap, 0, 0);
            cRtt = Math.round(performance.now() - at); cFrames++; cBytes += blob.size;
          } finally { bitmap.close(); }
          wait = Math.max(0, wait - (performance.now() - at));
        }
      }
    } catch (error) { if (current === session && revision === viewRevision && !paused) { await disconnect(true); report(error); } return; }
    finally {
      frameBusy = false;
      if (!stopped && session && !paused && visible && !document.hidden) { clearTimeout(timer); timer = setTimeout(() => void loop(), wait); }
    }
  };
  const start = async () => {
    if (requestBusy || stopped || session) return;
    requestBusy = true; connect.disabled = true; connecting = true; message.textContent = ''; paint();
    try {
      if (!w.device) throw Error('Choose a computer first.');
      const capabilities: DeviceCapabilities = await (await request(`capabilities?device=${encodeURIComponent(w.device)}`, undefined, 'GET', abort.signal)).json();
      if (capabilities.protocol !== 1) throw Error('Update required on the selected computer.');
      if (!capabilities.features.screen) throw Error(capabilities.state === 'suspended' ? 'Remote access was stopped locally. Resume it on the selected computer.' : 'Screen access unavailable. Check the host Connections page and OS permissions.');
      const result = await (await request('sessions', { protocol: 1, device: w.device, ward: w.i,
        capabilities: ['screen', 'input', 'rime', 'clipboard', 'files', 'audio'] }, 'POST', abort.signal)).json();
      if (stopped) { void request(`sessions/${result.id}`, { action: 'disconnect' }); return; }
      session = result.id; paused = false; detached = false; ack = 0; sequence = 0; ownership = undefined; topology = result.topology; dropped = false;
      features = { ...result.features }; allowInput = result.features.input; allowRime = result.features.rime;
      allowText = result.textInput?.available ?? allowInput;
      pending = result.state === 'pending-approval'; lastStatus = 0; statAt = performance.now();
      preferWebRTC = result.transports?.includes('webrtc') === true;
      displays = result.displays ?? []; display = result.display;
      updateControl(result.controller);
      if (!visible || document.hidden) visibility();
      else { await startMedia(); void loop(); }
    } catch (error) { report(error); void loadDevices().catch(() => {}); }
    finally { connecting = false; requestBusy = false; connect.disabled = false; paint(); }
  };
  connect.onclick = () => void start();
  disconnectButton.onclick = () => void disconnect();
  primary.onclick = () => {
    if (ownership !== undefined) { void release(); return; }
    if (acquiring || paused || !session || !visible || document.hidden) return;
    const current = session, revision = controlRevision;
    acquiring = true; paint();
    void action('acquire', { takeover: otherHuman }).then(r => r.json()).then(async result => {
      if (current !== session || stopped) return;
      if (revision !== controlRevision || paused || !visible || document.hidden || !document.hasFocus()) {
        await action('release'); return;
      }
      controlRevision++; ownership = result.ownership; topology = result.topology; sequence = 0; input.resetCursor();
      updateControl({ id: session, kind: 'human', generation: result.ownership }); refocus();
    }).catch(report).finally(() => { acquiring = false; paint(); });
  };
  // ---- clipboard
  clipboardSend.onclick = () => {
    void action('clipboard', { direction: 'send', mime: 'text/plain', text: clipboardText.value })
      .then(() => { lastClipboard = clipboardText.value; toast('Text sent to the remote clipboard.'); }).catch(report);
  };
  clipboardReceive.onclick = () => {
    const current = session, revision = clipboardRevision;
    void action('clipboard', { direction: 'receive', mime: 'text/plain' }).then(r => r.json()).then(async result => {
      if (current !== session || revision !== clipboardRevision || stopped) return;
      clipboardText.value = result.text; lastClipboard = result.text;
      await navigator.clipboard.writeText(result.text); toast('Text received into your clipboard.');
    }).catch(report);
  };
  pngSend.onclick = () => {
    const current = session, revision = clipboardRevision;
    void navigator.clipboard.read().then(async items => {
      const item = items.find(i => i.types.includes('image/png')); if (!item) throw Error('Your clipboard does not contain a PNG image.');
      const blob = await item.getType('image/png'); if (blob.size > 8 * 1024 * 1024) throw Error('Clipboard PNG exceeds 8 MiB.');
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (current !== session || revision !== clipboardRevision || stopped) throw Error('Control changed; send the clipboard again explicitly.');
      await action('clipboard', { direction: 'send', mime: 'image/png', data }); toast('PNG sent to the remote clipboard.');
    }).catch(report);
  };
  pngReceive.onclick = () => {
    const current = session, revision = clipboardRevision;
    const png = action('clipboard', { direction: 'receive', mime: 'image/png' }).then(r => r.json()).then(result => {
      if (current !== session || revision !== clipboardRevision || stopped) throw Error('Control changed; receive the clipboard again explicitly.');
      const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)); return new Blob([bytes], { type: 'image/png' });
    });
    void navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(() => toast('PNG received into your clipboard.')).catch(report);
  };
  const clipboardTimer = setInterval(() => {
    if (!syncText.checked || ownership === undefined || !visible || document.hidden || !document.hasFocus() || syncingClipboard) return;
    const current = session, generation = ownership; syncingClipboard = true;
    void navigator.clipboard.readText().then(async value => {
      if (!syncText.checked || current !== session || generation !== ownership) return;
      if (value !== lastClipboard) {
        await action('clipboard', { direction: 'send', mime: 'text/plain', text: value, sync: true, ownership }); lastClipboard = value;
      } else {
        const result = await (await action('clipboard', { direction: 'receive', mime: 'text/plain', sync: true, ownership })).json();
        if (!syncText.checked || current !== session || generation !== ownership) return;
        if (result.text !== lastClipboard) { await navigator.clipboard.writeText(result.text); lastClipboard = result.text; }
      }
    }).catch(error => { syncText.checked = false; report(error); }).finally(() => { syncingClipboard = false; });
  }, 2000);
  // ---- retarget
  picker.onchange = () => {
    if (requestBusy) { picker.value = w.device ?? ''; return; }
    const device = picker.value;
    requestBusy = true; picker.disabled = true; connect.disabled = true;
    void disconnect().then(async () => {
      if (!device) { picker.value = w.device ?? ''; return; }
      await request('target', { ward: w.i, device }, 'PUT', abort.signal);
      w.device = device; message.textContent = '';
    }).catch(error => { picker.value = w.device ?? ''; report(error); })
      .finally(() => { requestBusy = false; picker.disabled = false; connect.disabled = false; });
  };
  const heartbeat = setInterval(() => {
    if (ownership === undefined || !visible || document.hidden) return;
    const current = session, generation = ownership;
    void action('heartbeat', { ownership, topology }).catch(error => { if (current === session && generation === ownership) { void release(); report(error); } });
  }, 2000);
  const windowBlur = () => void release();
  window.addEventListener('blur', windowBlur);
  root.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) void release();
  });
  // ---- expand + fullscreen
  const openDialog = () => {
    const dlg = dialog(); if (!dlg) return;
    if (dialogMount?.root === root) return;
    if (dialogMount) { const previous = dialogMount; dialogMount = null; previous.home(); }
    dialogMount = { root, home: () => { const home = body(w.i); if (home) home.append(root); else stop(); paint(); fit(); } };
    expandedDesktopWard(w.i);
    const title = dlg.querySelector('[data-rd-title]');
    if (title) title.textContent = document.querySelector(`[data-wd="${w.i}"] [data-wd-title]`)?.textContent ?? 'Remote Desktop';
    dlg.querySelector('[data-rd-host]')?.append(root);
    if (!dlg.open) dlg.showModal(); paint(); refocus();
  };
  expand.onclick = openDialog;
  const toggleFs = () => {
    if (fullscreen()) void document.exitFullscreen().catch(report);
    else if (typeof root.requestFullscreen === 'function') void root.requestFullscreen().catch(report);
  };
  fs.onclick = toggleFs;
  pin.onclick = () => { pinned = !pinned; showBar(); paint(); };
  const showBar = () => {
    root.dataset.bar = '1'; clearTimeout(barTimer);
    if (pinned) return;
    barTimer = setTimeout(() => { if (bar.matches(':hover, :focus-within') || root.querySelector(':popover-open')) showBar(); else delete root.dataset.bar; }, 2000);
  };
  bar.addEventListener('focusin', showBar);
  root.addEventListener('pointermove', e => { if (fullscreen() && e.clientY < 48) showBar(); });
  stage.addEventListener('pointerdown', e => { if (fullscreen() && e.pointerType === 'touch' && (ownership === undefined || e.clientY < 48)) showBar(); });
  const onFullscreen = () => {
    if (fullscreen()) showBar(); else { delete root.dataset.bar; clearTimeout(barTimer); }
    paint(); fit();
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  // ---- visibility: hidden pauses and releases; 60 s hidden detaches
  const visibility = () => {
    const active = visible && !document.hidden;
    viewRevision++;
    const current = session;
    clearTimeout(hiddenTimer);
    if (!active) {
      paused = true; clearTimeout(timer); void release(); media.stop();
    }
    // Serialize pause/detach/resume; a late pause must never stop a resumed viewer.
    visibilityWork = visibilityWork.then(async () => {
      if (!current || current !== session || stopped) return;
      if (!pending) await action(active ? 'resume' : 'pause');
      if (current !== session || stopped || active !== (visible && !document.hidden)) return;
      if (active) {
        paused = false; if (detached) ack = 0; detached = false; lastStatus = 0;
        await startMedia(); clearTimeout(timer); void loop(); paint();
      }
    }).catch(async error => {
      if (current !== session || stopped) return;
      await disconnect(true); report(error);
    });
    if (!active && current) hiddenTimer = setTimeout(() => {
      visibilityWork = visibilityWork.then(async () => {
        if (current !== session || visible && !document.hidden) return;
        if (!transfer.active()) { await disconnect(); return; }
        const result = await (await action('detach')).json();
        if (result.closed) await disconnect();
        else { detached = true; ack = 0; }
      }).catch(async error => {
        if (current === session) { await disconnect(true); report(error); }
      });
    }, 60000);
  };
  document.addEventListener('visibilitychange', visibility);
  const observer = new IntersectionObserver(entries => { const next = entries[0]?.isIntersecting ?? false; if (visible !== next) { visible = next; visibility(); } });
  observer.observe(root);
  let keepaliveBusy = false;
  const transferHeartbeat = setInterval(() => {
    if (!session || visible && !document.hidden || keepaliveBusy) return;
    const current = session; keepaliveBusy = true;
    // Status renews the 30-second host grant without renewing human input ownership.
    void action('status').then(response => response.body?.cancel()).catch(async error => {
      if (current === session) { await disconnect(true); report(error); }
    }).finally(() => { keepaliveBusy = false; });
  }, 10000);
  const stop = () => {
    stopped = true; void disconnect(); transfer.stop(); abort.abort(); clearInterval(heartbeat); observer.disconnect();
    clearInterval(clipboardTimer); clearInterval(transferHeartbeat); resize.disconnect(); barResize.disconnect(); clearTimeout(barTimer);
    document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', onFullscreen);
    window.removeEventListener('pagehide', stop); window.removeEventListener('blur', windowBlur);
    if (fullscreen()) void document.exitFullscreen().catch(() => {});
    kb?.unlock?.();
    if (dialogMount?.root === root) { dialogMount = null; dialog()?.close(); }
    if (header) header.textContent = '';
    root.remove(); mounts.delete(w.i);
  };
  mounts.set(w.i, stop); window.addEventListener('pagehide', stop);
  restoreExpandedWard(w.i, openDialog);
  paint();
  let devicesLoading: Promise<void> | undefined;
  const loadDevices = (): Promise<void> => devicesLoading ??= request('devices', undefined, 'GET', abort.signal).then(r => r.json()).then((list: Device[]) => {
    // The shared picker selects by index; retain its snapshot while it is open.
    if (stopped || picker.nextElementSibling?.getAttribute('aria-expanded') === 'true') return;
    devices = list;
    const selected = picker.value || w.device || '';
    picker.replaceChildren(new Option('Choose a computer', ''));
    for (const d of list) picker.append(new Option(`${d.name} · ${d.platform} · ${d.online ? d.remoteDesktop === 0 ? 'Update required' : 'Online' : 'Offline'}`, d.id));
    if (selected && !list.some(d => d.id === selected)) picker.append(new Option('Unavailable computer', selected));
    picker.value = selected;
    paint();
  }).finally(() => { devicesLoading = undefined; });
  void loadDevices().then(() => {
    if (w.config?.autoConnect === true && w.device && visible && !document.hidden) void start();
  }).catch(report);
}
RENDERERS['remote-desktop'] = { render, stop: id => mounts.get(id)?.() };
