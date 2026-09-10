import { readDesktopCheckpoint, saveDesktopState } from "./desktop-state.ts";
// Dashboard editing: a pointer drag engine (drag anywhere on a card, works
// on touch), right-click context menus on wards and the grid, the
// add/configure catalog dialog, and FLIP animation for every reorder.
//
// DOM order of [data-wd] inside #wd-grid is the order source of truth.
// In edit mode changes are session-local until Done (Cancel reloads);
// context-menu actions outside edit mode apply AND save immediately.

import { calcGeneratorDuration, spring } from 'motion';
import { icon, relabel } from './icon.ts';
import { validateLayout, validatePages, CATALOG, CHART_SOURCES, DEFAULT_LAYOUT, MAX_H, MAX_W, TASK_WARDS, httpUrl, notionIdFrom, sizeParts, wardTitle, type WardInstance, type WardSize } from '../../lib/wards.ts';
import { normalizeWardTheme, wardThemeAttrs, WARD_STYLE_PROPS, type WardTheme } from '../../lib/theme.ts';
import { ensureFonts } from './fonts.ts';
import { ACTIONS, TRIGGERS } from '../../lib/logic.ts';
import { registryDoes, searchCatalog } from '../../lib/catalog-search.ts';
import { TAB_ID, bootInstance, readLayout, refreshWardView, rerenderInstance, unbootInstance } from './wards.ts';
import { el, getJson, holdToFire, keyboardInUse, newId, normalizeUrl, postJson, q, reducedMotion, toast } from './dom.ts';
import { closeMenu, menuItem, openMenu } from './menu.ts';
import { currentPage, firstPage, pageOfCard, publishPages, readPages, restage, showPage } from './pages.ts';
import type { PageDef } from '../../lib/wards.ts';
import { popOutWard } from './ward-window.ts';
import { popoutWard } from './ward-view.ts';

const state = new Map<string, WardInstance>();
let grid: HTMLElement;

const isEditing = () => grid.classList.contains('editing');
const isWiring = () => grid.classList.contains('wiring');

// Groups: a `container` card's body holds a second .wd-grid (the nest) with
// its wards in it. Everything below walks cards through these four so the
// page grid and every nest are handled alike — DOM position, nesting
// included, stays the layout's source of truth.
/** Every card on the page, nested ones included, in document order. */
const allCards = (): HTMLElement[] => [...grid.querySelectorAll<HTMLElement>('[data-wd]')];
/** The grid a card sits in: #wd-grid, or a group's nest. */
const gridOf = (n: HTMLElement): HTMLElement => n.parentElement as HTMLElement;
/** The group card a card sits inside, if any. */
const groupOf = (n: HTMLElement): HTMLElement | null => n.parentElement?.closest<HTMLElement>('[data-wd]') ?? null;
/** A group card's nest. */
const nestOf = (card: HTMLElement): HTMLElement | null => card.querySelector<HTMLElement>(':scope > [data-body] > [data-nest]');
const isGroup = (n: HTMLElement) => n.dataset.wdType === 'container';

// -------------------------------------------------------------- animation
//
// ONE WRITER PER PROPERTY. Card motion runs on WAAPI with the spring baked
// into a CSS linear() easing at module load: inline style writes cannot
// fight a WAAPI animation, commitStyles() gives exact mid-flight
// retargeting, and the compositor runs it even when our rAF loop is busy.
// The drag engine writes style.transform ONLY on the dragged card, which
// never has a WAAPI animation while dragging. Never hand a card's transform
// to motion's JS driver (VisualElement.render overwrites the whole
// property), and never leave a WAAPI animation filling forwards on a card.

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** A spring pre-sampled into a CSS linear() easing. */
function springEase(o: { stiffness: number; damping: number; mass: number }) {
  const gen = spring({ keyframes: [0, 1], ...o });
  const duration = calcGeneratorDuration(gen);
  const pts: string[] = [];
  for (let t = 0; t <= duration; t += 10) pts.push(gen.next(t).value.toFixed(4));
  pts.push('1');
  return { duration, easing: `linear(${pts.join(',')})` };
}
const LINEAR_OK = typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', 'linear(0, 1)');
const ease = (s: { easing: string }) => (LINEAR_OK ? s.easing : EASE);

/** Displaced cards: slow controlled glide (ζ≈0.86, ~750ms, slight float). */
const GLIDE = springEase({ stiffness: 150, damping: 21, mass: 1 });
/** The dragged card settling / shells appearing: bouncier, quicker. */
const DROP = springEase({ stiffness: 380, damping: 26, mass: 0.9 });

/** Our animations only — never the entrance CSS animation or skeletons. */
const ours = (n: Element) => n.getAnimations().filter((a) => a.id.startsWith('fd-'));

/** Jump our animations to their end state so measurements are settled. */
function settle(nodes: Iterable<Element>): void {
  for (const n of nodes) {
    for (const a of ours(n)) a.cancel();
    (n as HTMLElement).style.transform = '';
    (n as HTMLElement).style.opacity = '';
  }
}

/** Halt but KEEP each card at its current visual position: commitStyles()
 *  writes the exact mid-flight transform inline, so the next FLIP glides
 *  from where the card actually is. */
function freeze(nodes: Iterable<Element>): void {
  for (const n of nodes) {
    for (const a of ours(n)) {
      try {
        a.commitStyles();
      } catch {
        /* detached node */
      }
      a.cancel();
    }
    (n as HTMLElement).style.opacity = '';
  }
}

// ------------------------------------------------------------------- FLIP

/** Mutate the grid, then glide every displaced card from its CURRENT visual
 *  position (mid-animation included) to its new slot — retargeting FLIP.
 *  Returns the settled post-mutation layout rects (the drag engine
 *  hit-tests these, never mid-animation positions). */
function flip(mutate: () => void, skip?: HTMLElement, origin?: { x: number; y: number }): Map<HTMLElement, DOMRect> {
  // The dragged card's own wards (a group being dragged) ride with it.
  const others = () => allCards().filter((n) => n !== skip && !skip?.contains(n));
  const items = others();
  freeze(items);
  // Visual positions, residual transforms included.
  const before = new Map(items.map((n) => [n, n.getBoundingClientRect()]));
  mutate();
  // A group's rows follow what its nest now holds — before anything is measured.
  fitGroups();
  // Clean layout rects: transforms don't affect grid layout, but they DO
  // affect getBoundingClientRect — clear them before measuring.
  for (const n of items) n.style.transform = '';
  const after = new Map(others().map((n) => [n, n.getBoundingClientRect()]));
  if (reducedMotion()) return after;
  for (const [n, a] of after) {
    const b = before.get(n);
    if (!b) continue;
    // A ward inside a group moves with the group: subtract the group's own
    // displacement, or the ward glides once on its own and once with its parent.
    const g = groupOf(n);
    const gb = g ? before.get(g) : undefined;
    const ga = g ? after.get(g) : undefined;
    const dx = b.left - a.left - (gb && ga ? gb.left - ga.left : 0);
    const dy = b.top - a.top - (gb && ga ? gb.top - ga.top : 0);
    if (!dx && !dy) continue;
    // Ripple: nearer cards move first. fill:'backwards' holds keyframe 0
    // through the delay — nothing to seat by hand, no flash.
    const delay = origin ? Math.min(60, Math.hypot(a.left + a.width / 2 - origin.x, a.top + a.height / 2 - origin.y) / 6) : 0;
    n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: GLIDE.duration,
      easing: ease(GLIDE),
      delay,
      fill: 'backwards',
      id: 'fd-flip',
    });
  }
  return after;
}

// ----------------------------------------------------------------- groups

const isOpen = (card: HTMLElement) => card.hasAttribute('data-open');

/** Logic mode only: the rows a group needs for its nest laid out IN FLOW,
 *  written to --wd-open-h (the span frost.css gives a wiring-mode group).
 *  Runs inside every flip() after the mutation and on every nest resize.
 *  Rows are the outer grid's track, so a nested ward is exactly as tall as
 *  it would be on the page. Everywhere else a group is exactly its own size
 *  and opens as a popover (setOpen), so there is nothing to fit. */
function fitGroups(): void {
  if (!isWiring()) return;
  const cs = getComputedStyle(grid);
  const rowH = parseFloat(cs.gridAutoRows) || 100;
  const gap = parseFloat(cs.rowGap) || 0;
  for (const card of grid.querySelectorAll<HTMLElement>(':scope > [data-wd-type="container"]')) {
    const nest = nestOf(card);
    if (!nest || getComputedStyle(nest).display === 'none') continue;
    const need = nest.getBoundingClientRect().bottom - card.getBoundingClientRect().top + (parseFloat(getComputedStyle(card).paddingBottom) || 0);
    const rows = String(Math.min(60, Math.max(2, Math.ceil((need + gap) / (rowH + gap)))));
    if (card.style.getPropertyValue('--wd-open-h') !== rows) card.style.setProperty('--wd-open-h', rows);
  }
}

/** Nest resizes (a window crossing a column breakpoint, a ward inside
 *  changing size) refit their group. One observer, every nest. */
const nestWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitGroups());

/** The peek strip (child icons) and count a closed group shows — rebuilt from
 *  the DOM after every mutation, since the DOM is where nesting lives. */
function syncGroups(): void {
  for (const card of grid.querySelectorAll<HTMLElement>('[data-wd-type="container"]')) {
    const peek = card.querySelector<HTMLElement>('[data-peek]');
    const nest = nestOf(card);
    if (!peek || !nest) continue;
    peek.textContent = '';
    const kids = ([...nest.children] as HTMLElement[]).filter((k) => !k.hasAttribute('data-wd-hidden'));
    for (const k of kids) {
      const kw = state.get(k.dataset.wd ?? '');
      if (!kw) continue;
      peek.append(icon(CATALOG[kw.type]?.icon ?? 'dot', '', wardTitle(kw)));
    }
    if (!kids.length) peek.append(el('span', 'text-xs text-ink-faint', 'Empty group'));
    const st = card.querySelector<HTMLElement>(':scope > header .wd-status');
    if (st) st.textContent = kids.length ? String(kids.length) : '';
  }
}

/** The open panel is absolutely positioned off the card: these two vars put
 *  its left edge on the page grid's left edge and make it the grid's width,
 *  whatever column the card sits in. */
function placePop(card: HTMLElement): void {
  const g = grid.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  card.style.setProperty('--wd-pop-x', `${g.left - c.left}px`);
  card.style.setProperty('--wd-pop-w', `${g.width}px`);
}

const openGroups = () => [...grid.querySelectorAll<HTMLElement>(':scope > [data-wd-type="container"][data-open]')];

/** Open a group as a panel floating over the wards beneath it (nothing on
 *  the page moves), or fold it back. One open at a time — two panels would
 *  overlap. Not remembered: a popover has no business surviving a reload. */
function setOpen(card: HTMLElement, open: boolean): void {
  if (isOpen(card) === open) return;
  if (open) for (const other of openGroups()) if (other !== card) setOpen(other, false);
  card.toggleAttribute('data-open', open);
  if (open) placePop(card);
  card.querySelector(':scope > header')?.setAttribute('aria-expanded', String(open));
  card.querySelector('.wd-chevron')?.setAttribute('aria-expanded', String(open));
  if (!open) return;
  (nestOf(card)?.querySelectorAll<HTMLElement>('[data-wd]') ?? []).forEach((kid, i) => {
    // Charts bake their height at mount; one that mounted while this group
    // was closed painted into 0px.
    const kw = state.get(kid.dataset.wd ?? '');
    if (kw?.type === 'chart') rerenderInstance(kw);
    if (reducedMotion()) return;
    kid.classList.remove('wd-enter');
    void kid.offsetWidth; // restart the CSS entrance
    kid.style.animationDelay = `${i * 30}ms`;
    kid.classList.add('wd-enter');
  });
}

/** Tap (or Enter/Space on the header) toggles a group outside Edit and Logic
 *  mode; the chevron button toggles it in Edit mode too (bootActions). A
 *  click anywhere else, or Escape, folds it. Logic mode holds every group
 *  open in flow instead, so wires can reach every ward. */
function bootGroups(): void {
  for (const nest of grid.querySelectorAll<HTMLElement>('[data-nest]')) nestWatch?.observe(nest);
  // Logic mode is a class flip on the grid (from logic-edit.ts): the moment
  // it lands every group is open in flow and needs rows; popovers fold.
  new MutationObserver(() => {
    if (isWiring()) for (const c of openGroups()) setOpen(c, false);
    fitGroups();
  }).observe(grid, { attributes: true, attributeFilter: ['class'] });
  // The panel is grid-wide: a window resize re-places every open one.
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => openGroups().forEach(placePop)).observe(grid);

  const toggleFrom = (t: HTMLElement) => {
    if (isEditing() || isWiring()) return false;
    if (t.closest('button, a, input, textarea, select, [data-nest]')) return false;
    const card = t.closest<HTMLElement>('[data-wd-type="container"]');
    if (!card || groupOf(card)) return false;
    setOpen(card, !isOpen(card));
    return true;
  };
  grid.addEventListener('click', (e) => void toggleFrom(e.target as HTMLElement));
  grid.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !(e.target as HTMLElement).matches('[data-wd-type="container"] > header')) return;
    if (toggleFrom(e.target as HTMLElement)) e.preventDefault();
  });
  // Outside click folds the panel — but not a click inside it or on its own
  // card, and not one on a menu or dialog the panel opened.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.ctx-menu, dialog, .fd-toast')) return;
    for (const c of openGroups()) if (!c.contains(t)) setOpen(c, false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    for (const c of openGroups()) setOpen(c, false);
  });
}

// ------------------------------------------------------------------- tray

/** Edit mode's home for hidden wards: they cost no grid slot, so this strip
 *  under the grid is where they are found and shown again. Rebuilt from
 *  state after every mutation (record) and on every edit-mode flip. */
