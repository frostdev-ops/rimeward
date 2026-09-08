// Pointer, keyboard and touchpad input for the Remote Desktop ward. Pure DOM
// wiring over one `send(events)` seam: the ward owns ownership, topology and
// the batch queue, this module only turns browser events into wire events
// ({type:'move'|'button'|'scroll'|'key'|'text'} — see remote-desktop.ts).

export type RemoteEvent = Record<string, unknown>;
export interface Key { key: string; code: string }
export const MODS = {
  ctrl: { key: 'Control', code: 'ControlLeft' }, alt: { key: 'Alt', code: 'AltLeft' },
  shift: { key: 'Shift', code: 'ShiftLeft' }, meta: { key: 'Meta', code: 'MetaLeft' },
} as const satisfies Record<string, Key>;
export type Mod = keyof typeof MODS;
export type Platform = 'mac' | 'win' | 'linux';
export const platformOf = (s: string | undefined): Platform => /mac|darwin|ios/i.test(s ?? '') ? 'mac' : /win/i.test(s ?? '') ? 'win' : 'linux';
export const metaLabel = (p: Platform) => p === 'mac' ? 'Cmd' : p === 'win' ? 'Win' : 'Super';
export const modLabel = (mod: Mod, p: Platform) => mod === 'meta' ? metaLabel(p) : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }[mod];
const K = (key: string, code = key): Key => ({ key, code });
/** The Keys menu: every entry is pressed down in order and released in reverse. */
export function sequences(p: Platform): { label: string; keys: Key[] }[] {
  const meta = metaLabel(p);
  return [
    { label: 'Ctrl+Alt+Del', keys: [MODS.ctrl, MODS.alt, K('Delete')] },
    { label: 'Ctrl+Shift+Esc', keys: [MODS.ctrl, MODS.shift, K('Escape')] },
    { label: 'Alt+Tab', keys: [MODS.alt, K('Tab')] },
    { label: `${meta}+Tab`, keys: [MODS.meta, K('Tab')] },
    { label: 'Esc', keys: [K('Escape')] },
    { label: 'Tab', keys: [K('Tab')] },
    { label: 'PrintScreen', keys: [K('PrintScreen')] },
    { label: meta, keys: [MODS.meta] },
    { label: 'Lock screen', keys: p === 'mac' ? [MODS.meta, MODS.ctrl, K('q', 'KeyQ')] : [MODS.meta, K('l', 'KeyL')] },
  ];
}
const down = (k: Key): RemoteEvent => ({ type: 'key', key: k.key, code: k.code, down: true, repeat: false });
const up = (k: Key): RemoteEvent => ({ type: 'key', key: k.key, code: k.code, down: false, repeat: false });
export const press = (keys: Key[]): RemoteEvent[] => [...keys.map(down), ...[...keys].reverse().map(up)];
const clamp = (v: number) => Math.max(0, Math.min(0.999999, v));
const clamp100 = (v: number) => Math.max(-100, Math.min(100, v));

/** Resolve theme colours on a real element: SVG image cursors cannot inherit CSS variables. */
export function themedCursor(element: HTMLElement): string {
  const style = getComputedStyle(element);
  const xml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const shape = 'M5 3V25L11 19L16 29L21 26L16 17H25Z';
  // Both light and dark edges keep the pointer visible over arbitrary remote pixels.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g stroke-linejoin="round"><path d="${shape}" stroke="#000" stroke-width="4"/><path d="${shape}" fill="#fff" stroke="#fff" stroke-width="2"/><path d="${shape}" fill="${xml(style.color)}" stroke="${xml(style.outlineColor)}" stroke-width="0.75"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export interface InputHost {
  canvas: HTMLCanvasElement;
  /** The drawn box of the remote display (canvas + video share it) — pointer coordinates map off it in every scaling mode. */
  frame: HTMLElement;
  /** The offscreen textarea that owns keyboard focus while controlling (opens the OS keyboard on phones). */
  catcher: HTMLTextAreaElement;
  /** The touchpad mode's virtual SVG pointer, positioned inside its offsetParent. */
  cursor: HTMLElement;
  send(events: RemoteEvent[]): void;
  controlling(): boolean;
  /** {type:'text'} is allowed — printable keys ride the input event instead of key events. */
  textOK(): boolean;
  touchpad(): boolean;
  /** Sticky modifiers: held down around the next key or click, then released. */
  sticky: Set<Mod>;
  stickyChanged(): void;
  fullscreenKey(): void;
  blurred(): void;
  cancelled(): void;
  /** Pixels per line for deltaMode 2 (page) wheel events. */
  scrollUnit(): number;
  /** A coarse primary pointer: taps never focus the catcher (that would open the OS keyboard on every tap) — the Keys menu's Show keyboard does. */
  coarse: boolean;
}

