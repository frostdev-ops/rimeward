// The leaf of the client tree: the DOM and fetch helpers every module shares.
// Imports nothing under scripts/app/, so any module can import it without a
// cycle. All DOM is built via createElement/textContent — mail subjects,
// Notion titles and packet text are hostile input.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const q = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short random id: `w…` for wards, `e…` for edges. */
export const newId = (prefix: string) => prefix + Math.random().toString(36).slice(2, 8);

// ------------------------------------------------------------------ toasts

let toastEl: HTMLElement | null = null;

/** One toast at a time, 4.5 s, with an optional action link (Undo, Retry…). */
export function toast(msg: string, action?: { label: string; fn: () => void }, danger = false): void {
  toastEl?.remove();
  const t = el('div', 'fd-toast');
  t.append(el('span', danger ? 'text-err' : undefined, msg));
  if (action) {
    const b = el('button', 'link text-xs', action.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      t.remove();
      if (toastEl === t) toastEl = null;
      action.fn();
    });
    t.append(b);
  }
  const host = document.activeElement?.closest('dialog[open]') ?? [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body;
  host.append(t);
  toastEl = t;
  setTimeout(() => {
    t.dataset.leaving = '1';
    setTimeout(() => t.remove(), 220);
  }, 4500);
}

/** A toast that is only an action, up for 15 s — "a turn ran, tap to open". */
export function tapToast(label: string, fn: () => void): void {
  const t = el('div', 'fd-toast');
  const btn = el('button', 'link text-xs', label);
  btn.type = 'button';
  btn.addEventListener('click', () => {
    fn();
    t.remove();
  });
  t.append(btn);
  document.body.append(t);
  setTimeout(() => t.remove(), 15_000);
}

// ------------------------------------------------------------- focus guards

/** Dashboard shortcuts yield to the field or ward that owns the keystroke. */
export function keyboardInUse(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    [document.activeElement, ...event.composedPath()].some(target => target instanceof Element &&
      !!target.closest('input, textarea, select, [contenteditable], [role="textbox"], canvas, iframe'));
}

/** True while the ward's input holds the user's un-submitted text — checked
 *  AFTER every await, since typing can start mid-fetch. */
export function typingInto(b: HTMLElement): boolean {
  const input = b.querySelector('input');
  return !!input && input === document.activeElement && !!input.value;
}

/** Don't stomp a field the user is mid-edit on when the poll comes round. */
export function busy(b: HTMLElement): boolean {
  const a = document.activeElement;
  return !!a && b.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

// -------------------------------------------------------------- formatters

/** Compact age: 5s · 3m · 2h · 4d. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Locale wall-clock time, e.g. 9:05 AM. */
export const hm = (t: number | string | Date): string => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// -------------------------------------------------------------------- urls

export function isHttpUrl(v: unknown): v is string {
  try {
    const u = new URL(String(v));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A bare host becomes https://host; anything with a scheme passes through. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  return v && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? `https://${v}` : v;
}

// ------------------------------------------------------------------- fetch

export async function getJson(url: string): Promise<{ status: number; data: any }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** JSON in, JSON out. A network failure is ok:false, status 0, data null —
 *  callers branch on `ok`, never on a thrown error. */
export async function postJson(url: string, body: unknown, method = 'POST', init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init }).catch(() => null);
  return { ok: !!res?.ok, status: res?.status ?? 0, data: res ? await res.json().catch(() => null) : null };
}

/** Long-press on a coarse pointer: `fn` fires after `ms` of a still touch
 *  (under 6px of movement); a lift or a move before that is a tap or a scroll.
 *  Mouse and pen have contextmenu; touch does not on iOS, hence this. The
 *  click the lift would fire is swallowed so it cannot close what just opened. */
export function holdToFire(el: HTMLElement, ms: number, fn: (e: PointerEvent) => void, skip?: (e: PointerEvent) => boolean): void {
  let t = 0;
  let x = 0;
  let y = 0;
  let swallow = false;
  const stop = () => {
    if (t) clearTimeout(t);
    t = 0;
  };
  el.addEventListener(
    'pointerdown',
    (e) => {
      swallow = false;
      if (e.pointerType !== 'touch' || !e.isPrimary || skip?.(e)) return;
      x = e.clientX;
      y = e.clientY;
      stop();
      t = window.setTimeout(() => {
        t = 0;
        swallow = true;
        navigator.vibrate?.(10);
        fn(e);
      }, ms);
    },
    { passive: true }
  );
  el.addEventListener('pointermove', (e) => t && Math.hypot(e.clientX - x, e.clientY - y) > 6 && stop(), { passive: true });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(ev, stop, { passive: true });
  el.addEventListener(
    'click',
    (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
}