let trayEl: HTMLElement | null = null;
function syncTray(): void {
  if (!trayEl) return;
  // This page's hidden wards only — the tray sits under this page's grid.
  const hidden = layoutOf().filter((w) => w.hidden && pageOfCard(w.i) === currentPage());
  trayEl.hidden = !isEditing() || !hidden.length;
  if (trayEl.hidden) return;
  trayEl.textContent = '';
  trayEl.append(el('span', undefined, 'Hidden:'));
  for (const w of hidden) {
    const chip = el('span', 'wd-tray-chip');
    chip.append(icon(CATALOG[w.type]?.icon ?? 'dot'), el('span', undefined, ` ${wardTitle(w)}`));
    const b = el('button', undefined, 'Show') as HTMLButtonElement;
    b.type = 'button';
    b.title = 'Back on the dashboard, in its old spot';
    b.addEventListener('click', () => {
      const node = grid.querySelector<HTMLElement>(`[data-wd="${w.i}"]`);
      if (node) toggleHidden(node, w);
    });
    chip.append(b);
    trayEl.append(chip);
  }
}

// ------------------------------------------------------------ persistence

/** Keep the SSR layout island current — readLayout() consumers (the logic
 *  editor stamps ports and validates edges against it) must not see the
 *  page-load snapshot after wards were added or removed. The ONE writer, used
 *  by our own save and by a server-pushed layout alike. */
function publishLayout(layout: WardInstance[]): void {
  const island = document.getElementById('layout-data');
  if (island) island.textContent = JSON.stringify(layout).replaceAll('<', '\\u003c');
  // Server-validated wards resolve against the STORED layout — the ones that
  // rendered before this save (agent wards added in edit mode) can try again.
  document.dispatchEvent(new CustomEvent('fd:layout-saved'));
}

// ------------------------------------------------------------------- undo
//
// A stack of whole layouts. Every mutation — drag, resize, the size matrix,
// hide, remove, duplicate, the configure dialog, an agent push — funnels
// through commit()/commitThenRender(), so recording the PREVIOUS layout there
// is the one hook that covers all of them.

const undoStack: WardInstance[][] = [];
// Document moves stay beside the layout draft until Done; restoring a card cancels its move.
const noteMoves = new Map<string, { id: string; notebook: string }>();
/** The layout as of the last recorded point, and its identity. */
let baseline: WardInstance[] = [];
let baseKey = '';
let syncUndo = (): void => {};

/** The layout as the DOM has it: document order, and `in` from whichever
 *  group's nest a card sits in — the ONE place nesting is read back. */
const layoutOf = (): WardInstance[] =>
  allCards()
    .map((n) => {
      const w = state.get(n.dataset.wd ?? '');
      if (!w) return null;
      const g = groupOf(n)?.dataset.wd;
      if (g) w.in = g;
      else delete w.in;
      // The page too: a top-level card's data-page (absent = the first page);
      // a nested card follows its group.
      const pg = g ? undefined : n.dataset.page;
      if (pg && pg !== firstPage()) w.page = pg;
      else delete w.page;
      return w;
    })
    .filter((w): w is WardInstance => !!w);

/** Field order is not stable across Object.assign, so compare a fixed shape. */
const layoutKey = (l: WardInstance[]) =>
  JSON.stringify(l.map((w) => [w.i, w.type, w.size, w.title ?? null, w.hidden ?? false, w.in ?? null, w.page ?? null, w.device ?? null, w.theme ?? null, w.config ?? null]));

function record(): void {
  syncGroups();
  syncTray();
  const now = layoutOf();
  for (const w of now) noteMoves.delete(w.i);
  const key = layoutKey(now);
  if (key === baseKey) return;
  undoStack.push(baseline);
  if (undoStack.length > 40) undoStack.shift();
  baseline = structuredClone(now);
  baseKey = key;
  syncUndo();
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  const wasBase = baseline;
  const wasKey = baseKey;
  // Set the baseline FIRST: the apply ends in commit(), and record() must see
  // the restored layout as already-known rather than push a step for it.
  baseline = prev;
  baseKey = layoutKey(prev);
  syncUndo();
  if (applyLayout(structuredClone(prev), new Set(), true)) return;
  baseline = wasBase;
  baseKey = wasKey;
  undoStack.push(prev);
  syncUndo();
  toast('Could not undo that right now.', undefined, true);
}

async function save(): Promise<boolean> {
  const layout = layoutOf();
  // `from` comes back on the broadcast so our own tabs can tell this edit
  // apart from someone else's and skip re-animating it.
  // Credentials typed into a ward's Configure dialog ride BESIDE the layout —
  // the server seals them; they never enter layout_json or the other tabs.
  const tokens = Object.fromEntries(pendingSecrets);
  const { ok } = await postJson('/api/dashboard', { layout, pages: readPages(), from: TAB_ID, ...(pendingSecrets.size ? { tokens } : {}), ...(noteMoves.size ? { noteMoves: [...noteMoves.values()] } : {}) }, 'PUT');
  if (ok) {
    pendingSecrets.clear();
    noteMoves.clear();
    publishLayout(layout);
  }
  return ok;
}

/** Outside edit mode every action persists immediately; inside, Done saves. */
function commit(): void {
  record();
  if (isEditing()) return;
  void save().then((ok) => {
    if (!ok) toast('Saving the layout failed.', undefined, true);
  });
}

/** Commit, THEN render. Server-validated wards (timer/checklist/flow)
 *  resolve their ward against the STORED layout — rendering before the save
 *  lands 404s them (checklist would even show a misleading Connect chip).
 *  In edit mode nothing persists until Done, so render immediately and let
 *  the ward sit in its unavailable state — the save will repaint it. */
function commitThenRender(render: () => void): void {
  record();
  if (isEditing()) {
    render();
    return;
  }
  void save().then((ok) => {
    if (!ok) toast('Saving the layout failed.', undefined, true);
    render();
  });
}

// ---------------------------------------------------------------- actions

function moveStep(node: HTMLElement, dir: -1 | 1): void {
  const target = dir === -1 ? node.previousElementSibling : node.nextElementSibling;
  if (!target) return;
  flip(() => (dir === -1 ? gridOf(node).insertBefore(node, target) : gridOf(node).insertBefore(target, node)));
  commit();
}

/** Into a group's nest, or back to the page grid. */
function moveInto(node: HTMLElement, parent: HTMLElement): void {
  if (gridOf(node) === parent) return;
  flip(() => parent.append(node));
  commit();
}

/** Another page: restamp, restage (the card leaves this stage), commit. */
function moveToPage(node: HTMLElement, page: string): void {
  flip(() => {
    stampPage(node, page === firstPage() ? undefined : page);
    restage();
  });
  commit();
  const title = readPages().find((p) => p.id === page)?.title ?? page;
  toast(`Moved to ${title}`, { label: 'Go', fn: () => showPage(page) });
}

/** The ONE writer of a card's span. Width is a class (it clamps per breakpoint),
 *  height an inline --wd-h (it never does) — see the .wd-w* block in frost.css. */
function stampSize(node: HTMLElement, size: string): void {
  const [cols, rows] = sizeParts(size);
  node.classList.remove(...[...node.classList].filter((c) => /^wd-w\d+$/.test(c)));
  node.classList.add(`wd-w${cols}`);
  node.style.setProperty('--wd-h', String(rows));
}

/** The ONE writer of a card's hidden state. Off the dashboard, still in the
 *  grid — edit and logic mode reveal it (see [data-wd-hidden] in frost.css). */
function stampHidden(node: HTMLElement, hidden: boolean): void {
  node.toggleAttribute('data-wd-hidden', hidden);
}

/** The ONE writer of a card's page (pages.ts stages by it; layoutOf reads it back). */
function stampPage(node: HTMLElement, page: string | undefined): void {
  if (page) node.dataset.page = page;
  else delete node.dataset.page;
}

/** The ONE writer of a card's own theme. The style attribute also carries
 *  layout values (--wd-h, the entrance delay), so it clears exactly the
 *  properties wardThemeStyle can write and leaves the rest alone. */
function stampWardTheme(node: HTMLElement, t?: WardTheme): void {
  for (const prop of WARD_STYLE_PROPS) node.style.removeProperty(prop);
  for (const attr of ['data-ward-theme', 'data-ward-surfaced', 'data-ward-glass', 'data-ward-glass-blur', 'data-ward-mode']) {
    node.removeAttribute(attr);
  }
  const attrs = wardThemeAttrs(t);
  for (const [k, v] of Object.entries(attrs)) if (k !== 'style') node.setAttribute(k, v);
  // Parsed rather than assigned: `style.cssText = ` would drop --wd-h with it.
  for (const decl of (attrs.style ?? '').split(';')) {
    const at = decl.indexOf(':');
    if (at > 0) node.style.setProperty(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
}

/** One ward's theme (components/dashboard/WardThemeDialog.astro). Previews on
 *  every input — the card IS the preview — and saves once a drag settles. */
function openThemeDialog(node: HTMLElement, w: WardInstance): void {
  const dlg = q<HTMLDialogElement>('#ward-theme');
  if (!dlg) return;
  const el = <T extends HTMLElement>(id: string) => q<T>(`#tt-${id}`, dlg)!;
  const GROUPS = { colours: ['accent', 'surface', 'line'], shape: ['radius', 'border', 'rim', 'shadow'], glass: ['glassAlpha', 'glassBlur'] } as const;

  // An unset colour opens on whatever the page is using, so a ward starts
  // where the dashboard is rather than at black.
  const page = getComputedStyle(document.documentElement);
  const inherited = (prop: string, fallback: string) => {
    const v = page.getPropertyValue(prop).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };
  const num = (id: string) => Number((el<HTMLInputElement>(id)).value);

  const read = (): WardTheme | undefined => {
    const on = (g: keyof typeof GROUPS) => (el<HTMLInputElement>(g)).checked;
    const raw: Record<string, unknown> = {
      font: (el<HTMLSelectElement>('font')).value,
      mode: (el<HTMLSelectElement>('mode')).value,
      density: (el<HTMLSelectElement>('density')).value,
    };
    for (const [g, keys] of Object.entries(GROUPS)) {
      if (!on(g as keyof typeof GROUPS)) continue;
      for (const k of keys) raw[k] = k === 'accent' || k === 'surface' || k === 'line' ? (el<HTMLInputElement>(k)).value : num(k);
    }
    return normalizeWardTheme(raw);
  };

  const t = w.theme ?? {};
  (el<HTMLSelectElement>('font')).value = t.font ?? '';
  (el<HTMLSelectElement>('mode')).value = t.mode ?? '';
  (el<HTMLSelectElement>('density')).value = t.density ?? '';
  (el<HTMLInputElement>('accent')).value = t.accent ?? inherited('--fd-accent', '#17c8f4');
  (el<HTMLInputElement>('surface')).value = t.surface ?? inherited('--fd-surface', '#0d1b2e');
  (el<HTMLInputElement>('line')).value = t.line ?? inherited('--fd-line', '#16283f');
  (el<HTMLInputElement>('radius')).value = String(t.radius ?? 0.5);
  (el<HTMLInputElement>('border')).value = String(t.border ?? 1);
  (el<HTMLInputElement>('rim')).value = String(t.rim ?? 0);
  (el<HTMLInputElement>('shadow')).value = String(t.shadow ?? 0);
  (el<HTMLInputElement>('glassAlpha')).value = String(t.glassAlpha ?? 1);
  (el<HTMLInputElement>('glassBlur')).value = String(t.glassBlur ?? 0);
  (el<HTMLInputElement>('colours')).checked = !!(t.accent || t.surface || t.line);
  (el<HTMLInputElement>('shape')).checked = t.radius !== undefined || t.border !== undefined || t.rim !== undefined || t.shadow !== undefined;
  (el<HTMLInputElement>('glass')).checked = t.glassAlpha !== undefined || t.glassBlur !== undefined;
  q('[data-tt-title]', dlg)!.textContent = `Theme — ${wardTitle(w)}`;

  let pending = 0;
  const apply = () => {
    for (const pane of dlg.querySelectorAll<HTMLElement>('[data-tt-group]')) {
      pane.hidden = !(el<HTMLInputElement>(pane.dataset.ttGroup!)).checked;
    }
    for (const out of dlg.querySelectorAll<HTMLElement>('[data-tt-val]')) {
      out.textContent = (el<HTMLInputElement>(out.dataset.ttVal!)).value;
    }
    const next = read();
    if (next) w.theme = next;
    else delete w.theme;
    ensureFonts([next?.font]);
    stampWardTheme(node, next);
    // One save per drag, not one per frame.
    clearTimeout(pending);
    pending = window.setTimeout(commit, 400);
  };

  dlg.oninput = apply;
  dlg.onchange = apply;
  q<HTMLButtonElement>('[data-tt-reset]', dlg)!.onclick = () => {
    for (const g of Object.keys(GROUPS)) (el<HTMLInputElement>(g)).checked = false;
    for (const id of ['font', 'mode', 'density']) (el<HTMLSelectElement>(id)).value = '';
    apply();
  };
  apply();
  dlg.showModal();
}

function toggleHidden(node: HTMLElement, w: WardInstance): void {
  if (w.hidden) delete w.hidden;
  else w.hidden = true;
  flip(() => stampHidden(node, !!w.hidden));
  commit();
  toast(w.hidden ? `${wardTitle(w)} hidden — find it in the tray under the grid while editing.` : `${wardTitle(w)} back on the dashboard.`);
}

/** Returns FLIP's settled rects so a live resize can re-read its own origin
 *  without measuring a card mid-animation. `refresh` off = caller repaints later. */
function applySize(node: HTMLElement, w: WardInstance, size: WardSize, refresh = true): Map<HTMLElement, DOMRect> {
  if (w.size === size) return new Map();
  const rects = flip(() => {
    stampSize(node, size);
    w.size = size;
  });
  // Charts bake clientHeight into the SVG at mount and the list wards take
  // their item cap from the row count — both need a repaint at the new size.
  // `refresh` off is a live resize step: the engine's end() saves the settled
  // size, so committing per quantised step would be one PUT (and one undo
  // step) per cell crossed.
  if (refresh) {
    commit();
    rerenderInstance(w);
  }
  return rects;
}

function removeWard(node: HTMLElement, w: WardInstance): void {
  const parent = gridOf(node);
  const index = [...parent.children].indexOf(node);
  // A group leaves alone: its wards step out into its place (nothing is lost
  // — a browser ward's profile goes with the ward, not the folder).
  const kids = [...(nestOf(node)?.children ?? [])] as HTMLElement[];
  state.delete(w.i);
  unbootInstance(w.i);
  const drop = () => {
    flip(() => {
      for (const k of kids) parent.insertBefore(k, node);
      node.remove();
    }, node);
    commit();
  };
  if (reducedMotion()) drop();
  else {
    node.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.94)' }], { duration: 150, easing: EASE, fill: 'forwards', id: 'fd-exit' });
    setTimeout(drop, 150);
  }
  toast(`Removed ${wardTitle(w)}`, {
    label: 'Undo',
    fn: () => {
      state.set(w.i, w);
      const shell = newShell(w);
      if (!shell) return;
      flip(() => {
        parent.insertBefore(shell, parent.children[index] ?? null);
        const nest = nestOf(shell);
        if (nest) for (const k of kids) if (k.isConnected) nest.append(k);
      });
      applyTitle(w);
      revealShell(shell);
      commitThenRender(() => {
        rerenderInstance(w);
        bootInstance(w);
      });
    },
  });
}

function duplicateWard(node: HTMLElement, w: WardInstance): void {
  const copy: WardInstance = {
    i: newId('w'),
    type: w.type,
    size: w.size,
    ...(w.title ? { title: w.title } : {}),
    ...(w.hidden ? { hidden: true } : {}),
    ...(w.page ? { page: w.page } : {}),
    ...(w.theme ? { theme: { ...w.theme } } : {}),
    ...(w.config ? { config: JSON.parse(JSON.stringify(w.config)) } : {}),
  };
  state.set(copy.i, copy);
  const shell = newShell(copy);
  if (!shell) return;
  flip(() => gridOf(node).insertBefore(shell, node.nextElementSibling));
  applyTitle(copy);
  revealShell(shell);
  commitThenRender(() => bootInstance(copy));
}

function revealShell(shell: HTMLElement): void {
  if (reducedMotion()) return;
  shell.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], {
    duration: DROP.duration,
    easing: ease(DROP),
    id: 'fd-reveal',
  });
}

