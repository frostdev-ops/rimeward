// Pages: several tabbed dashboards over ONE flat layout (docs/pages-spec.md).
// A card's `data-page` is the client's source of truth for where a ward sits —
// edit.ts reads it back into the layout the way it reads nesting — and this
// module decides which page is on stage: every other page's top-level cards
// carry `data-wd-off` (display:none), nested wards follow their group. Nothing
// server-side looks at pages; the engine, the bots and the watchers run every
// ward on every page.

import { CATALOG, DEFAULT_PAGES, MAX_PAGES, pageSlug, validatePages, type PageDef } from '../../lib/wards.ts';
import { el, holdToFire, keyboardInUse, q, reducedMotion, toast } from './dom.ts';
import { menuItem, openMenu } from './menu.ts';
import { canShare, openShareDialog } from './share.ts';
import { popoutWard, stageWardView } from './ward-view.ts';

let pages: PageDef[] = DEFAULT_PAGES;
let current = '';
let nav: HTMLElement | null = null;
let grid: HTMLElement | null = null;
/** The stage of a page shared WITH this user: their page, in a frame (lib/shares.ts). */
let frame: HTMLIFrameElement | null = null;
const pageStorageKey = () => `fd-page:${document.querySelector<HTMLMetaElement>('meta[name="rimeward-runtime-base"]')?.content ?? "server"}`;
const subs = new Set<(id: string, prev: string) => void>();

export const readPages = (): PageDef[] => pages;
export const currentPage = (): string => current;
export const firstPage = (): string => pages[0]!.id;
export function onPage(fn: (id: string, prev: string) => void): void {
  subs.add(fn);
}

/** Off stage: on another page, or inside a group that is. */
export function offStage(id: string): boolean {
  return !!document.querySelector(`[data-wd="${id}"]`)?.closest('[data-wd-off]');
}

const topCards = () => (grid ? [...grid.querySelectorAll<HTMLElement>(':scope > [data-wd]')] : []);

/** The page a card is on, read from the DOM (a nested card: its group's). */
export function pageOfCard(id: string): string | undefined {
  let n = document.querySelector<HTMLElement>(`[data-wd="${id}"]`);
  if (!n) return undefined;
  for (let g = n.parentElement?.closest<HTMLElement>('[data-wd]'); g; g = g.parentElement?.closest<HTMLElement>('[data-wd]')) n = g;
  return n.dataset.page ?? firstPage();
}

/** The ONE writer of #pages-data (edit.ts's save reads it back beside the layout). */
export function publishPages(next: PageDef[]): void {
  pages = next.length ? next : DEFAULT_PAGES;
  const island = document.getElementById('pages-data');
  if (island) island.textContent = JSON.stringify(pages).replaceAll('<', '\\u003c');
  renderTabs();
}

/** After a layout apply: cards may have changed page, the current page may be gone. */
export function restage(): void {
  if (!pages.some((p) => p.id === current)) showPage(firstPage(), { replace: true });
  else stamp();
}

