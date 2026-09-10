// The context menu — one floating `.ctx-menu` at a time, viewport-clamped.
// Shared by the ward/grid menus (edit.ts), the page tabs (pages.ts) and the
// notebook dialog (notebook.ts).

import { icon } from './icon.ts';
import { el } from './dom.ts';

let menuEl: HTMLElement | null = null;
let returnFocus: HTMLElement | SVGElement | null = null;
export function closeMenu(): void {
  const restore = menuEl?.contains(document.activeElement);
  menuEl?.remove();
  menuEl = null;
  if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

/** `id` is a semantic icon id (lib/icon-names.ts) — the menu follows the theme's icon set like the wards do. */
export function menuItem(id: string, label: string, fn: () => void, danger = false): HTMLElement {
  const b = el('button') as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  if (danger) b.dataset.danger = '1';
  b.append(icon(id), el('span', undefined, label));
  b.addEventListener('click', () => {
    closeMenu();
    fn();
  });
  return b;
}

export function openMenu(x: number, y: number, build: (m: HTMLElement) => void): void {
  closeMenu();
  returnFocus = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null;
  const m = el('div', 'ctx-menu');
  m.style.maxHeight = 'calc(100dvh - 16px)';
  m.style.maxWidth = 'calc(100vw - 16px)';
  m.style.overflowY = 'auto';
  m.setAttribute('role', 'menu');
  build(m);
  // Inside a modal dialog the menu must live in the dialog: the top layer sits
  // over anything appended to body. A transform/backdrop-filter on .fd-dialog
  // makes it the containing block for fixed children, so (0,0) is probed and
  // the viewport coordinates are corrected by where it landed.
  const host = document.activeElement?.closest('dialog[open]:modal') ?? document.querySelector('dialog[open]:modal') ?? document.body;
  host.append(m);
  m.style.left = '0px';
  m.style.top = '0px';
  const o = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - o.width - 8)) - o.left}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - o.height - 8)) - o.top}px`;
  m.addEventListener('keydown', e => {
    const items = [...m.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      e.stopPropagation(); closeMenu(); return;
    }
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : -1;
    if (next >= 0) { e.preventDefault(); e.stopPropagation(); items[next]?.focus({ preventScroll: true }); items[next]?.scrollIntoView({ block: 'nearest' }); }
  });
  menuEl = m;
  m.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
}

// Close paths: outside click, Escape, any scroll, a resize.
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('scroll', e => { if (!(e.target instanceof Node) || !menuEl?.contains(e.target)) closeMenu(); }, { passive: true, capture: true });
window.addEventListener('resize', closeMenu);

/** Bind pointer and keyboard invocation without replacing native menus on unhandled targets.
 * Keyboard invocations use detail -1 so canvas menus retain the current selection. */
export function bindContextMenu(target: HTMLElement | SVGElement, show: (event: MouseEvent) => void, signal?: AbortSignal): void {
  target.addEventListener('contextmenu', event => { if (!event.defaultPrevented) show(event as MouseEvent); }, { signal });
  target.addEventListener('keydown', event => {
    const e = event as KeyboardEvent;
    if (e.defaultPrevented || !(e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10')) return;
    const origin = e.target instanceof Element ? e.target : target;
    const rect = origin.getBoundingClientRect();
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.top + Math.min(rect.height, 32), detail: -1 });
    origin.dispatchEvent(context);
    if (context.defaultPrevented) { e.preventDefault(); e.stopPropagation(); }
  }, { signal });
}