// --------------------------------------------------- server-pushed layouts
//
// The agent rewrites the layout server-side and the new one arrives on the
// logic SSE stream. Applying it here instead of reloading is the whole point:
// the card appears while the agent is still mid-sentence, on the same springs
// a drag uses. Everything below reuses the drag engine's primitives — flip(),
// newShell(), revealShell(), stampSize() — and never calls commit(), because
// the server has already stored what we are being told about.

const TOUCH_MS = 1200;

/** A push we could not apply must leave live wards and unsaved work mounted. */
function refuseLayout(): void {
  toast('The agent changed your layout.', { label: 'Reload', fn: () => location.reload() });
}

const onScreen = (n: Element): boolean => {
  const b = n.getBoundingClientRect();
  return b.bottom > 0 && b.top < innerHeight;
};

/** Mark the cards a push touched, and bring the first one into view.
 *  `held` names wards streaming an agent turn: if one is on screen the user is
 *  reading it, and scrolling the page out from under them to show the result
 *  is worse than letting the ring alone mark it. 'nearest' over 'center' for
 *  the same reason — move the viewport as little as the job needs. */
function highlight(nodes: HTMLElement[], held: Set<string>): void {
  const first = nodes[0];
  if (!first) return;
  for (const n of nodes) {
    n.dataset.agentTouch = '1';
    setTimeout(() => delete n.dataset.agentTouch, TOUCH_MS);
  }
  if (onScreen(first)) return;
  for (const id of held) {
    const card = grid.querySelector(`[data-wd="${id}"]`);
    if (card && onScreen(card)) return;
  }
  first.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

/** Same fields, ignoring key order (both sides come out of validateLayout). */
const sameCfg = (a: WardInstance, b: WardInstance) =>
  JSON.stringify([a.title ?? null, a.hidden ?? false, a.config ?? null]) ===
  JSON.stringify([b.title ?? null, b.hidden ?? false, b.config ?? null]);

let applying = false;
let queued: { layout: WardInstance[]; pages?: PageDef[] } | null = null;

/**
 * Apply a server-pushed layout to the live grid, animated. Returns false when
 * it must not — edit mode, a missing template, or a held ward in the diff — and
 * the caller falls back to the reload, which is exactly today's behaviour.
 *
 * `held` names wards with a streaming agent turn on them: removing or
 * repainting one would eat the transcript the user is reading, so the whole
 * apply defers to the end of the turn rather than half-applying.
 */
export function applyLayout(next: WardInstance[], held: Set<string> = new Set(), local = false, pages?: PageDef[]): boolean {
  if (!grid || (isEditing() && !local)) return false;
  // An apply waits 150ms for the exit fade before it touches the grid. A second
  // push arriving inside that window would diff against a grid the first has
  // not mutated yet — building a SECOND shell for a ward the first is already
  // adding, and inserting both. Only the newest layout matters, so hold it.
  if (applying) {
    // Only a server push may queue — `queued` carries no local flag, and an
    // undo that silently lands 150ms later is worse than one that says no.
    if (local) return false;
    queued = { layout: next, pages };
    return true;
  }

  // Diff first, with NO writes to the grid: a bail must leave it untouched.
  const nodes = new Map(allCards().map((n) => [n.dataset.wd ?? '', n]));
  const keep = new Set(next.map((w) => w.i));
  const gone = [...nodes].filter(([id]) => !keep.has(id));
  const shells = new Map<string, HTMLElement>();
  const added: WardInstance[] = [];
  const repaint: WardInstance[] = [];

  for (const w of next) {
    const cur = state.get(w.i);
    const node = nodes.get(w.i);
    if (cur && node && cur.type !== w.type) return false; // no tool does this; a reload is always right
    if (!cur || !node) {
      const shell = newShell(w);
      if (!shell) return false; // no #wd-template — let the reload handle it
      shells.set(w.i, shell);
      added.push(w);
    } else if (cur.size !== w.size || !sameCfg(cur, w)) {
      repaint.push(w);
    }
  }
  // Order (or nesting) changed? Compare the surviving ids, each with the
  // group it sits in, against their pushed order.
  const before = [...nodes]
    .filter(([id]) => keep.has(id))
    .map(([id, n]) => `${groupOf(n)?.dataset.wd ?? ''}/${n.dataset.page ?? ''}/${id}`)
    .join(' ');
  const after = next.filter((w) => nodes.has(w.i)).map((w) => `${w.in ?? ''}/${w.page ?? ''}/${w.i}`).join(' ');
  if (!gone.length && !added.length && !repaint.length && before === after) {
    if (pages) publishPages(pages);
    return true;
  }

  if (held.size && [...gone.map(([id]) => id), ...repaint.map((w) => w.i)].some((id) => held.has(id))) return false;
  // The configure dialog holds a ward id; deleting that ward out from under it
  // leaves its Save handler dereferencing a ward that no longer exists.
  if (editingId && !keep.has(editingId)) return false;

  const touched: HTMLElement[] = [];
  const settleIn = () => {
    // A turn may start during the exit animation, after the initial hold check.
    if ([...gone.map(([id]) => id), ...repaint.map(w => w.i)].some(id => held.has(id))) {
      for (const [, node] of gone) for (const animation of node.getAnimations()) if (animation.id === 'fd-exit') animation.cancel();
      applying = false;
      queued = null;
      refuseLayout();
      return;
    }
    flip(() => {
      for (const [id, node] of gone) {
        node.remove();
        state.delete(id);
        unbootInstance(id);
      }
      // Walk the target order per grid, moving ONLY what is out of place:
      // re-appending a node that is already correct would reload any iframe
      // inside it. Top-level wards first, so every group exists (and has a
      // nest) before the wards inside it are placed.
      const parentFor = (w: WardInstance): HTMLElement => {
        const g = w.in ? (nodes.get(w.in) ?? shells.get(w.in)) : undefined;
        return (g && nestOf(g)) || grid;
      };
      const cursors = new Map<HTMLElement, Element | null>();
      for (const w of [...next.filter((x) => !x.in), ...next.filter((x) => x.in)]) {
        const node = nodes.get(w.i) ?? shells.get(w.i)!;
        const cur = state.get(w.i);
        if (cur && cur.size !== w.size) stampSize(node, w.size);
        if (!cur || !!cur.hidden !== !!w.hidden) stampHidden(node, !!w.hidden);
        if (!cur || cur.page !== w.page) stampPage(node, w.page);
        if (!cur || JSON.stringify(cur.theme) !== JSON.stringify(w.theme)) stampWardTheme(node, w.theme);
        const parent = parentFor(w);
        let cursor = cursors.has(parent) ? cursors.get(parent)! : parent.firstElementChild;
        if (node === cursor) cursor = cursor.nextElementSibling;
        else parent.insertBefore(node, cursor);
        cursors.set(parent, cursor);
      }
    });

    for (const w of next) {
      // MUTATE the stored instance — renderer polls close over the object, so
      // replacing it would leave them repainting the old config forever.
      const cur = state.get(w.i);
      if (!cur) state.set(w.i, w);
      else {
        Object.assign(cur, w);
        if (w.title === undefined) delete cur.title;
        if (w.config === undefined) delete cur.config;
        // Object.assign cannot remove a key: without this an unhidden ward
        // keeps hidden:true in state and the next save re-hides it.
        if (w.hidden === undefined) delete cur.hidden;
        if (w.theme === undefined) delete cur.theme;
        if (w.in === undefined) delete cur.in;
        if (w.page === undefined) delete cur.page;
      }
      applyTitle(state.get(w.i)!);
    }
    // BEFORE the renderers mount: a server-validated ward resolves itself
    // against readLayout(), which reads the island this writes. The page
    // list and the stage follow, so an added ward on another page boots
    // off stage (its poll waits) rather than painting into thin air.
    publishLayout(next);
    if (pages) publishPages(pages);
    restage();
    refreshWardView();
    for (const w of added) {
      const shell = shells.get(w.i)!;
      revealShell(shell);
      touched.push(shell);
      bootInstance(state.get(w.i)!);
    }
    for (const w of repaint) {
      rerenderInstance(state.get(w.i)!);
      const node = nodes.get(w.i);
      if (node) touched.push(node);
    }
    highlight(touched, held);
    // A local apply is ours to store; a server push is already stored, and
    // only needs the undo baseline moved on so the next edit does not
    // "undo" someone else's change along with its own.
    if (local) commit();
    else record();
    applying = false;
    if (queued) {
      const q = queued;
      queued = null;
      // `held` is the caller's live Set, still current. If the newest layout
      // can no longer be applied — the user entered edit mode or opened the
      // configure dialog during the fade — there is no caller left to fall
      // back for us, so do it here.
      if (!applyLayout(q.layout, held, false, q.pages)) refuseLayout();
    }
  };

  // Removed cards fade out first, then everything settles into the gap — the
  // same two-step removeWard uses.
  if (!gone.length || reducedMotion()) settleIn();
  else {
    applying = true;
    for (const [, node] of gone) {
      node.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.94)' }], { duration: 150, easing: EASE, fill: 'forwards', id: 'fd-exit' });
    }
    setTimeout(settleIn, 150);
  }
  return true;
}

// ------------------------------------------------------------ drag engine

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Exchange two siblings' DOM positions (adjacency-safe). */
function swapNodes(a: HTMLElement, b: HTMLElement): void {
  const marker = document.createComment('');
  a.parentNode!.insertBefore(marker, a);
  b.parentNode!.insertBefore(a, b);
  marker.parentNode!.insertBefore(b, marker);
  marker.remove();
}