function stamp(): void {
  if (popoutWard) { stageWardView(); return; }
  // A shared page is someone else's: none of these cards is on it.
  const shared = pages.find((p) => p.id === current)?.share ?? '';
  for (const n of topCards()) {
    // A page id nothing knows (an undo of a delete re-stamped it) means the first page.
    const on = n.dataset.page && pages.some((p) => p.id === n.dataset.page) ? n.dataset.page : firstPage();
    n.toggleAttribute('data-wd-off', !!shared || on !== current);
  }
  if (frame) {
    frame.hidden = !shared;
    if (frame.dataset.share !== shared) {
      frame.dataset.share = shared;
      frame.src = shared ? `/s/${shared}?theme=mine&embed=1` : 'about:blank';
    }
  }
  for (const b of nav?.querySelectorAll<HTMLElement>('[data-page-tab]') ?? []) {
    if (b.dataset.pageTab === current) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  placeInk();
}

/** The accent underline slides between chips — a CSS transition on the one
 *  ink element (--fd-spring), so there is nothing to cancel or retarget. */
function placeInk(): void {
  const ink = nav?.querySelector<HTMLElement>('.app-page-ink');
  const chip = nav?.querySelector<HTMLElement>('[data-page-tab][aria-current]');
  if (!ink || !chip) return;
  ink.style.transform = `translateX(${chip.offsetLeft}px)`;
  ink.style.width = `${chip.offsetWidth}px`;
  chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// The swap animates the GRID, never the cards (edit.ts's one-writer rule): a
// clone of the outgoing grid fades and slides out over the real one, which
// slides in with the new page. The clone is inert, stripped of every id and
// data-wd so nothing can query it, and gone when its animation ends.
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
let swapAnims: Animation[] = [];
function swap(from: number, to: number, apply: () => void): void {
  if (!grid || from < 0 || to < 0 || from === to || document.hidden) {
    apply();
    return;
  }
  for (const a of swapAnims) a.cancel();
  document.querySelector('.wd-grid-ghost')?.remove();
  const r = grid.getBoundingClientRect();
  const ghost = grid.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.classList.add('wd-grid-ghost');
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  for (const n of ghost.querySelectorAll<HTMLElement>('[data-wd], [id], .wd-enter')) {
    n.removeAttribute('data-wd');
    n.removeAttribute('id');
    n.classList.remove('wd-enter'); // a fresh element would replay its entrance
  }
  ghost.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;margin:0;pointer-events:none;z-index:1`;
  document.body.append(ghost);
  apply();
  const rm = reducedMotion();
  const dir = to > from ? 1 : -1;
  const out = ghost.animate(
    rm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-24 * dir}px)` }],
    { duration: rm ? 120 : 160, easing: 'ease-out', id: 'fd-page-out' }
  );
  const inn = grid.animate(
    rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(${24 * dir}px)` }, { opacity: 1, transform: 'none' }],
    { duration: rm ? 120 : 200, easing: EASE, id: 'fd-page-in' }
  );
  swapAnims = [out, inn];
  const drop = () => ghost.remove();
  out.finished.then(drop, drop);
}

export function showPage(id: string, opts: { replace?: boolean; silent?: boolean; instant?: boolean } = {}): void {
  if (popoutWard) { stageWardView(); return; }
  if (!pages.some((p) => p.id === id)) id = firstPage();
  // Leylines mode lays every page out in flow (below); a tab just scrolls there.
  if (grid?.classList.contains('wiring')) {
    grid.querySelector(`.wd-page-head[data-page="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const prev = current;
  current = id;
  const idx = (p: string) => pages.findIndex((x) => x.id === p);
  if (opts.instant) stamp(); // mid-drag: the card follows the pointer, a slide would carry it
  else swap(idx(prev), idx(id), stamp);
  // The hash is the deep link (back/forward work, SSR is untouched); a
  // one-page dashboard keeps a clean URL.
  const url = pages.length > 1 ? `#p=${id}` : location.pathname + location.search;
  if (!opts.silent && location.hash !== (pages.length > 1 ? url : '')) {
    if (opts.replace || prev === '') history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  try {
    localStorage.setItem(pageStorageKey(), id);
  } catch {}
  if (prev === id) return;
  void fetch('/api/runtime', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: id }), keepalive: true }).catch(() => {});
  window.dispatchEvent(new CustomEvent('fd:page', { detail: { id, prev } }));
  for (const fn of subs) fn(id, prev);
}

// ---------------------------------------------------------------- flow mode
//
// Leylines mode needs both ends of every leyline on screen, so every page is
// laid out in flow under a header row — the trick fitGroups uses for groups.
// The cards keep their DOM order (the layout's truth); CSS `order` groups them
// by page, and frost.css shows off-stage cards dimmed while `.wiring` is on.