export function wireInput(h: InputHost) {
  const { canvas, catcher } = h;
  h.cursor.setAttribute('aria-hidden', 'true');
  const repaintCursor = () => {
    const image = themedCursor(h.cursor);
    canvas.style.setProperty('--rd-pointer', `${image} 5 3, default`);
    h.cursor.style.backgroundImage = image;
  };
  const theme = new MutationObserver(repaintCursor);
  const themeAttrs = { attributes: true, attributeFilter: ['style', 'class', 'data-themed', 'data-ward-theme', 'data-ward-mode'] };
  theme.observe(document.documentElement, themeAttrs);
  const ward = canvas.closest('[data-wd]');
  if (ward) theme.observe(ward, themeAttrs);
  repaintCursor();
  const at = (x: number, y: number): RemoteEvent => {
    const r = h.frame.getBoundingClientRect();
    return { type: 'move', x: clamp((x - r.left) / r.width), y: clamp((y - r.top) / r.height) };
  };
  const takeSticky = (): Key[] => {
    const held = [...h.sticky].map(m => MODS[m]);
    if (held.length) { h.sticky.clear(); h.stickyChanged(); }
    return held;
  };
  // ---- touchpad mode: a virtual cursor moved by relative drags
  const cur = { x: 0.5, y: 0.5 };
  const touches = new Map<number, { x: number; y: number; sx: number; sy: number; t: number; moved: boolean }>();
  let hold: number | undefined, dragging = false, twoMoved = false, twoAt = 0;
  const drawCursor = () => {
    const r = h.frame.getBoundingClientRect(), p = h.cursor.offsetParent?.getBoundingClientRect() ?? r;
    h.cursor.style.left = `${r.left - p.left + cur.x * r.width}px`; h.cursor.style.top = `${r.top - p.top + cur.y * r.height}px`;
  };
  const curMove = (): RemoteEvent => ({ type: 'move', x: clamp(cur.x), y: clamp(cur.y) });
  const click = (button: number, move: RemoteEvent) => {
    const mods = takeSticky();
    h.send([...mods.map(down), move, { type: 'button', button, down: true }, { type: 'button', button, down: false }, ...mods.reverse().map(up)]);
  };
  const isPad = (e: PointerEvent) => e.pointerType === 'touch' && h.touchpad();
  const stopHold = () => { clearTimeout(hold); hold = undefined; };
  let heldMods: Key[] = [];
  canvas.addEventListener('pointerdown', e => {
    if (!h.controlling()) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    if (!h.coarse) catcher.focus({ preventScroll: true });
    if (isPad(e)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now(), moved: false });
      stopHold();
      if (touches.size === 1) hold = window.setTimeout(() => {
        hold = undefined; if (!h.controlling()) return; dragging = true; navigator.vibrate?.(10);
        h.send([curMove(), { type: 'button', button: 0, down: true }]);
      }, 400);
      else { twoMoved = false; twoAt = Date.now(); }
      return;
    }
    heldMods = takeSticky();
    h.send([...heldMods.map(down), at(e.clientX, e.clientY), { type: 'button', button: e.button, down: true }]);
  });
  canvas.addEventListener('pointermove', e => {
    if (!h.controlling()) return;
    if (!isPad(e)) { h.send([at(e.clientX, e.clientY)]); return; }
    const t = touches.get(e.pointerId); if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y; t.x = e.clientX; t.y = e.clientY;
    if (!t.moved && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > 6) { t.moved = true; stopHold(); }
    if (touches.size >= 2) {
      if (!t.moved || !e.isPrimary) return;
      twoMoved = true;
      // ponytail: fixed scroll gain; a settings knob if hosts disagree on scroll units.
      const events: RemoteEvent[] = [];
      for (const [axis, d] of [['x', dx], ['y', dy]] as const) if (d) events.push({ type: 'scroll', axis, amount: clamp100(-d / 16) });
      if (events.length) h.send(events);
      return;
    }
    if (!t.moved) return;
    const r = h.frame.getBoundingClientRect();
    cur.x = clamp(cur.x + dx * 1.5 / r.width); cur.y = clamp(cur.y + dy * 1.5 / r.height);
    drawCursor(); h.send([curMove()]);
  });
  canvas.addEventListener('pointerup', e => {
    if (!h.controlling()) return;
    e.preventDefault();
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!isPad(e)) {
      h.send([at(e.clientX, e.clientY), { type: 'button', button: e.button, down: false }, ...heldMods.reverse().map(up)]);
      heldMods = []; return;
    }
    const t = touches.get(e.pointerId); touches.delete(e.pointerId); stopHold();
    if (!t) return;
    if (dragging) { if (!touches.size) { dragging = false; h.send([curMove(), { type: 'button', button: 0, down: false }]); } return; }
    if (twoAt) { // the first of two fingers lifted: a still two-finger tap is a right click
      if (!twoMoved && Date.now() - twoAt < 300) click(2, curMove());
      twoAt = 0; for (const o of touches.values()) o.moved = true; return;
    }
    if (!t.moved && Date.now() - t.t < 250) click(0, curMove());
  });
  canvas.addEventListener('pointercancel', () => { touches.clear(); stopHold(); dragging = false; twoAt = 0; h.cancelled(); });
  canvas.addEventListener('contextmenu', e => { if (h.controlling()) e.preventDefault(); });
  canvas.addEventListener('wheel', e => {
    if (!h.controlling()) return;
    e.preventDefault();
    const events = [at(e.clientX, e.clientY)];
    for (const [axis, delta] of [['x', e.deltaX], ['y', e.deltaY]] as const) if (delta)
      events.push({ type: 'scroll', axis, amount: clamp100(delta * (e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? h.scrollUnit() : 1 / 40)) });
    h.send(events);
  }, { passive: false });
  canvas.addEventListener('focus', () => { if (h.controlling() && !h.coarse) catcher.focus({ preventScroll: true }); });
  // ---- keyboard: printable keys become text through the input event (IME-safe); everything else is a key event
  const PASS = new Set(['Dead', 'Process', 'Unidentified']);
  const heldKeys = new Set<string>();
  const wire = (e: KeyboardEvent) => ({ key: e.key === ' ' ? 'Space' : e.key, code: e.code });
  const printable = (e: KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
  catcher.addEventListener('keydown', e => {
    if (!h.controlling() || e.isComposing || e.keyCode === 229 || PASS.has(e.key)) return;
    if (e.key === 'F11') { e.preventDefault(); h.fullscreenKey(); return; }
    if (printable(e) && h.textOK() && !h.sticky.size) return;
    e.preventDefault();
    const k = wire(e), mods = takeSticky();
    if (mods.length) { h.send([...mods.map(down), { type: 'key', ...k, down: true, repeat: e.repeat }, up(k), ...mods.reverse().map(up)]); return; }
    heldKeys.add(e.code); h.send([{ type: 'key', ...k, down: true, repeat: e.repeat }]);
  });
  catcher.addEventListener('keyup', e => {
    if (!heldKeys.delete(e.code) || !h.controlling()) return;
    e.preventDefault(); h.send([up(wire(e))]);
  });
  const flushText = () => {
    const text = catcher.value; if (!text) return;
    catcher.value = '';
    if (h.controlling() && h.textOK()) h.send([{ type: 'text', text }]);
  };
  catcher.addEventListener('input', e => { if (!(e as InputEvent).isComposing) flushText(); });
  catcher.addEventListener('compositionend', flushText);
  const reset = () => { touches.clear(); stopHold(); heldMods = []; heldKeys.clear(); dragging = false; twoAt = 0; twoMoved = false; catcher.value = ''; };
  catcher.addEventListener('blur', () => { reset(); h.blurred(); });
  return { reset, drawCursor, repaintCursor, stop: () => { reset(); theme.disconnect(); }, resetCursor: () => { cur.x = 0.5; cur.y = 0.5; drawCursor(); } };
}