function bootDrag(): void {
  let node: HTMLElement | null = null;
  let started = false;
  let justDragged = false;
  let sx = 0;
  let sy = 0;
  let grabX = 0;
  let grabY = 0;
  let home: RectLike | null = null;
  /** Settled layout rects — hit-testing never reads mid-animation positions. */
  let slots = new Map<HTMLElement, RectLike>();
  let lastX = 0;
  let lastY = 0;
  let raf = 0;
  let liftAt = 0;
  /** Belt-and-braces swap debounce (the inset hit-test is the real brake). */
  let lastSwapAt = 0;
  let orderChanged = false;
  /** Where the card came from, for Escape-to-revert. */
  let originNext: Element | null = null;
  let originParent: HTMLElement | null = null;
  let hotNotebook: HTMLElement | null = null;
  const clearNotebook = () => {
    hotNotebook?.removeAttribute('data-drop-hot');
    hotNotebook?.querySelector('[data-notebook-drop-label]')?.remove();
    hotNotebook = null;
  };
  /** Edge auto-scroll arms only after the pointer has been OUTSIDE the edge
   *  band — grabbing a card that sits near the viewport edge must not creep. */
  let armedEdge = false;
  // Scroll baseline for the current home/slots measurements: when the page
  // scrolls mid-drag (wheel, pinch, or our own edge auto-scroll), every
  // client-space rect shifts — compensate instead of going stale.
  let baseScrollX = 0;
  let baseScrollY = 0;

  const scrollPos = () => ({
    x: window.scrollX + (window.visualViewport?.offsetLeft ?? 0),
    y: window.scrollY + (window.visualViewport?.offsetTop ?? 0),
  });

  const syncScrollBase = () => {
    const p = scrollPos();
    baseScrollX = p.x;
    baseScrollY = p.y;
  };

  const onScroll = () => {
    if (!started) return;
    const p = scrollPos();
    const dx = p.x - baseScrollX;
    const dy = p.y - baseScrollY;
    if (!dx && !dy) return;
    syncScrollBase();
    if (home) home = { left: home.left - dx, top: home.top - dy, right: home.right - dx, bottom: home.bottom - dy };
    const next = new Map<HTMLElement, RectLike>();
    for (const [n, r] of slots) next.set(n, { left: r.left - dx, top: r.top - dy, right: r.right - dx, bottom: r.bottom - dy });
    slots = next;
  };

  const measureHome = () => {
    if (!node) return;
    node.style.transform = '';
    home = node.getBoundingClientRect();
  };

  const position = () => {
    if (!node || !home) return;
    // Lift scale ramps in over 120ms instead of snapping on grab.
    const s = 1 + 0.04 * Math.min(1, (performance.now() - liftAt) / 120);
    node.style.transform = `translate(${lastX - grabX - home.left}px, ${lastY - grabY - home.top}px) scale(${s.toFixed(4)})`;
  };

  // Drag onto a page tab: the chip lights, a 400ms dwell switches page with
  // the card in hand (the same idiom as dropping into a group). Escape puts
  // it back on the page it came from.
  let hotTab: HTMLElement | null = null;
  let dwellT = 0;
  let originPage: string | undefined;
  const clearTab = () => {
    hotTab?.removeAttribute('data-drop-hot');
    hotTab = null;
    if (dwellT) clearTimeout(dwellT);
    dwellT = 0;
  };
  const measureSlots = () => {
    slots = new Map(allCards().filter((n) => n !== node && !node!.contains(n)).map((n) => [n, n.getBoundingClientRect()]));
  };
  const crossTo = (page: string) => {
    if (!node) return;
    stampPage(node, page === firstPage() ? undefined : page);
    showPage(page, { instant: true });
    orderChanged = true;
    settle(allCards());
    measureHome();
    measureSlots();
    syncScrollBase();
  };
  const tabWatch = () => {
    if (!node || !started) return;
    let tab: HTMLElement | null = null;
    for (const b of document.querySelectorAll<HTMLElement>('[data-page-tab]')) {
      const r = b.getBoundingClientRect();
      if (lastX >= r.left && lastX <= r.right && lastY >= r.top && lastY <= r.bottom) tab = b;
    }
    if (tab === hotTab) return;
    clearTab();
    if (!tab || tab.dataset.pageTab === currentPage()) return;
    hotTab = tab;
    tab.setAttribute('data-drop-hot', '1');
    dwellT = window.setTimeout(() => {
      dwellT = 0;
      if (node && hotTab === tab) crossTo(tab.dataset.pageTab!);
    }, 400);
  };

  const lift = () => {
    if (!node) return;
    started = true;
    liftAt = performance.now();
    orderChanged = false;
    originNext = node.nextElementSibling;
    originParent = gridOf(node);
    originPage = node.dataset.page;
    settle(allCards());
    node.dataset.dragging = '1';
    measureHome();
    measureSlots();
    syncScrollBase();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.visualViewport?.addEventListener('scroll', onScroll, { passive: true });
    window.visualViewport?.addEventListener('resize', onScroll, { passive: true });
  };

  const reorder = () => {
    if (!node) return;
    // Spatial hysteresis: only count a card as the target when the pointer is
    // meaningfully INSIDE it (25% inset dead band per edge) — boundary jitter
    // becomes physically unable to re-trigger swaps.
    let over: HTMLElement | null = null;
    // Deepest first: a group's rect contains its wards' rects, and document
    // order puts the group before them. A group's own dead band is thin — its
    // empty floor is the drop zone for "into this group".
    for (const [n, r] of [...slots].reverse()) {
      if (n === node || r.right <= r.left) continue; // a ward folded inside a closed group has no box
      const f = isGroup(n) ? 0.06 : 0.25;
      const ix = (r.right - r.left) * f;
      const iy = (r.bottom - r.top) * f;
      if (lastX >= r.left + ix && lastX <= r.right - ix && lastY >= r.top + iy && lastY <= r.bottom - iy) {
        over = n;
        break;
      }
    }
    const book = node.dataset.wdType === 'note' && over?.dataset.wdType === 'notebook' ? over : null;
    if (book !== hotNotebook) {
      clearNotebook();
      if (book) {
        hotNotebook = book;
        book.setAttribute('data-drop-hot', '1');
        const label = el('div', 'wd-notebook-drop', 'Move to notebook');
        label.dataset.notebookDropLabel = '1';
        label.setAttribute('role', 'status');
        book.append(label);
      }
    }
    if (hotNotebook) return;
    const now = performance.now();
    if (now - lastSwapAt < 60) return;
    const flipTo = (mutate: () => void) => {
      slots = flip(mutate, node!, { x: lastX, y: lastY });
      measureHome();
      syncScrollBase();
      orderChanged = true;
      lastSwapAt = now;
    };
    // Over the empty floor of an OPEN group's panel (the panel is not a card,
    // so it is not in slots): into it.
    if (!over && !isGroup(node)) {
      for (const g of openGroups()) {
        const nest = nestOf(g);
        if (!nest || gridOf(node) === nest) continue;
        const r = nest.getBoundingClientRect();
        if (lastX >= r.left && lastX <= r.right && lastY >= r.top && lastY <= r.bottom) {
          flipTo(() => nest.append(node!));
          return;
        }
      }
    }
    if (!over || !over.isConnected) return;
    // Groups live at the top level only: over a ward inside another group,
    // the group itself is the neighbour.
    if (isGroup(node) && groupOf(over)) over = groupOf(over)!;
    // Over a group's own floor (none of its wards under the pointer): into it.
    if (!isGroup(node) && isGroup(over)) {
      const nest = nestOf(over);
      if (!nest || gridOf(node) === nest) return;
      flipTo(() => nest.append(node!));
      return;
    }
    const parent = gridOf(over);
    const kids = [...parent.children];
    const di = kids.indexOf(node); // -1: crossing into another grid
    const oi = kids.indexOf(over);
    // Element siblings only — Astro emits whitespace text nodes between
    // cards, and a text-node target silently defeats the idempotence brake.
    // Crossing grids, land on the side of the card the pointer is on.
    const r = slots.get(over)!;
    const target = di < 0 ? (lastX < (r.left + r.right) / 2 ? over : over.nextElementSibling) : oi < di ? over : over.nextElementSibling;
    // Idempotence: if inserting here wouldn't change the order, do nothing.
    if (target === node || (di >= 0 && target === node.nextElementSibling)) return;
    const overBefore = slots.get(over);
    slots = flip(() => parent.insertBefore(node!, target), node, { x: lastX, y: lastY });
    // Span mismatch: inserting a small card next to a big one often leaves
    // the big card exactly where it was (grid auto-placement absorbs the
    // small card into a gap) — it looks like the big card refuses to yield.
    // When the card under the pointer didn't move, trade places outright.
    const overAfter = slots.get(over);
    if (di >= 0 && overBefore && overAfter && Math.abs(overAfter.left - overBefore.left) < 1 && Math.abs(overAfter.top - overBefore.top) < 1) {
      slots = flip(() => swapNodes(node!, over!), node, { x: lastX, y: lastY });
    }
    measureHome();
    syncScrollBase();
    orderChanged = true;
    lastSwapAt = now;
  };

  // Continuous while dragging (not just on pointermove): drives edge
  // auto-scroll even with a stationary pointer, and keeps the card glued to
  // the pointer through scrolls.
  const frame = () => {
    if (!node || !started) {
      raf = 0;
      return;
    }
    if (!node.isConnected) {
      endDrag();
      return;
    }
    const EDGE = 48;
    const MAX = 10;
    const canScroll = (document.scrollingElement?.scrollHeight ?? 0) > innerHeight + 1;
    if (canScroll && armedEdge) {
      let sy2 = 0;
      if (lastY < EDGE) sy2 = -Math.ceil(((EDGE - lastY) / EDGE) * MAX);
      else if (lastY > innerHeight - EDGE) sy2 = Math.ceil(((lastY - (innerHeight - EDGE)) / EDGE) * MAX);
      // 'instant' or html{scroll-behavior:smooth} turns each step into its
      // own smooth animation and the viewport crawls.
      if (sy2) window.scrollBy({ top: sy2, behavior: 'instant' });
    }
    tabWatch();
    reorder();
    position();
    raf = requestAnimationFrame(frame);
  };

  // Drag events live on WINDOW, never on the card: reordering moves the card
  // in the DOM, which silently releases pointer capture and (before this)
  // made per-card listeners unreliable — or ended the drag outright.
  let activePointer = -1;

  // Touch lifts on a 250ms still hold (frost.css gives cards touch-action:
  // pan-y on coarse pointers, so a move before that scrolls the page); once
  // lifted, a non-passive touchmove keeps the browser from taking the gesture.
  let holdT = 0;
  const blockScroll = (ev: TouchEvent) => started && ev.preventDefault();

  const onMove = (e: PointerEvent) => {
    if (!node || e.pointerId !== activePointer) return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (lastY > 48 && lastY < innerHeight - 48) armedEdge = true;
    if (!started) {
      if (Math.hypot(lastX - sx, lastY - sy) < 6) return;
      if (holdT) {
        endDrag(); // moved before the hold fired: a scroll, not a drag
        return;
      }
      lift();
      if (!raf) raf = requestAnimationFrame(frame);
    }
  };

  const endDrag = (e?: PointerEvent, revert = false) => {
    if (e && e.pointerId !== activePointer) return;
    revert ||= e?.type === 'pointercancel';
    if (started && e?.type === 'pointerup') {
      lastX = e.clientX;
      lastY = e.clientY;
      reorder();
    }
    const notebook = !revert && e?.type === 'pointerup' ? hotNotebook : null;
    clearNotebook();
    if (holdT) clearTimeout(holdT);
    holdT = 0;
    window.removeEventListener('touchmove', blockScroll);
    clearTab();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('scroll', onScroll);
    window.visualViewport?.removeEventListener('scroll', onScroll);
    window.visualViewport?.removeEventListener('resize', onScroll);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    const n = node;
    const wasDrag = started;
    const changed = orderChanged;
    // Visual offset at the moment of release, relative to the final slot.
    const dx = home ? lastX - grabX - home.left : 0;
    const dy = home ? lastY - grabY - home.top : 0;
    node = null;
    started = false;
    activePointer = -1;
    lastSwapAt = 0;
    orderChanged = false;
    armedEdge = false;
    home = null;
    if (!n || !wasDrag) return;
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
    delete n.dataset.dragging;
    n.style.transform = '';
    if (notebook) {
      void moveNotepad(n, notebook);
      return;
    }
    if (revert && changed && originParent?.isConnected) {
      // Escape: put the card back where it came from — page included — save nothing.
      const p = originParent;
      flip(() => {
        p.insertBefore(n, originNext?.parentElement === p ? originNext : null);
        if (n.dataset.page !== originPage) {
          stampPage(n, originPage);
          showPage(originPage ?? firstPage(), { instant: true });
        }
      });
      return;
    }
    if (!reducedMotion() && (dx || dy)) {
      // WAAPI applies keyframe 0 on the same frame — no flash at scale 1.
      n.animate([{ transform: `translate(${dx}px, ${dy}px) scale(1.04)` }, { transform: 'none' }], {
        duration: DROP.duration,
        easing: ease(DROP),
        id: 'fd-drop',
      });
    }
    if (changed) commit();
  };

  grid.addEventListener('pointerdown', (e) => {
    if (!isEditing() || e.button !== 0 || !e.isPrimary || node) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, input, textarea, select, iframe')) return;
    // The resize engine owns the corner grip; it stops propagation too, but this
    // listener may be the first one registered on the grid.
    if (t.closest('[data-resize]')) return;
    const card = t.closest<HTMLElement>('[data-wd]');
    if (!card) return;
    e.preventDefault();
    node = card;
    activePointer = e.pointerId;
    sx = lastX = e.clientX;
    sy = lastY = e.clientY;
    const r = card.getBoundingClientRect();
    grabX = e.clientX - r.left;
    grabY = e.clientY - r.top;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    if (e.pointerType === 'touch') {
      holdT = window.setTimeout(() => {
        holdT = 0;
        if (!node || started) return;
        navigator.vibrate?.(10);
        window.addEventListener('touchmove', blockScroll, { passive: false });
        lift();
        if (!raf) raf = requestAnimationFrame(frame);
      }, 250);
    }
  });

  window.addEventListener('blur', () => endDrag());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && node) endDrag(undefined, true);
  });

  // A real drag must not fire the card content's click handlers on release.
  grid.addEventListener(
    'click',
    (e) => {
      if (justDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    { capture: true }
  );
}

async function moveNotepad(node: HTMLElement, notebook: HTMLElement): Promise<void> {
  const w = state.get(node.dataset.wd!);
  const book = state.get(notebook.dataset.wd!);
  if (w?.type !== 'note' || book?.type !== 'notebook') return;
  // Drain the existing editor before removing its surface; a failed save keeps the card.
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('fd:ward-context', { detail: { wards: [w.i], waitUntil: (p: Promise<unknown>) => pending.push(p) } }));
  try {
    await Promise.all(pending);
    if (!isEditing() || !node.isConnected || !notebook.isConnected) return;
    noteMoves.set(w.i, { id: typeof w.config?.note === 'string' ? w.config.note : w.i, notebook: book.i });
    state.delete(w.i);
    unbootInstance(w.i);
    flip(() => node.remove(), node);
    commit();
    toast(`Moved ${wardTitle(w)} to ${wardTitle(book)} — Done to save.`, { label: 'Undo', fn: undo });
  } catch {
    toast('Save the notepad before moving it. Your edits are still in the notepad.', undefined, true);
  }
}

// ---------------------------------------------------------- resize engine

/** Corner-grip resize. Same shape as the drag engine: listeners on WINDOW (a
 *  FLIP can move the card in the DOM, which releases pointer capture), Escape
 *  reverts, and every span write funnels through applySize. */
function bootResize(): void {
  let node: HTMLElement | null = null;
  let inst: WardInstance | null = null;
  let startSize: WardSize = '1x1';
  // The card's top-left in viewport coords. Growing a card can reflow the whole
  // grid and move it, so this is re-read from FLIP's settled rects every step.
  let originX = 0;
  let originY = 0;
  let cellW = 0;
  let cellH = 0;
  let gap = 0;
  let cols = MAX_W;

  const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

  const step = (e: PointerEvent) => {
    if (!node || !inst) return;
    const w = clampInt(Math.round((e.clientX - originX + gap) / (cellW + gap)), 1, cols);
    const h = clampInt(Math.round((e.clientY - originY + gap) / (cellH + gap)), 1, MAX_H);
    // refresh off — that would repaint (and refetch) on every quantised step.
    const rects = applySize(node, inst, `${w}x${h}`, false);
    const r = rects.get(node);
    if (r) {
      originX = r.left;
      originY = r.top;
    }
  };

  const end = (cancel = false) => {
    if (!node || !inst) return;
    const n = node;
    const w = inst;
    node = null;
    inst = null;
    window.removeEventListener('pointermove', step);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    delete n.dataset.resizing;
    if (cancel) applySize(n, w, startSize);
    else if (w.size !== startSize) {
      commit();
      rerenderInstance(w);
    }
  };
  const up = () => end();

  grid.addEventListener('pointerdown', (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>('[data-resize]');
    if (!grip || !isEditing() || e.button !== 0 || !e.isPrimary || node) return;
    const card = grip.closest<HTMLElement>('[data-wd]');
    const w = card && state.get(card.dataset.wd ?? '');
    if (!card || !w) return;
    e.preventDefault();
    e.stopPropagation();
    node = card;
    inst = w;
    startSize = w.size;
    const cs = getComputedStyle(gridOf(card));
    const tracks = cs.gridTemplateColumns.split(' ');
    // The RENDERED column count (2 / 4 / 6), not MAX_W: a phone can only reach 2.
    cols = tracks.length;
    cellW = parseFloat(tracks[0] ?? '0');
    cellH = parseFloat(cs.gridAutoRows);
    gap = parseFloat(cs.columnGap) || 0;
    const r = card.getBoundingClientRect();
    originX = r.left;
    originY = r.top;
    card.dataset.resizing = '1';
    window.addEventListener('pointermove', step);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && node) end(true);
  });
  window.addEventListener('blur', () => end());
}