function enterFlow(): void {
  if (!grid || pages.length < 2) return;
  const idx = new Map(pages.map((p, i) => [p.id, i]));
  for (const n of topCards()) n.style.order = String((idx.get(n.dataset.page ?? firstPage()) ?? 0) * 2 + 1);
  for (const p of pages) {
    const head = el('div', 'wd-page-head', p.title);
    head.dataset.page = p.id;
    head.style.order = String((idx.get(p.id) ?? 0) * 2);
    grid.append(head);
  }
}
function exitFlow(): void {
  if (!grid) return;
  for (const n of topCards()) n.style.order = '';
  for (const h of grid.querySelectorAll('.wd-page-head')) h.remove();
}

// -------------------------------------------------------------------- tabs

const isEditing = () => !!grid?.classList.contains('editing');

export function renderTabs(): void {
  if (tabDrag) endTabDrag(false); // any rebuild ends a live drag — or clears a press that never became one — before the strip is replaced
  if (!nav) return;
  nav.textContent = '';
  // One page = no strip, except in edit mode, where the + chip is how a second
  // page gets made.
  nav.hidden = pages.length < 2 && !isEditing();
  for (const p of pages) {
    const b = el('button', 'app-page', p.title) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.pageTab = p.id;
    b.addEventListener('click', () => showPage(p.id));
    // Leylines mode lays every page out at once: no page menu there (deleting the current one would strand the stage).
    const menu = (e: { clientX: number; clientY: number }) => { if (!grid?.classList.contains('wiring')) openMenu(e.clientX, e.clientY, (m) => pageMenu(m, p, b)); };
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation(); // edit.ts's grid menu listens on <main> and would replace this one
      if ((e as PointerEvent).pointerType !== 'touch') menu(e);
    });
    holdToFire(b, 400, menu);
    nav.append(b);
  }
  const add = el('button', 'app-page app-page-add', '+') as HTMLButtonElement;
  add.type = 'button';
  add.dataset.pageAdd = '';
  add.title = 'Add page';
  add.setAttribute('aria-label', 'Add page');
  add.addEventListener('click', () => inlineName(add, '', addPage));
  nav.append(add, el('span', 'app-page-ink'));
  stamp();
}

function pageMenu(m: HTMLElement, p: PageDef, chip: HTMLElement): void {
  const i = pages.findIndex((x) => x.id === p.id);
  m.append(menuItem('edit', 'Rename', () => inlineName(chip, p.title, (t) => renamePage(p, t))));
  if (i > 0) m.append(menuItem('left', 'Move left', () => movePage(p, -1)));
  if (i < pages.length - 1) m.append(menuItem('right', 'Move right', () => movePage(p, 1)));
  if (p.share) m.append(menuItem('share', 'Open shared page', () => window.open(`/s/${p.share}`, '_blank', 'noopener')));
  else {
    const item = menuItem('share', 'Share page…', () => openShareDialog({ kind: 'page', target: p.id, title: p.title })) as HTMLButtonElement;
    // The same test the server applies (lib/shares.ts shareWards): a visible ward of a shareable type on this page.
    const shareable = topCards().some((n) => !n.hasAttribute('data-wd-hidden') && (n.dataset.page && pages.some((x) => x.id === n.dataset.page) ? n.dataset.page : firstPage()) === p.id && CATALOG[n.dataset.wdType ?? '']?.share);
    if (!canShare()) { item.disabled = true; item.title = 'Sharing needs a server'; }
    else if (!shareable) { item.disabled = true; item.title = 'Nothing on this page can be shared'; }
    m.append(item);
  }
  if (pages.length > 1) m.append(el('hr', 'ctx-sep'), menuItem('trash', p.share ? 'Remove page' : 'Delete page', () => deletePage(p), true));
}

