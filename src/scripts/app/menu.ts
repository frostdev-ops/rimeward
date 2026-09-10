// The context menu — one floating `.ctx-menu` at a time, viewport-clamped.
// Shared by the ward/grid menus (edit.ts), the page tabs (pages.ts) and the
// notebook dialog (notebook.ts).

import { icon } from './icon.ts';
import { el } from './dom.ts';

let menuEl: HTMLElement | null = null;
export function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
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
  const m = el('div', 'ctx-menu');
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
  menuEl = m;
  m.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}

// Close paths: outside click, Escape, any scroll, a resize.
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('scroll', closeMenu, { passive: true, capture: true });
window.addEventListener('resize', closeMenu);