// ------------------------------------------------------------ context menu
// (openMenu/menuItem/closeMenu live in menu.ts — the page tabs share them.)

/** MAX_W x MAX_H hover-to-preview size picker. Cells are <i>, not buttons: 72
 *  tab stops would bury the Move/Configure/Remove items under them. */
function sizeMatrix(node: HTMLElement, w: WardInstance): HTMLElement {
  const wrap = el('div');
  const mx = el('div', 'ctx-matrix');
  const label = el('div', 'ctx-matrix-label');
  // Columns past this breakpoint's cap stay pickable, but render clamped.
  const cap = getComputedStyle(gridOf(node)).gridTemplateColumns.split(' ').length;
  const cells: HTMLElement[] = [];

  const paint = (cw: number, ch: number) => {
    cells.forEach((c, n) => {
      const col = (n % MAX_W) + 1;
      const row = Math.floor(n / MAX_W) + 1;
      if (col <= cw && row <= ch) c.dataset.on = '1';
      else delete c.dataset.on;
    });
    label.textContent = `${cw} × ${ch}`;
  };

  for (let row = 1; row <= MAX_H; row++) {
    for (let col = 1; col <= MAX_W; col++) {
      const cell = el('i');
      if (col > cap) cell.dataset.over = '1';
      cell.addEventListener('pointerenter', () => paint(col, row));
      cell.addEventListener('click', () => {
        closeMenu();
        applySize(node, w, `${col}x${row}`);
      });
      cells.push(cell);
      mx.append(cell);
    }
  }
  const [cw, ch] = sizeParts(w.size);
  mx.addEventListener('pointerleave', () => paint(cw, ch));
  paint(cw, ch);
  wrap.append(mx, label);
  return wrap;
}

function wardMenu(x: number, y: number, node: HTMLElement, w: WardInstance): void {
  openMenu(x, y, (m) => {
    m.append(el('div', 'ctx-label', wardTitle(w)));
    if (!isEditing()) m.append(menuItem('popout', 'Pop out ward', () => void popOutWard(w.i)));

    m.append(sizeMatrix(node, w));

    m.append(menuItem('left', 'Move earlier', () => moveStep(node, -1)));
    m.append(menuItem('right', 'Move later', () => moveStep(node, 1)));
    if (isGroup(node)) m.append(menuItem('plus', 'Add ward here…', () => openDialog(undefined, nestOf(node))));
    else {
      for (const g of grid.querySelectorAll<HTMLElement>(':scope > [data-wd-type="container"]')) {
        const gw = state.get(g.dataset.wd ?? '');
        const nest = nestOf(g);
        if (!gw || !nest || g === groupOf(node)) continue;
        m.append(menuItem('folder', `Move into ${wardTitle(gw)}`, () => moveInto(node, nest)));
      }
      if (groupOf(node)) m.append(menuItem('folder-out', 'Move out of group', () => moveInto(node, grid)));
    }
    if (!groupOf(node)) {
      for (const p of readPages()) {
        if (p.id === (node.dataset.page ?? firstPage())) continue;
        m.append(menuItem('right', `Move to ${p.title}`, () => moveToPage(node, p.id)));
      }
    }
    if (CATALOG[w.type]?.configurable) m.append(menuItem('settings', 'Configure…', () => openDialog(w)));
    m.append(menuItem('eye', w.hidden ? 'Show on dashboard' : 'Hide (Edit/Logic only)', () => toggleHidden(node, w)));
    m.append(menuItem('palette', 'Theme…', () => openThemeDialog(node, w)));
    if (!isEditing()) m.append(menuItem('route', 'Leylines…', () => window.dispatchEvent(new CustomEvent('fd:leylines', { detail: { ward: w.i } }))));
    if (CATALOG[w.type]?.multi) m.append(menuItem('copy', 'Duplicate', () => duplicateWard(node, w)));
    m.append(el('hr', 'ctx-sep'));
    m.append(menuItem('close', 'Remove', () => removeWard(node, w), true));
  });
}

function gridMenu(x: number, y: number): void {
  openMenu(x, y, (m) => {
    m.append(menuItem('plus', 'Add ward…', () => openDialog()));
    m.append(menuItem('pen', isEditing() ? 'Done editing' : 'Edit layout', () => q<HTMLButtonElement>('[data-tb="edit"]')?.click()));
    m.append(el('hr', 'ctx-sep'));
    m.append(
      menuItem(
        'reset',
        'Reset to default layout',
        () => {
          if (!confirm('Reset the dashboard to the default layout?')) return;
          void postJson('/api/dashboard', { layout: DEFAULT_LAYOUT, from: TAB_ID }, 'PUT').then((r) => (r.ok ? location.reload() : toast('Reset failed.', undefined, true)));
        },
        true
      )
    );
  });
}

function bootMenu(): void {
  const main = grid.closest('main') ?? grid;
  const openAt = (t: HTMLElement, x: number, y: number): boolean => {
    // Wiring mode owns the grid; menu actions mutate + save the layout, which
    // would strand edges mid-session.
    if (grid.classList.contains('wiring')) return false;
    // Native menu where it matters (paste in inputs, link/frame menus).
    if (t.closest('input, textarea, select, a[href], iframe, [contenteditable]')) return false;
    const node = t.closest<HTMLElement>('[data-wd]');
    if (node) {
      const w = state.get(node.dataset.wd ?? '');
      if (w) wardMenu(x, y, node, w);
    } else {
      gridMenu(x, y);
    }
    return true;
  };
  main.addEventListener('contextmenu', (e) => {
    // A touch long-press is the hold below (Android fires contextmenu too,
    // iOS never does); the mouse/pen path is this event.
    if ((e as PointerEvent).pointerType === 'touch') {
      e.preventDefault();
      return;
    }
    if (openAt(e.target as HTMLElement, e.clientX, e.clientY)) e.preventDefault();
  });
  // In edit mode a hold on a card is the drag lift; its ⚙/size buttons open
  // the menu there. Everywhere else a 400ms hold is the menu.
  holdToFire(
    main,
    400,
    (e) => openAt(e.target as HTMLElement, e.clientX, e.clientY),
    (e) => !!(e.target as HTMLElement).closest('button, a[href], [data-resize]') || (isEditing() && !!(e.target as HTMLElement).closest('[data-wd]'))
  );
}

// ------------------------------------------------------- edit-mode buttons

function bootActions(): void {
  grid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || !isEditing()) return;
    const node = btn.closest<HTMLElement>('[data-wd]');
    const w = node && state.get(node.dataset.wd!);
    if (!node || !w) return;
    switch (btn.dataset.act) {
      case 'open':
        if (!isWiring()) setOpen(node, !isOpen(node));
        break;
      case 'left':
        moveStep(node, -1);
        break;
      case 'right':
        moveStep(node, 1);
        break;
      case 'size': {
        // Without this the same click bubbles to bootMenu's document listener,
        // which closes the menu we just opened.
        e.stopPropagation();
        const r = btn.getBoundingClientRect();
        wardMenu(r.left, r.bottom + 4, node, w);
        break;
      }
      case 'hide':
        toggleHidden(node, w);
        break;
      case 'theme':
        openThemeDialog(node, w);
        break;
      case 'remove':
        removeWard(node, w);
        break;
      case 'cfg':
        openDialog(w);
        break;
    }
  });
}

// ------------------------------------------------------------- add dialog

interface DialogEls {
  dialog: HTMLDialogElement;
  type: HTMLInputElement;
  title: HTMLInputElement;
  err: HTMLElement;
}

function dialogEls(): DialogEls | null {
  const dialog = q<HTMLDialogElement>('#add-ward');
  if (!dialog) return null;
  return {
    dialog,
    type: q<HTMLInputElement>('#aw-type', dialog)!,
    title: q<HTMLInputElement>('#aw-title', dialog)!,
    err: q<HTMLElement>('[data-aw-err]', dialog)!,
  };
}

function selectCard(dialog: HTMLDialogElement, type: string): void {
  q<HTMLInputElement>('#aw-type', dialog)!.value = type;
  dialog.querySelectorAll<HTMLButtonElement>('.aw-card').forEach((c) => { c.setAttribute('aria-pressed', String(c.dataset.type === type)); });
  showCfgSection(dialog, type);
}

function showCfgSection(dialog: HTMLDialogElement, type: string): void {
  dialog.querySelectorAll<HTMLElement>('[data-cfg]').forEach((s) => {
    const on = (s.dataset.cfg ?? '').split(' ').includes(type);
    s.classList.toggle('hidden', !on);
    s.classList.toggle('flex', on);
  });
  if (type === 'chart') syncChartFields(dialog);
  if (TASK_TYPES.has(type)) {
    syncDbView(dialog, type);
    void loadDatabases(dialog);
    // Reset stale columns from a previously configured ward; fillConfig
    // reloads the real ones right after when we're editing an existing one.
    if (!q<HTMLInputElement>('#aw-cl-db', dialog)!.value.trim()) void loadColumns(dialog, '', []);
  }
  if (type === 'notion-page' && !q<HTMLInputElement>('#aw-np-page', dialog)!.value.trim()) resetPageProps(dialog);
  const agentProvider = q<HTMLSelectElement>('#aw-ag-provider', dialog);
  if (agentProvider && type === 'agent' && !agentProvider.querySelector('[value="default"]')) {
    agentProvider.prepend(new Option('Rime default', 'default'));
    agentProvider.value = 'default';
  } else if (type === 'note' || type === 'notebook') agentProvider?.querySelector('[value="default"]')?.remove();
  if (type === 'agent' || type === 'note' || type === 'notebook') void loadAgentModels(dialog);
  if (type === 'note') {
    const picker = q<HTMLSelectElement>('#aw-nt-note', dialog);
    if (picker) {
      delete picker.dataset.want; // a fresh ward: its own document (fillConfig sets the want for an existing one)
      picker.value = '';
    }
    void loadNoteDocs(dialog);
  }
  if (type === 'spacer') syncFx(dialog);
  // A fresh launcher starts with one row; fillConfig rebuilds the rows for an existing ward.
  if (type === 'applink') {
    q('[data-al-rows]', dialog)!.textContent = '';
    alRow(dialog);
  }
}

/** One launcher link row from the #aw-al-row template (SearchSelect upgrades
 *  the cloned select through its MutationObserver). */
function alRow(dialog: HTMLDialogElement, l: Record<string, unknown> = {}): void {
  const host = q('[data-al-rows]', dialog)!;
  if (host.children.length >= 12) return;
  const row = (q<HTMLTemplateElement>('#aw-al-row', dialog)!.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
  q<HTMLInputElement>('[data-al-url]', row)!.value = String(l.url ?? '');
  q<HTMLInputElement>('[data-al-icon]', row)!.value = String(l.icon ?? '');
  q<HTMLSelectElement>('[data-al-svc]', row)!.value = String(l.statusService ?? '');
  host.append(row);
}

/** The scene picker only matters for the scene effect. */
function syncFx(dialog: HTMLDialogElement): void {
  q('[data-fx-scene]', dialog)?.classList.toggle('hidden', q<HTMLSelectElement>('#aw-fx', dialog)?.value !== 'scene');
}

// ------------------------------------------------------------ notepad ward

/** The Document picker: every note of the user's (id + title + notebook), the
 *  ward's own document first. Async — `data-want` remembers the value
 *  fillConfig asked for before the options existed, and `data-loaded` tells
 *  readConfig the choice is real (until then the stored identity is kept). */
async function loadNoteDocs(dialog: HTMLDialogElement): Promise<void> {
  const sel = q<HTMLSelectElement>('#aw-nt-note', dialog);
  if (!sel) return;
  delete sel.dataset.loaded;
  const res = await fetch('/api/notes?limit=100', { headers: { accept: 'application/json' } }).catch(() => null);
  const data = res?.ok ? ((await res.json().catch(() => null)) as { notes?: { id: string; title: string; notebook: string | null }[] } | null) : null;
  if (!data?.notes) return; // the list stays empty; a stored link is kept as-is
  const want = sel.dataset.want ?? sel.value;
  for (const o of [...sel.options]) if (o.value) o.remove();
  const books = new Map<string, string>();
  for (const w of state.values()) if (w.type === 'notebook') books.set((w.config?.notebook as string | undefined) ?? w.i, w.title ?? 'Notebook');
  for (const n of data.notes) sel.append(new Option(n.notebook ? `${n.title} — ${books.get(n.notebook) ?? 'Notebook'}` : n.title, n.id));
  if (want && !data.notes.some((n) => n.id === want)) sel.append(new Option(`${want} (not found)`, want));
  sel.value = want;
  sel.dispatchEvent(new Event('change', { bubbles: true })); // SearchSelect relabels
  sel.dataset.loaded = '1';
}

// ------------------------------------------------------------- agent ward

const agentModels = new Map<string, { id: string; name?: string }[]>();

/** Suggestions for the model field, for whichever provider (and endpoint) is
 *  selected. The field is free text, so a failed fetch just leaves the list empty. */
async function loadAgentModels(dialog: HTMLDialogElement): Promise<void> {
  const provider = q<HTMLSelectElement>('#aw-ag-provider', dialog)!;
  const endpoint = q<HTMLInputElement>('#aw-ag-endpoint', dialog);
  q('[data-ag-endpoint]', dialog)?.classList.toggle('hidden', provider.value !== 'compat');
  const want = provider.value === 'compat' ? `compat:${endpoint?.value.trim() ?? ''}` : provider.value;
  let models = agentModels.get(want);
  if (!models) {
    const res = await fetch(`/api/agent/models?provider=${encodeURIComponent(provider.value)}${provider.value === 'compat' && endpoint?.value.trim() ? `&endpoint=${encodeURIComponent(endpoint.value.trim())}` : ''}`).catch(() => null);
    const data = res ? ((await res.json().catch(() => null)) as { models?: { id: string; name?: string }[]; endpoints?: string[] } | null) : null;
    models = data?.models ?? [];
    if (res?.ok) agentModels.set(want, models);
    const names = q<HTMLDataListElement>('#aw-ag-endpoints', dialog);
    if (names && data?.endpoints) { names.textContent = ''; for (const n of data.endpoints) names.append(new Option(n)); }
  }
  const now = provider.value === 'compat' ? `compat:${endpoint?.value.trim() ?? ''}` : provider.value;
  if (now !== want) return; // a provider switch raced this fetch
  const list = q<HTMLDataListElement>('#aw-ag-models', dialog)!;
  list.textContent = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    if (m.name && m.name !== m.id) o.label = m.name;
    list.append(o);
  }
}