/** Swap a chip for an input; Enter/blur commit, Escape (or a blank) restores the strip. */
function inlineName(anchor: HTMLElement, initial: string, done: (title: string) => void): void {
  const input = el('input', 'input app-page-input') as HTMLInputElement;
  input.value = initial;
  input.maxLength = 40;
  input.placeholder = 'Page name';
  input.setAttribute('aria-label', 'Page name');
  anchor.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    const t = input.value.trim();
    if (ok && t && t !== initial) done(t);
    else renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// --------------------------------------------------------------- mutations
//
// Every change publishes the list and tells edit.ts, whose commit() saves it
// beside the layout (immediately outside edit mode, on Done inside it).

function changed(): void {
  publishPages(pages);
  window.dispatchEvent(new Event('fd:pages-changed'));
}

/** Absent `data-page` means "the first page" — before the first page can
 *  change (a move, a delete), every card gets its page written out. */
function materialize(): void {
  for (const n of topCards()) n.dataset.page ??= firstPage();
}
/** …and afterwards the new first page's cards go back to absent. */
function normalize(): void {
  for (const n of topCards()) if (n.dataset.page === firstPage()) delete n.dataset.page;
}

function addPage(title: string): void {
  if (pages.length >= MAX_PAGES) {
    toast(`Up to ${MAX_PAGES} pages.`, undefined, true);
    renderTabs();
    return;
  }
  const id = pageSlug(title, pages);
  pages = [...pages, { id, title }];
  changed();
  showPage(id);
}

/** A page someone shared with this user becomes a tab of their page (never the first). */
export function addSharedPage(title: string, share: string): void {
  if (pages.length >= MAX_PAGES) { toast(`Up to ${MAX_PAGES} pages.`, undefined, true); return; }
  if (pages.some((p) => p.share === share)) { showPage(pages.find((p) => p.share === share)!.id); return; }
  const id = pageSlug(title, pages);
  pages = [...pages, { id, title, share }];
  changed();
  showPage(id);
}

function renamePage(p: PageDef, title: string): void {
  pages = pages.map((x) => (x.id === p.id ? { ...x, title } : x));
  changed();
}

function movePage(p: PageDef, dir: -1 | 1): void {
  const i = pages.findIndex((x) => x.id === p.id);
  if (i >= 0) reorderPage(p, i + dir);
}

/** Move a page to an index — the menu's Move left / right, and tab drag.
 *  The same pipeline movePage had: write out implicit first-page wards before
 *  the first page can change, refuse a shared first page, then publish. */
function reorderPage(p: PageDef, index: number): boolean {
  const i = pages.findIndex((x) => x.id === p.id);
  const j = Math.max(0, Math.min(pages.length - 1, index));
  if (i < 0 || j === i) return false;
  materialize();
  const next = [...pages];
  next.splice(i, 1);
  next.splice(j, 0, p);
  if (next[0]!.share) { toast('A shared page cannot be your first page.', undefined, true); return false; }
  pages = next;
  normalize();
  changed();
  return true;
}

/** Deleting a page never deletes wards: they land on the first page. The
 *  toast's Undo puts the page back where it was with the same wards (the
 *  toolbar's undo stack holds layouts only). */
function deletePage(p: PageDef): void {
  if (pages.length < 2) return;
  if (!p.share && pages.filter((x) => !x.share).length < 2) { toast('Keep at least one page of your own.', undefined, true); return; }
  materialize();
  const at = pages.findIndex((x) => x.id === p.id);
  const moved = topCards().filter((n) => n.dataset.page === p.id).map((n) => n.dataset.wd!);
  pages = pages.filter((x) => x.id !== p.id);
  // The first page must be this user's own (absent data-page means the first page).
  const own = pages.findIndex((x) => !x.share);
  if (own > 0) pages = [pages[own]!, ...pages.filter((_, k) => k !== own)];
  for (const n of topCards()) if (n.dataset.page === p.id) delete n.dataset.page;
  normalize();
  changed();
  if (current === p.id) showPage(firstPage(), { replace: true });
  else stamp();
  const undo = () => {
    if (pages.some((x) => x.id === p.id) || pages.length >= MAX_PAGES) return;
    materialize();
    pages = [...pages.slice(0, at), p, ...pages.slice(at)];
    for (const id of moved) {
      const n = grid?.querySelector<HTMLElement>(`:scope > [data-wd="${id}"]`);
      if (n) n.dataset.page = p.id;
    }
    normalize();
    changed();
    showPage(p.id);
  };
  toast(p.share ? `Removed ${p.title}.` : `Removed ${p.title} — its wards are on ${pages[0]!.title}.`, { label: 'Undo', fn: undo });
}

// ------------------------------------------------------------- tab reorder
//
// Drag a chip sideways to reorder pages — mouse and pen; touch scrolls the
// strip natively (no touch-action override) and reorders through the tab
// menu's Move left / right via long-press. The feedback is transforms only:
// the strip's DOM stays put until release, so the ink, edit mode's tab drop
// targets and a concurrent re-render are untouched. Release never switches
// pages, the click an armed drag leaves behind is always swallowed (cancelled
// drags too), and Escape, a scroll, a resize, a blur, a mode change or a
// re-render cancels. Keyboard users get the menu on Shift+F10 / ContextMenu.

interface TabDrag {
  p: PageDef;
  chip: HTMLElement;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  width: number;
  from: number;
  target: number;
  rest: { el: HTMLElement; mid: number; width: number; from: number; slot: number }[];
}

let tabDrag: TabDrag | null = null;
/** Gesture identity of an armed drag whose release click is still owed: the
 *  pointer that was dragging it. Set when a visibly armed drag ends for any
 *  reason — release, refusal, cancellation, re-render — and cleared only by
 *  the drag pointer's own release click or any fresh press, never by a timer,
 *  so a drag cancelled while its pointer is still held stays suppressed until
 *  that release, however late. Keyboard activation (a detail-0 click) is
 *  deliberate input, never a drag's release, and is never swallowed. */
let tabDragSwallow: { pointerId: number; pointerType: string } | null = null;

const tabDragLive = () => !!nav?.hasAttribute('data-page-drag');

/** End the drag: undo the visuals (the strip's DOM never changed), release the
 *  capture and clear every sticky bit — then, only if the drag was actually
 *  armed, optionally commit. The click of an armed release is suppressed no
 *  matter how it ends; a press that never became a drag leaves clicks alone. */
function endTabDrag(commit: boolean): void {
  const d = tabDrag;
  const live = tabDragLive();
  tabDrag = null;
  if (!nav) return;
  nav.removeAttribute('data-page-drag');
  if (live) tabDragSwallow = d ? { pointerId: d.pointerId, pointerType: d.pointerType } : null;
  if (!d) return;
  if (d.chip.hasPointerCapture?.(d.pointerId)) d.chip.releasePointerCapture(d.pointerId);
  for (const b of nav.querySelectorAll<HTMLElement>('[data-page-tab]')) {
    b.classList.remove('app-page-drag');
    b.style.transform = '';
  }
  if (!commit || !live || d.target === d.from) return;
  if (pages[d.from]?.id !== d.p.id) { renderTabs(); return; } // pages moved underneath
  // A refused drop (a shared page dragged to the front) just restores the strip.
  if (!reorderPage(d.p, d.target)) renderTabs();
}

function setupTabDrag(): void {
  if (!nav) return;
  nav.addEventListener(
    'click',
    (e) => {
      // detail 0 is keyboard activation (Enter / Space on a focused tab):
      // deliberate input that must work even while a release-click is owed.
      if (e.detail === 0 || !tabDragSwallow) return;
      tabDragSwallow = null; // one click per ended gesture — the drag pointer's own release
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  nav.addEventListener('pointerdown', (e) => {
    tabDragSwallow = null; // a fresh press is a new gesture: an owed release-click is no longer owed
    if (tabDrag && !tabDragLive()) tabDrag = null; // a press that never became a drag (released outside the strip) must not block the next one
    const chip = (e.target as Element).closest<HTMLElement>('[data-page-tab]');
    // Touch never drags: it scrolls the strip natively and reorders through the
    // long-press menu (holdToFire); mouse and pen drag.
    if (!chip || tabDrag || e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return;
    // Flow mode lays pages out as headers; an open menu owns the next click.
    if (pages.length < 2 || grid?.classList.contains('wiring') || document.querySelector('.ctx-menu')) return;
    const from = pages.findIndex((x) => x.id === chip.dataset.pageTab);
    if (from < 0) return;
    tabDrag = { p: pages[from]!, chip, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, width: 0, from, target: from, rest: [] };
  });
  nav.addEventListener(
    'pointermove',
    (e) => {
      const d = tabDrag;
      const strip = nav; // a closure cannot lean on the narrowing above
      if (!d || e.pointerId !== d.pointerId || !strip) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!tabDragLive()) {
        // A wiggle is still a click; a vertical move is a scroll.
        if (Math.hypot(dx, dy) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
        // The long-press that opened the tab menu shares this gesture: not a drag.
        if (document.querySelector('.ctx-menu')) { tabDrag = null; return; }
        if (!d.chip.isConnected) { tabDrag = null; return; }
        strip.dataset.pageDrag = '';
        d.chip.classList.add('app-page-drag');
        try { d.chip.setPointerCapture(e.pointerId); } catch {}
        // Cache the other chips' geometry once: our own transforms would
        // pollute anything measured later.
        let slot = 0;
        d.width = d.chip.getBoundingClientRect().width;
        d.rest = pages
          .filter((x) => x.id !== d.p.id)
          .flatMap((x) => {
            const b = strip.querySelector<HTMLElement>(`[data-page-tab="${x.id}"]`);
            if (!b) return [];
            const r = b.getBoundingClientRect();
            return [{ el: b, mid: r.left + r.width / 2, width: r.width, from: pages.findIndex((y) => y.id === x.id), slot: slot++ }];
          });
      }
      if (!d.chip.isConnected) { endTabDrag(false); return; } // a re-render replaced the strip
      d.chip.style.transform = `translateX(${dx}px)`;
      let t = 0;
      for (const r of d.rest) if (e.clientX > r.mid) t++;
      d.target = t;
      // Part the neighbours to show the landing slot.
      for (const r of d.rest) {
        const shift = r.from < d.from ? (r.slot >= t ? d.width : 0) : r.slot < t ? -d.width : 0;
        r.el.style.transform = shift ? `translateX(${shift}px)` : '';
      }
    },
    { passive: true }
  );
  nav.addEventListener('pointerup', (e) => {
    if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
    endTabDrag(true); // an ordinary click (never armed) commits nothing and just clears
  });
  nav.addEventListener('pointercancel', (e) => {
    if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
    endTabDrag(false);
  });
  // The OS taking the capture back (or the chip leaving the DOM) ends the drag untouched.
  nav.addEventListener('lostpointercapture', (e) => {
    if (tabDrag && tabDrag.pointerId === (e as PointerEvent).pointerId && tabDragLive()) endTabDrag(false);
  });
  // Scrolled or resized mid-drag, the cached chip geometry is stale: cancel rather than mis-drop.
  window.addEventListener('scroll', () => { if (tabDrag) endTabDrag(false); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (tabDrag) endTabDrag(false); });
  // A backgrounded or hidden window never sees the pointerup.
  window.addEventListener('blur', () => { if (tabDrag) endTabDrag(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tabDragLive()) {
      e.preventDefault();
      e.stopPropagation();
      endTabDrag(false); // the release this cancels must not become a click either
    }
  });
  // Keyboard tab menu: Shift+F10 or the ContextMenu key on a focused tab opens the
  // same actions the right-click menu shows, keyboard navigation included. The
  // keydown is handled explicitly — no reliance on an OS-generated contextmenu event.
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const chip = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-page-tab]') : null;
    if (!chip) return;
    e.preventDefault(); // the browser's own contextmenu event would open it twice
    e.stopPropagation();
    const p = pages.find((x) => x.id === chip.dataset.pageTab);
    if (!p || grid?.classList.contains('wiring')) return; // flow mode lays pages out; no menu there
    const r = chip.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, (m) => pageMenu(m, p, chip));
  });
  // A concurrent publish (undo, a layout apply) is about to rebuild the strip.
  window.addEventListener('fd:pages-changed', () => { if (tabDrag) endTabDrag(false); });
}