// ------------------------------------------------------- notion task wards

const TASK_TYPES = TASK_WARDS;

/** notion-db is the only type with a view picker; its list-only knobs
 *  (show/sort) hide in table view. Legacy task wards are always the list. */
function syncDbView(dialog: HTMLDialogElement, type: string): void {
  const isDb = type === 'notion-db';
  q('[data-cl-view]', dialog)?.classList.toggle('hidden', !isDb);
  const view = isDb ? q<HTMLSelectElement>('#aw-cl-view', dialog)!.value : 'list';
  dialog.querySelectorAll<HTMLElement>('[data-cl-listonly]').forEach((n) => { n.classList.toggle('hidden', view !== 'list'); });
  dialog.querySelectorAll<HTMLElement>('[data-cl-calonly]').forEach((n) => { n.classList.toggle('hidden', view !== 'calendar'); });
}
let dbsLoaded = false;

/** The workspace's databases, once per page. Failure leaves the paste field. */
async function loadDatabases(dialog: HTMLDialogElement): Promise<void> {
  if (dbsLoaded) return;
  dbsLoaded = true;
  const pick = q<HTMLSelectElement>('#aw-cl-pick', dialog)!;
  const res = await fetch('/api/notion/config').catch(() => null);
  const data = res?.ok ? ((await res.json().catch(() => null)) as { databases?: { id: string; title: string; icon: string }[] } | null) : null;
  pick.textContent = '';
  pick.append(new Option(data ? '— pick a database —' : 'Connect Notion in Account first', ''));
  for (const d of data?.databases ?? []) pick.append(new Option(`${d.icon} ${d.title || '(untitled)'}`.trim(), d.id));
  const db = q<HTMLInputElement>('#aw-cl-db', dialog)!.value.trim();
  if (db) pick.value = db;
}

// ------------------------------------------------------ notion page wards


function resetPageProps(dialog: HTMLDialogElement): void {
  const list = q<HTMLSelectElement>('#aw-np-props', dialog)!;
  list.textContent = '';
  list.append(new Option('Pick a page first', '', false, false));
}

/** Search results fill the picker; choosing one fills the id field. */
async function searchPages(dialog: HTMLDialogElement, query: string): Promise<void> {
  const pick = q<HTMLSelectElement>('#aw-np-pick', dialog)!;
  if (query.trim().length < 2) return;
  pick.textContent = '';
  pick.append(new Option('searching…', ''));
  const { status, data } = await getJson(`/api/notion/search?q=${encodeURIComponent(query)}`);
  pick.textContent = '';
  const hits = (status === 200 ? (data?.results ?? []) : []) as { id: string; title: string; icon: string; object: string }[];
  if (!hits.length) pick.append(new Option('nothing matched', ''));
  for (const h of hits) pick.append(new Option(`${h.icon} ${h.title || '(untitled)'} · ${h.object}`.trim(), h.id));
}

/** The page's own property names, so a fields ward can pick among them. */
async function loadPageProps(dialog: HTMLDialogElement, page: string, selected: string[]): Promise<void> {
  const list = q<HTMLSelectElement>('#aw-np-props', dialog)!;
  const note = q<HTMLElement>('[data-np-note]', dialog)!;
  const id = notionIdFrom(page);
  if (!id) return resetPageProps(dialog);
  const { status, data } = await getJson(`/api/notion/page?id=${encodeURIComponent(id)}&parts=props`);
  if (status !== 200) {
    note.textContent = String(data?.error ?? 'Could not read that page.').slice(0, 140);
    return;
  }
  const props = (data?.props ?? {}) as Record<string, { type: string; editable: boolean }>;
  const want = new Set(selected);
  list.textContent = '';
  for (const [name, p] of Object.entries(props)) {
    list.append(new Option(`${name} · ${p.type}${p.editable ? '' : ' (read-only)'}`, name, false, want.has(name)));
  }
  if (!list.options.length) list.append(new Option('This page has no properties', '', false, false));
  note.textContent = `${data.meta?.title || 'That page'} — ${list.options.length} propert${list.options.length === 1 ? 'y' : 'ies'}.`;
}

/** Column list for the picked db. `selected` restores an existing ward's choice. */
async function loadColumns(dialog: HTMLDialogElement, db: string, selected: string[]): Promise<void> {
  const list = q<HTMLSelectElement>('#aw-cl-props', dialog)!;
  const hint = q<HTMLElement>('[data-cl-schema]', dialog)!;
  const id = notionIdFrom(db);
  if (!id) {
    list.textContent = '';
    list.append(new Option('Pick a database first', '', false, false));
    return;
  }
  const ds = q<HTMLSelectElement>('#aw-cl-ds', dialog)!;
  const chosenDs = ds.value;
  const res = await fetch(`/api/notion/config?db=${encodeURIComponent(id)}${chosenDs ? `&ds=${encodeURIComponent(chosenDs)}` : ''}`).catch(() => null);
  const data = res?.ok
    ? ((await res.json().catch(() => null)) as {
        done?: { name: string; kind: string } | null;
        props?: { name: string; type: string }[];
        sources?: { id: string; name: string }[];
        sourceId?: string;
      } | null)
    : null;
  if (!data) {
    hint.textContent = 'Could not read that database — is it shared with the integration?';
    return;
  }
  // A database can hold several lists; only offer the choice when it does.
  const sources = data.sources ?? [];
  q('[data-cl-lists]', dialog)!.classList.toggle('hidden', sources.length < 2);
  ds.textContent = '';
  for (const src of sources) ds.append(new Option(src.name || '(unnamed list)', src.id, false, src.id === data.sourceId));
  hint.textContent = data.done
    ? `Checking off writes "${data.done.name}" (${data.done.kind}).`
    : 'No checkbox, status or select column — this list will be read-only.';
  const want = new Set(selected);
  list.textContent = '';
  for (const p of data.props ?? []) list.append(new Option(`${p.name} · ${p.type}`, p.name, false, want.has(p.name)));
  if (!list.options.length) list.append(new Option('No other columns', '', false, false));
  // The calendar's date column: the date-typed ones, keeping whatever was picked.
  const date = q<HTMLSelectElement>('#aw-cl-date', dialog)!;
  const had = date.value;
  date.textContent = '';
  date.append(new Option('— first Date/When/Start/Due column —', ''));
  for (const p of (data.props ?? []).filter((p) => p.type === 'date')) date.append(new Option(p.name, p.name, false, p.name === had));
}

function syncChartFields(dialog: HTMLDialogElement): void {
  const source = q<HTMLSelectElement>('#aw-ch-source', dialog)!.value as keyof typeof CHART_SOURCES;
  const spec = CHART_SOURCES[source];
  q('[data-ch-service]', dialog)!.classList.toggle('hidden', spec.services !== 'targets');
  q('[data-ch-host]', dialog)!.classList.toggle('hidden', !Array.isArray(spec.services));
  q('[data-ch-hours]', dialog)!.classList.toggle('hidden', spec.services === null);
  const metric = q<HTMLSelectElement>('#aw-ch-metric', dialog)!;
  metric.textContent = '';
  for (const mName of spec.metrics) {
    const opt = document.createElement('option');
    opt.value = mName;
    opt.textContent = mName;
    metric.append(opt);
  }
}

// ---------------------------------------------------- config read / fill
//
// The flat config types are one table: selector → config key (+ how to read
// it). readConfig and fillConfig loop it; validateLayout (lib/wards.ts)
// remains the trust boundary and the source of every default, so a field
// here only needs to round-trip what the server stores. Types with rows,
// pickers or dependent selects (applink, notion-db/page, chart,
// service-group) keep hand cases below.

interface Field {
  sel: string;
  key: string;
  /** 'bool' = a checkbox · 'num' = Number() · 'secret' = never in the config: sent beside the
   *  layout save and sealed server-side (a blank field keeps the stored value) · default text (empty = absent). */
  kind?: 'bool' | 'num' | 'secret';
  /** What fillConfig shows when the config has no value. */
  def?: unknown;
}

/** The secrets the last readConfig saw, then the ones waiting for the next save, per ward. */
let lastSecrets: Record<string, string> = {};
const pendingSecrets = new Map<string, Record<string, string>>();

/** Record identities survive Configure unless a loaded picker explicitly changes them. */
const IDENTITY: Record<string, string[]> = { note: ['note'], notebook: ['notebook'] };
const FIELDS: Record<string, Field[]> = {
  'remote-desktop': [
    { sel: '#aw-rd-auto', key: 'autoConnect', kind: 'bool' },
    { sel: '#aw-rd-quality', key: 'quality', def: 'auto' },
    { sel: '#aw-rd-view', key: 'view', def: 'fit' },
    { sel: '#aw-rd-diagnostics', key: 'diagnostics', kind: 'bool' },
  ],
  embed: [{ sel: '#aw-em-url', key: 'url' }],
  weather: [
    { sel: '#aw-we-name', key: 'name' },
    { sel: '#aw-we-lat', key: 'lat', kind: 'num' },
    { sel: '#aw-we-lon', key: 'lon', kind: 'num' },
  ],
  browser: [
    { sel: '#aw-bw-url', key: 'url' },
    { sel: '#aw-bw-backend', key: 'backend', def: 'local' },
    { sel: '#aw-bw-route', key: 'route' },
  ],
  service: [{ sel: '#aw-sv-id', key: 'service' }],
  mcp: [
    { sel: '#aw-mc-name', key: 'name' },
    { sel: '#aw-mc-url', key: 'url' },
    { sel: '#aw-mc-header', key: 'header', def: 'Authorization' },
    { sel: '#aw-mc-trust', key: 'trust', def: 'write' },
  ],
  discord: [
    { sel: '#aw-dc-guild', key: 'guild' },
    { sel: '#aw-dc-channel', key: 'channel' },
    { sel: '#aw-dc-watch', key: 'watch', def: 'all' },
    { sel: '#aw-dc-token', key: 'token', kind: 'secret' },
  ],
  telegram: [
    { sel: '#aw-tg-chat', key: 'channel' },
    { sel: '#aw-tg-watch', key: 'watch', def: 'all' },
    { sel: '#aw-tg-token', key: 'token', kind: 'secret' },
  ],
  slack: [
    { sel: '#aw-sl-channel', key: 'channel' },
    { sel: '#aw-sl-watch', key: 'watch', def: 'all' },
    { sel: '#aw-sl-token', key: 'token', kind: 'secret' },
    { sel: '#aw-sl-app', key: 'appToken', kind: 'secret' },
  ],
  twilio: [
    { sel: '#aw-tw-sid', key: 'sid' },
    { sel: '#aw-tw-from', key: 'from' },
    { sel: '#aw-tw-to', key: 'channel' },
    { sel: '#aw-tw-allow', key: 'allow' },
    { sel: '#aw-tw-token', key: 'token', kind: 'secret' },
  ],
  push: [
    { sel: '#aw-pu-service', key: 'service', def: 'ntfy' },
    { sel: '#aw-pu-target', key: 'channel' },
    { sel: '#aw-pu-server', key: 'server' },
    { sel: '#aw-pu-token', key: 'token', kind: 'secret' },
  ],
  matrix: [
    { sel: '#aw-mx-hs', key: 'homeserver' },
    { sel: '#aw-mx-room', key: 'channel' },
    { sel: '#aw-mx-watch', key: 'watch', def: 'all' },
    { sel: '#aw-mx-token', key: 'token', kind: 'secret' },
  ],
  teams: [
    { sel: '#aw-tm-team', key: 'team' },
    { sel: '#aw-tm-channel', key: 'channel' },
    { sel: '#aw-tm-watch', key: 'watch', def: 'all' },
  ],
  timer: [
    { sel: '#aw-tm-duration', key: 'duration', kind: 'num' },
    { sel: '#aw-tm-rounds', key: 'rounds', kind: 'num', def: 0 },
    { sel: '#aw-tm-work', key: 'work', kind: 'num', def: 25 },
    { sel: '#aw-tm-rest', key: 'rest', kind: 'num', def: 5 },
    { sel: '#aw-tm-long', key: 'long', kind: 'num', def: 15 },
    { sel: '#aw-tm-loop', key: 'loop', kind: 'bool' },
  ],
  note: [
    { sel: '#aw-nt-text', key: 'text' }, // the pre-store note, the seed of a document not yet saved
    { sel: '#aw-nt-note', key: 'note' }, // the document shown (blank = its own); see loadNoteDocs
    { sel: '#aw-nt-paper', key: 'paper', def: 'plain' },
    { sel: '#aw-nt-transcribe', key: 'transcribe', def: 'manual' },
    { sel: '#aw-nt-ink', key: 'ink', kind: 'bool', def: true },
    { sel: '#aw-nt-keep', key: 'keepInk', kind: 'bool' },
    { sel: '#aw-ag-provider', key: 'provider', def: 'openrouter' },
    { sel: '#aw-ag-endpoint', key: 'endpoint' },
    { sel: '#aw-ag-model', key: 'model' },
  ],
  // The notebook's editor draws with the notepad's knobs; the notebook itself is the ward's own (config.notebook is set by the agent, not here).
  notebook: [
    { sel: '#aw-nt-paper', key: 'paper', def: 'plain' },
    { sel: '#aw-nt-transcribe', key: 'transcribe', def: 'manual' },
    { sel: '#aw-nt-ink', key: 'ink', kind: 'bool', def: true },
    { sel: '#aw-nt-keep', key: 'keepInk', kind: 'bool' },
    { sel: '#aw-ag-provider', key: 'provider', def: 'openrouter' },
    { sel: '#aw-ag-endpoint', key: 'endpoint' },
    { sel: '#aw-ag-model', key: 'model' },
  ],
  agent: [
    { sel: '#aw-ag-provider', key: 'provider', def: 'default' },
    { sel: '#aw-ag-endpoint', key: 'endpoint' },
    { sel: '#aw-ag-model', key: 'model' },
    { sel: '#aw-ag-persona', key: 'persona' },
    { sel: '#aw-ag-tools', key: 'tools', def: 'all' },
    { sel: '#aw-ag-approvals', key: 'approvals', def: 'outbound' },
    { sel: '#aw-ag-effort', key: 'effort', def: 'medium' },
    { sel: '#aw-ag-cap', key: 'headlessCap', def: 6 }, // text on purpose: a cleared box is absent, never 0 (= no cap)
    { sel: '#aw-ag-rounds', key: 'rounds' },
  ],
  mail: [
    { sel: '#aw-ml-account', key: 'account', def: 'all' },
    { sel: '#aw-ml-unread', key: 'unreadOnly', kind: 'bool' },
  ],
  button: [{ sel: '#aw-bt-icon', key: 'icon' }],
  spacer: [
    { sel: '#aw-fx', key: 'effect', def: 'none' },
    { sel: '#aw-fx-scene', key: 'scene', def: 'aurora' },
    { sel: '#aw-fx-rule', key: 'rule', kind: 'bool' },
  ],
};

/** null = validation problem (message shown); otherwise the config object. */
function readConfig(dialog: HTMLDialogElement, type: string): Record<string, unknown> | null {
  const val = (sel: string) => q<HTMLInputElement | HTMLSelectElement>(sel, dialog)!.value.trim();
  const fields = FIELDS[type];
  lastSecrets = {};
  if (fields) {
    const cfg: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.kind === 'secret') {
        const v = q<HTMLInputElement>(f.sel, dialog)!.value.trim();
        if (v) lastSecrets[f.key] = v;
        continue;
      }
      if (f.kind === 'bool') cfg[f.key] = q<HTMLInputElement>(f.sel, dialog)!.checked;
      else if (f.kind === 'num') {
        const v = val(f.sel);
        if (v !== '') cfg[f.key] = Number(v); // empty = absent: the validator owns the default
      }
      else {
        const v = f.key === 'text' ? q<HTMLInputElement>(f.sel, dialog)!.value : val(f.sel);
        if (v) cfg[f.key] = v;
      }
    }
    // The two url types: a bare host is completed, anything not http(s) is refused here, before the server does.
    if (type === 'browser' && cfg.url !== undefined) {
      cfg.url = normalizeUrl(String(cfg.url));
      if (!httpUrl(cfg.url)) return null;
    }
    if (type === 'embed' && !httpUrl(cfg.url)) return null;
    return cfg;
  }
  switch (type) {
    case 'applink': {
      const links = [...dialog.querySelectorAll<HTMLElement>('[data-al-row]')]
        .map((r) => {
          const cfg: Record<string, unknown> = { url: q<HTMLInputElement>('[data-al-url]', r)!.value.trim() };
          const icon = q<HTMLInputElement>('[data-al-icon]', r)!.value.trim();
          if (icon) cfg.icon = icon;
          const svc = q<HTMLSelectElement>('[data-al-svc]', r)!.value;
          if (svc) cfg.statusService = svc;
          return cfg;
        })
        .filter((l) => l.url || l.icon || l.statusService); // blank rows are ignored
      return links.length && links.every((l) => httpUrl(l.url)) ? { links } : null;
    }
    case 'service-group': {
      const picked = [...q<HTMLSelectElement>('#aw-sg-services', dialog)!.selectedOptions].map((o) => o.value);
      const group = val('#aw-sg-group');
      const cfg: Record<string, unknown> = picked.length > 0 ? { services: picked } : group ? { group } : {};
      if (val('#aw-sg-view') === 'dots') cfg.view = 'dots';
      return cfg;
    }
    case 'chart': {
      const source = val('#aw-ch-source') as keyof typeof CHART_SOURCES;
      const spec = CHART_SOURCES[source];
      const cfg: Record<string, unknown> = {
        source,
        metric: val('#aw-ch-metric'),
        chart: val('#aw-ch-type'),
        hours: Number(val('#aw-ch-hours')),
      };
      if (spec.services === 'targets') cfg.service = val('#aw-ch-service');
      else if (Array.isArray(spec.services)) cfg.service = val('#aw-ch-host');
      return cfg;
    }
    case 'notion-page': {
      const raw = val('#aw-np-page');
      const cfg: Record<string, unknown> = {};
      if (raw) {
        const id = notionIdFrom(raw);
        if (!id) return null;
        cfg.page = id;
      }
      const props = [...q<HTMLSelectElement>('#aw-np-props', dialog)!.selectedOptions].map((o) => o.value).filter(Boolean);
      if (props.length) cfg.props = props;
      if (!q<HTMLInputElement>('#aw-np-head', dialog)!.checked) cfg.head = false;
      const show = [...q<HTMLSelectElement>('#aw-np-show', dialog)!.selectedOptions].map((o) => o.value);
      if (show.length) cfg.show = show;
      cfg.depth = Number(val('#aw-np-depth'));
      return cfg;
    }
    case 'notion-db':
    case 'checklist':
    case 'notion-tasks': {
      const raw = val('#aw-cl-db');
      const cfg: Record<string, unknown> = {};
      if (type === 'notion-db') cfg.view = val('#aw-cl-view');
      if (cfg.view === 'calendar' && val('#aw-cl-date')) cfg.date = val('#aw-cl-date');
      if (raw) {
        const id = notionIdFrom(raw);
        if (!id) return null;
        cfg.db = id;
      }
      if (val('#aw-cl-ds')) cfg.ds = val('#aw-cl-ds');
      if (val('#aw-cl-show') !== 'open') cfg.show = val('#aw-cl-show');
      if (val('#aw-cl-sort') !== 'due') cfg.sort = val('#aw-cl-sort');
      if (Number(val('#aw-cl-limit')) > 0) cfg.limit = Number(val('#aw-cl-limit'));
      const props = [...q<HTMLSelectElement>('#aw-cl-props', dialog)!.selectedOptions].map((o) => o.value).filter(Boolean);
      if (props.length) cfg.props = props.slice(0, 8);
      return cfg;
    }
    default:
      return {};
  }
}

/** Fill dialog fields from an existing instance (configure). */
function fillConfig(dialog: HTMLDialogElement, w: WardInstance): void {
  const set = (sel: string, v: unknown) => {
    const n = q<HTMLInputElement | HTMLSelectElement>(sel, dialog);
    if (n) n.value = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const cfg = w.config ?? {};
  const fields = FIELDS[w.type];
  if (fields) {
    for (const f of fields) {
      if (f.kind === 'secret') q<HTMLInputElement>(f.sel, dialog)!.value = ''; // never echoed; blank keeps the stored one
      else if (f.kind === 'bool') q<HTMLInputElement>(f.sel, dialog)!.checked = (cfg[f.key] ?? f.def ?? false) === true;
      else set(f.sel, cfg[f.key] ?? f.def);
    }
    if (w.type === 'note') {
      const picker = q<HTMLSelectElement>('#aw-nt-note', dialog);
      if (picker) picker.dataset.want = typeof cfg.note === 'string' ? cfg.note : '';
    }
    if (w.type === 'spacer') syncFx(dialog);
    if (w.type === 'note' || w.type === 'notebook' || w.type === 'agent') void loadAgentModels(dialog); // selectCard's load ran before this provider was set
    return;
  }
  switch (w.type) {
    case 'applink':
      q('[data-al-rows]', dialog)!.textContent = '';
      for (const l of (cfg.links as Record<string, unknown>[] | undefined) ?? []) alRow(dialog, l);
      break;
    case 'service-group': {
      set('#aw-sg-group', typeof cfg.group === 'string' ? cfg.group : '');
      const multi = q<HTMLSelectElement>('#aw-sg-services', dialog)!;
      const picked = new Set(Array.isArray(cfg.services) ? (cfg.services as string[]) : []);
      for (const o of multi.options) o.selected = picked.has(o.value);
      multi.dispatchEvent(new Event('change', { bubbles: true })); // SearchSelect does not see option.selected writes
      set('#aw-sg-view', cfg.view ?? 'wards');
      break;
    }
    case 'chart':
      set('#aw-ch-source', cfg.source);
      syncChartFields(dialog);
      set('#aw-ch-metric', cfg.metric);
      set('#aw-ch-type', cfg.chart);
      set('#aw-ch-hours', cfg.hours ?? 24);
      if (cfg.source === 'status') set('#aw-ch-service', cfg.service);
      if (cfg.source === 'host') set('#aw-ch-host', cfg.service);
      break;
    case 'notion-page': {
      set('#aw-np-page', cfg.page);
      q<HTMLInputElement>('#aw-np-head', dialog)!.checked = cfg.head !== false;
      const chosen = Array.isArray(cfg.props) ? (cfg.props as string[]) : [];
      void loadPageProps(dialog, String(cfg.page ?? ''), chosen);
      const show = new Set(Array.isArray(cfg.show) ? (cfg.show as string[]) : ['props', 'blocks', 'comments']);
      const field = q<HTMLSelectElement>('#aw-np-show', dialog);
      if (field) {
        for (const o of field.options) o.selected = show.has(o.value);
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      set('#aw-np-depth', cfg.depth ?? 2);
      break;
    }
    case 'notion-db':
    case 'checklist':
    case 'notion-tasks':
      if (w.type === 'notion-db') {
        set('#aw-cl-view', cfg.view === 'list' || cfg.view === 'calendar' ? cfg.view : 'table');
        syncDbView(dialog, w.type);
        if (typeof cfg.date === 'string') {
          const date = q<HTMLSelectElement>('#aw-cl-date', dialog)!;
          date.append(new Option(cfg.date, cfg.date, false, true)); // loadColumns rebuilds the list around it
        }
      }
      set('#aw-cl-db', cfg.db);
      set('#aw-cl-show', cfg.show ?? 'open');
      set('#aw-cl-sort', cfg.sort ?? 'due');
      set('#aw-cl-limit', cfg.limit ?? '');
      if (typeof cfg.ds === 'string') {
        const ds = q<HTMLSelectElement>('#aw-cl-ds', dialog)!;
        ds.append(new Option('…', cfg.ds, false, true)); // replaced by the real name once the schema lands
      }
      void loadColumns(dialog, String(cfg.db ?? ''), Array.isArray(cfg.props) ? (cfg.props as string[]) : []);
      break;
  }
}

let editingId: string | null = null;
/** Where "Add ward" lands: a group's nest, or the page grid. */
let addInto: HTMLElement | null = null;

function openDialog(existing?: WardInstance, into: HTMLElement | null = null): void {
  const els = dialogEls();
  if (!els) return;
  els.dialog.querySelector('form')!.reset();
  els.err.classList.add('hidden');
  editingId = existing?.i ?? null;
  addInto = into;
  q('[data-aw-heading]', els.dialog)!.textContent = existing ? `Configure — ${wardTitle(existing)}` : 'Add ward';
  q('[data-aw-submit]', els.dialog)!.textContent = existing ? 'Save' : 'Add';

  // Search + chips + grid hide together on the configure path (which also
  // keeps the box's autofocus unreachable there).
  q('[data-aw-picker]', els.dialog)!.hidden = !!existing;
  resetPicker();
  if (existing) {
    selectCard(els.dialog, existing.type);
    els.title.value = existing.title ?? '';
    fillConfig(els.dialog, existing);
    if (existing.type === 'remote-desktop') {
      const host = q<HTMLElement>('[data-rd-access]', els.dialog)!;
      host.replaceChildren();
      if (existing.device) void import('./remote-desktop-settings.ts').then(m => {
        if (editingId === existing.i) void m.remoteDesktopSettings(host, existing.device!);
      });
    }
  } else {
    // Non-multi types can exist once — grey their cards out.
    const present = new Set([...state.values()].map((w) => w.type));
    let first: string | null = null;
    els.dialog.querySelectorAll<HTMLButtonElement>('.aw-card').forEach((c) => {
      const t = c.dataset.type!;
      c.disabled = !CATALOG[t]?.multi && present.has(t);
      if (!c.disabled && !first) first = t;
    });
    selectCard(els.dialog, first ?? 'applink');
  }
  els.dialog.showModal();
}

function newShell(w: WardInstance): HTMLElement | null {
  const tpl = q<HTMLTemplateElement>('#wd-template');
  if (!tpl) return null;
  const node = (tpl.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
  node.dataset.wd = w.i;
  node.dataset.wdType = w.type;
  stampSize(node, w.size);
  stampHidden(node, !!w.hidden);
  stampPage(node, w.page);
  stampWardTheme(node, w.theme);
  if (!CATALOG[w.type]?.configurable) node.querySelector('[data-act="cfg"]')?.remove();
  if (w.type === 'container') {
    // The same chrome Ward.astro renders for a group: peek strip + nest.
    const body = node.querySelector<HTMLElement>('[data-body]')!;
    body.textContent = '';
    body.classList.remove('overflow-y-auto');
    const peek = el('div', 'wd-peek');
    peek.dataset.peek = '';
    const nest = el('div', 'wd-grid wd-nest');
    nest.dataset.nest = '';
    body.append(peek, nest);
    nestWatch?.observe(nest);
    const header = node.querySelector('header')!;
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    const chev = el('button', 'wd-chevron', '›') as HTMLButtonElement;
    chev.type = 'button';
    chev.dataset.act = 'open';
    chev.title = 'Open group';
    chev.setAttribute('aria-label', 'Open group');
    chev.setAttribute('aria-expanded', 'false');
    header.append(chev);
  }
  return node;
}

function applyTitle(w: WardInstance): void {
  const h = q(`[data-wd="${w.i}"] [data-wd-title]`);
  if (h) h.textContent = wardTitle(w);
}

// ------------------------------------------------------------------ picker

const AW_ENTRIES = Object.entries(CATALOG).filter(([, c]) => !c.legacy);
/** The functional half of the search also knows every trigger/action label anchored on a type. */
const AW_DOES = registryDoes([...Object.values(TRIGGERS), ...Object.values(ACTIONS)]);
/** Clears the query and the chip; set by bootPicker, called by openDialog. */
let resetPicker: () => void = () => {};

/** The catalog picker: query → searchCatalog → hide/reorder cards; a chip
 *  narrows to one category. While a query is active the groups flatten into
 *  score order; clearing it restores the grouped, server-rendered order. */
function bootPicker(dialog: HTMLDialogElement): void {
  const box = q<HTMLInputElement>('[data-aw-q]', dialog);
  const cats = q<HTMLElement>('[data-aw-cats]', dialog);
  const catalog = q<HTMLElement>('[data-aw-catalog]', dialog);
  if (!box || !cats || !catalog) return;
  const grouped = [...catalog.children] as HTMLElement[]; // eyebrows + cards, server order
  const card = new Map(grouped.filter((n) => n.dataset.type).map((n) => [n.dataset.type!, n]));
  let timer = 0;

  const apply = () => {
    clearTimeout(timer);
    const cat = cats.querySelector<HTMLElement>('.aw-cat[aria-pressed="true"]')?.dataset.cat ?? '';
    const ranked = box.value.trim() ? searchCatalog(box.value, AW_ENTRIES, AW_DOES).map((h) => h.type) : null;
    const shown = new Set((ranked ?? [...card.keys()]).filter((t) => !cat || CATALOG[t]!.category === cat));
    for (const n of grouped) n.hidden = n.dataset.type ? !shown.has(n.dataset.type) : !!ranked || (!!cat && n.dataset.cat !== cat);
    catalog.append(...(ranked ? ranked.map((t) => card.get(t)!) : grouped)); // append = move, in this order
  };
  resetPicker = () => {
    box.value = '';
    cats.querySelectorAll('.aw-cat').forEach((c) => { c.setAttribute('aria-pressed', String(!c.getAttribute('data-cat'))); });
    apply();
  };

  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(apply, 80);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
      const first = catalog.querySelector<HTMLButtonElement>('.aw-card:not([hidden]):not(:disabled)');
      if (!first) return;
      selectCard(dialog, first.dataset.type!);
      first.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape' && box.value) {
      e.preventDefault(); // first Esc clears, second closes
      box.value = '';
      apply();
    }
  });
  cats.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.aw-cat');
    if (!b) return;
    cats.querySelectorAll('.aw-cat').forEach((c) => { c.setAttribute('aria-pressed', String(c === b)); });
    apply();
  });
}