// -------------------------------------------------------------------- boot

export function bootPages(): void {
  grid = q('#wd-grid');
  nav = q('#wd-pages');
  if (!grid) return;
  frame = el('iframe', 'wd-share-frame') as HTMLIFrameElement;
  frame.hidden = true;
  frame.title = 'Shared page';
  grid.after(frame);
  try {
    pages = validatePages(JSON.parse(q('#pages-data')?.textContent ?? '[]')) ?? DEFAULT_PAGES;
  } catch {
    pages = DEFAULT_PAGES;
  }
  const fromHash = () => new URLSearchParams(location.hash.slice(1)).get('p');
  if (popoutWard) { current = firstPage(); stageWardView(); return; }
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(pageStorageKey());
  } catch {}
  renderTabs();
  setupTabDrag();
  showPage(fromHash() ?? q('#pages-data')?.dataset.activePage ?? stored ?? firstPage(), { replace: true });
  addEventListener('hashchange', () => {
    const id = fromHash();
    if (id && id !== current) showPage(id, { silent: true });
  });
  // The strip shows in edit mode even with one page (the + chip). Leylines
  // mode lays every page out in flow while it is on.
  let flow = false;
  let editing = false;
  new MutationObserver(() => {
    const wiring = grid!.classList.contains('wiring');
    const nowEditing = isEditing();
    // A mode change under a drag changes what the strip is for: end it cleanly.
    if (tabDrag && (wiring !== flow || nowEditing !== editing)) endTabDrag(false);
    if (nav) nav.hidden = pages.length < 2 && !nowEditing;
    placeInk();
    if (wiring && !flow) enterFlow();
    else if (!wiring && flow) exitFlow();
    flow = wiring;
    editing = nowEditing;
  }).observe(grid, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', placeInk);

  // Keyboard: [ ] step, 1–9 jump. Never inside a field, a dialog, or a mode
  // whose engines own the keys.
  const busy = () =>
    !!document.querySelector('dialog[open]') ||
    grid!.classList.contains('editing') ||
    grid!.classList.contains('wiring') ||
    !!(document.activeElement as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]');
  document.addEventListener('keydown', (e) => {
    if (pages.length < 2 || e.metaKey || e.ctrlKey || e.altKey || keyboardInUse(e) || busy()) return;
    const i = pages.findIndex((p) => p.id === current);
    if (e.key === '[' || e.key === ']') {
      const j = (i + (e.key === ']' ? 1 : -1) + pages.length) % pages.length;
      showPage(pages[j]!.id);
    } else if (/^[1-9]$/.test(e.key) && pages[+e.key - 1]) showPage(pages[+e.key - 1]!.id);
    else return;
    e.preventDefault();
  });

  // Touch swipe on the grid: 40px / 300ms, mostly horizontal, outside the
  // modes and outside content that pans on its own.
  let sw: { x: number; y: number; t: number } | null = null;
  grid.addEventListener(
    'pointerdown',
    (e) => {
      sw = null;
      if (e.pointerType !== 'touch' || pages.length < 2 || busy()) return;
      if ((e.target as Element).closest('canvas, iframe, .table-wrap, [contenteditable]')) return;
      sw = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    { passive: true }
  );
  grid.addEventListener(
    'pointerup',
    (e) => {
      if (!sw) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      const dt = performance.now() - sw.t;
      sw = null;
      if (Math.abs(dx) < 40 || Math.abs(dy) > 30 || dt > 300) return;
      const i = pages.findIndex((p) => p.id === current);
      const j = i + (dx < 0 ? 1 : -1);
      if (pages[j]) showPage(pages[j]!.id);
    },
    { passive: true }
  );
}