function bootDialog(): void {
  const els = dialogEls();
  if (!els) return;
  const { dialog, type, title, err } = els;

  dialog.querySelectorAll('[data-aw-close]').forEach((b) => { b.addEventListener('click', () => dialog.close()); });
  // A stale editingId makes applyLayout refuse every push that drops that
  // ward — including an undo of its own removal.
  dialog.addEventListener('close', () => {
    editingId = null;
    addInto = null;
  });
  q<HTMLSelectElement>('#aw-fx', dialog)?.addEventListener('change', () => syncFx(dialog));
  // Weather: the geocoder's matches are buttons; picking one fills the coordinates.
  const findPlace = async () => {
    const place = q<HTMLInputElement>('#aw-we-place', dialog)!.value.trim();
    const box = q('[data-we-matches]', dialog)!;
    box.textContent = '';
    if (place.length < 2) return;
    const { status, data } = await getJson(`/api/weather/geocode?q=${encodeURIComponent(place)}`);
    const places = status === 200 && Array.isArray(data?.places) ? (data.places as { name: string; region: string; lat: number; lon: number }[]) : [];
    if (!places.length) {
      box.append(el('p', 'text-[10px] text-ink-faint', status === 200 ? 'No match.' : 'The geocoder is unavailable — type the coordinates.'));
      return;
    }
    for (const p of places) {
      const b = el('button', 'btn min-h-0 px-2 py-1 text-xs', p.region ? `${p.name} · ${p.region}` : p.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        q<HTMLInputElement>('#aw-we-lat', dialog)!.value = String(p.lat);
        q<HTMLInputElement>('#aw-we-lon', dialog)!.value = String(p.lon);
        const name = q<HTMLInputElement>('#aw-we-name', dialog)!;
        if (!name.value.trim()) name.value = p.name;
        box.textContent = '';
      });
      box.append(b);
    }
  };
  q('[data-we-find]', dialog)?.addEventListener('click', () => void findPlace());
  q('#aw-we-place', dialog)?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void findPlace();
  });
  // Launcher rows: add, remove, and a picked https target prefills an empty URL.
  dialog.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-al-add]')) alRow(dialog);
    else t.closest('[data-al-del]')?.closest('[data-al-row]')?.remove();
  });
  dialog.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-al-svc]');
    if (!sel) return;
    const url = q<HTMLInputElement>('[data-al-url]', sel.closest('[data-al-row]')!)!;
    if (!url.value.trim()) url.value = sel.selectedOptions[0]?.dataset.url ?? '';
  });
  dialog.querySelectorAll<HTMLButtonElement>('.aw-card').forEach((c) => {
    c.addEventListener('click', () => {
      if (!c.disabled) selectCard(dialog, c.dataset.type!);
    });
  });
  bootPicker(dialog);
  q<HTMLSelectElement>('#aw-ch-source', dialog)?.addEventListener('change', () => syncChartFields(dialog));
  q<HTMLSelectElement>('#aw-ag-provider', dialog)?.addEventListener('change', () => void loadAgentModels(dialog));
  q<HTMLInputElement>('#aw-ag-endpoint', dialog)?.addEventListener('change', () => void loadAgentModels(dialog));
  // An MCP preset prefills name, url and header; the token is set on the ward.
  q<HTMLSelectElement>('#aw-mc-preset', dialog)?.addEventListener('change', (e) => {
    const o = (e.target as HTMLSelectElement).selectedOptions[0];
    if (!o?.value) return;
    q<HTMLInputElement>('#aw-mc-name', dialog)!.value = o.value;
    q<HTMLInputElement>('#aw-mc-url', dialog)!.value = o.dataset.url ?? '';
    q<HTMLInputElement>('#aw-mc-header', dialog)!.value = o.dataset.header ?? 'Authorization';
  });
  const clDb = q<HTMLInputElement>('#aw-cl-db', dialog);
  q<HTMLSelectElement>('#aw-cl-pick', dialog)?.addEventListener('change', (e) => {
    clDb!.value = (e.target as HTMLSelectElement).value;
    clDb!.dispatchEvent(new Event('change'));
  });
  clDb?.addEventListener('change', () => void loadColumns(dialog, clDb.value, []));
  q<HTMLSelectElement>('#aw-cl-ds', dialog)?.addEventListener('change', () => void loadColumns(dialog, clDb!.value, []));
  q<HTMLSelectElement>('#aw-cl-view', dialog)?.addEventListener('change', () => syncDbView(dialog, q<HTMLInputElement>('#aw-type', dialog)!.value));

  const npPage = q<HTMLInputElement>('#aw-np-page', dialog);
  const npQuery = q<HTMLInputElement>('#aw-np-q', dialog);
  let searchTimer = 0;
  npQuery?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void searchPages(dialog, npQuery.value), 350);
  });
  q<HTMLSelectElement>('#aw-np-pick', dialog)?.addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (!id) return;
    npPage!.value = id;
    npPage!.dispatchEvent(new Event('change'));
  });
  npPage?.addEventListener('change', () => void loadPageProps(dialog, npPage.value, []));

  q('[data-aw-submit]', dialog)!.addEventListener('click', () => {
    const t = editingId ? state.get(editingId)!.type : type.value;
    const cfg = readConfig(dialog, t);
    if (cfg === null) {
      err.textContent = TASK_TYPES.has(t)
        ? 'That is not a valid Notion database link or id.'
        : t === 'notion-page'
          ? 'That is not a valid Notion page link or id.'
          : 'A valid http(s) URL is required.';
      err.classList.remove('hidden');
      return;
    }
    const secrets = lastSecrets;
    lastSecrets = {};
    if (editingId) {
      const w = state.get(editingId)!;
      if (Object.keys(secrets).length) pendingSecrets.set(w.i, { ...pendingSecrets.get(w.i), ...secrets });
      w.title = title.value.trim() || undefined;
      // A ward's identity link (which document a notepad shows, which notebook a
      // Notebook ward shares) rides along unless a loaded picker made the choice:
      // without this a Configure would silently point the ward back at its own id.
      for (const k of IDENTITY[w.type] ?? []) {
        const picker = q<HTMLElement>(`[data-identity="${k}"]`, dialog);
        if (picker?.dataset.loaded) continue;
        if (w.config?.[k] !== undefined && cfg[k] === undefined) cfg[k] = w.config[k];
      }
      w.config = cfg;
      applyTitle(w);
      dialog.close();
      commitThenRender(() => rerenderInstance(w));
      return;
    } else {
      const w: WardInstance = {
        i: newId('w'),
        type: t,
        size: CATALOG[t]?.defaultSize ?? '2x1',
      };
      if (title.value.trim()) w.title = title.value.trim();
      if (Object.keys(cfg).length > 0) w.config = cfg;
      if (Object.keys(secrets).length) pendingSecrets.set(w.i, secrets);
      if (currentPage() !== firstPage()) w.page = currentPage(); // layoutOf strips it again if it lands in a group
      state.set(w.i, w);
      const shell = newShell(w);
      if (shell) {
        // Groups do not nest: one lands on the page grid whatever asked for it.
        const into = addInto?.isConnected && t !== 'container' ? addInto : grid;
        flip(() => into.append(shell));
        applyTitle(w);
        revealShell(shell);
        dialog.close();
        commitThenRender(() => bootInstance(w));
        return;
      }
    }
    dialog.close();
    commit();
  });
}

// ---------------------------------------------------------------- toolbar

export function bootEdit(): void {
  const g = q('#wd-grid');
  const toolbar = q('#wd-toolbar');
  if (!g || !toolbar) return;
  grid = g;
  for (const w of readLayout()) state.set(w.i, w);
  baseline = structuredClone(layoutOf());
  baseKey = layoutKey(baseline);

  if (popoutWard) return;

  const btn = (name: string) => q<HTMLButtonElement>(`[data-tb="${name}"]`, toolbar)!;
  const hint = q('[data-tb-hint]', toolbar);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const hintFor = (on: boolean) =>
    coarse ? (on ? 'Hold a card to drag it' : 'Hold a ward for options') : on ? 'Drag cards to arrange — right-click for more' : 'Right-click a ward for options';
  if (hint) hint.textContent = hintFor(false);
  const setEditing = (on: boolean) => {
    // A flip: the edit chrome changes card heights a little, so neighbours glide.
    flip(() => grid.classList.toggle('editing', on));
    syncTray();
    relabel(btn('edit'), on ? 'check' : 'pen', on ? 'Done' : 'Edit');
    btn('add').classList.toggle('hidden', !on);
    btn('cancel').classList.toggle('hidden', !on);
    if (hint) hint.textContent = hintFor(on);
  };

  btn('edit').addEventListener('click', async () => {
    if (!isEditing()) {
      setEditing(true);
      return;
    }
    btn('edit').disabled = true;
    const ok = await save();
    btn('edit').disabled = false;
    if (ok) {
      saveDesktopState('layout-draft', undefined);
      setEditing(false);
      toast('Layout saved.');
    } else {
      toast('Saving the layout failed — still in edit mode.', undefined, true);
    }
  });
  btn('cancel').addEventListener('click', () => { saveDesktopState('layout-draft', undefined); location.reload(); });
  btn('add').addEventListener('click', () => openDialog());

  // Undo appears once there is something to undo — in edit mode and out of it,
  // because the context menu edits and saves outside edit mode too.
  const undoBtn = btn('undo');
  syncUndo = () => undoBtn.classList.toggle('hidden', !undoStack.length);
  syncUndo();
  undoBtn.addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'z' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    // Fields and remote input surfaces keep their own undo history.
    if (keyboardInUse(e)) return;
    if (grid.classList.contains('wiring') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    undo();
  });

  trayEl = el('div', 'wd-tray');
  trayEl.id = 'wd-tray';
  trayEl.hidden = true;
  grid.after(trayEl);

  // A page added/renamed/moved/deleted (pages.ts) saves beside the layout —
  // immediately outside edit mode, on Done inside it, like every other edit.
  window.addEventListener('fd:pages-changed', () => commit());
  window.addEventListener('fd:page', () => syncTray());

  bootActions();
  bootDrag();
  bootResize();
  bootMenu();
  bootDialog();
  bootGroups();
  const recovered = readDesktopCheckpoint<{ layout: unknown; pages: unknown; undo?: unknown[]; noteMoves?: [string, { id: string; notebook: string }][]; editing: boolean; page?: string }>('layout-draft');
  const pages = recovered && validatePages(recovered.pages);
  const layout = pages && validateLayout(recovered?.layout, pages);
  if (recovered && pages && layout) {
    if (recovered.editing) {
      setEditing(true);
      for (const [ward, move] of recovered.noteMoves ?? []) noteMoves.set(ward, move);
      publishPages(pages);
      applyLayout(layout, new Set(), true);
      if (recovered.page && pages.some(page => page.id === recovered.page)) showPage(recovered.page);
    }
    undoStack.splice(0, undoStack.length, ...(recovered.undo ?? []).map(value => validateLayout(value, pages)).filter((value): value is WardInstance[] => !!value));
    syncUndo();
  }
  window.addEventListener('fd:before-workspace-navigation', event => {
    (event as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(Promise.resolve().then(async () => {
      if (pendingSecrets.size) throw Error('Save the ward credentials with Done before opening macOS permission settings.');
      if (!isEditing() && !(await save())) throw Error('The dashboard could not be saved. Try again before relaunching.');
      saveDesktopState('layout-draft', { layout: layoutOf(), pages: readPages(), undo: undoStack, noteMoves: [...noteMoves], editing: isEditing(), page: currentPage() });
    }));
  });
}
