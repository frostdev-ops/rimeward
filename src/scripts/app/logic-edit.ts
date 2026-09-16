// Wiring mode: the visual logic editor. Ports appear on wards that can
// trigger, dragging from a port draws a live wire, dropping on a valid ward
// (or a global-action dock chip) opens a registry-driven config popover, and
// the wire's pill carries the logic. Mutually exclusive with edit mode —
// everything in edit.ts keys off `.editing`, we key off `.wiring`.
//
// Session semantics mirror edit mode: work on a local copy, Done PUTs,
// Cancel discards. All strings rendered via textContent — titles are hostile.

import {
  ACTIONS,
  CONDITIONS,
  MAX_CONDITIONS,
  TEMPLATE_VARS,
  TRIGGERS,
  wardTypes,
  validateGraph,
  type LogicEdge,
  type ParamSpec,
} from '../../lib/logic.ts';
import { pageOf, wardTitle, type WardInstance } from '../../lib/wards.ts';
import { readLayout } from './wards.ts';
import { readPages, showPage } from './pages.ts';
import { ago, el, newId, postJson, toast } from './dom.ts';
import { icon, relabel } from './icon.ts';
import { ensureStream, onRun, type RunEvent } from './logic.ts';
import * as wires from './wires.ts';
import { WORKSPACE_CONSUMERS } from '../../lib/dev/workspace-contract.ts';
import { flushWorkspaceEditors, workspaceApi } from './workspace.ts';

interface RunRecord {
  result: 'ok' | 'skipped' | 'error';
  detail: string;
  at: string;
}

let grid: HTMLElement;
let logicBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
const edges = new Map<string, LogicEdge>();
const workspaceLinks = new Map<string, string | null>();
let workspaceBase = new Map<string, string | null>();
let saved: LogicEdge[] = [];
let runs: Record<string, RunRecord> = {};
let isAdmin = false;
let pendingNew: string | null = null;
let dock: HTMLElement | null = null;
let ghostAnchor: HTMLElement | null = null;

const isWiring = () => grid.classList.contains('wiring');
const wardEl = (id: string) => document.querySelector<HTMLElement>(`[data-wd="${id}"]`);
const layoutById = () => new Map(readLayout().map((w) => [w.i, w]));

// ------------------------------------------------------------- registry maps

const triggersFor = (type: string) => Object.entries(TRIGGERS).filter(([, t]) => wardTypes(t).includes(type));
const actionsFor = (type: string) => Object.entries(ACTIONS).filter(([, a]) => wardTypes(a).includes(type));
const globalActions = () => Object.entries(ACTIONS).filter(([, a]) => !a.wardType && (!a.adminOnly || isAdmin));
const workspaceConsumer = (type: string) => (WORKSPACE_CONSUMERS as readonly string[]).includes(type);

// ------------------------------------------------------------------- wires ⇄

function specFor(edge: LogicEdge, forGhost = false): wires.WireSpec | null {
  const src = wardEl(edge.source.ward);
  const dst = edge.action.ward ? wardEl(edge.action.ward) : forGhost ? ensureGhostAnchor() : dock?.querySelector<HTMLElement>(`[data-chip="${edge.action.type}"]`) ?? null;
  if (!src || !dst) return null;
  // An end without a box (another page outside Leylines mode, where pages
  // are display:none) has no geometry to draw to; the list still edits it.
  if (!src.getClientRects().length || !dst.getClientRects().length) return null;
  const trig = TRIGGERS[edge.source.trigger];
  const act = ACTIONS[edge.action.type];
  const label = `${trig?.label ?? 'Trigger'}${edge.conditions.length ? ' ⋯' : ''} → ${act?.label ?? 'Action'}`;
  return { id: edge.id, label, error: runs[edge.id]?.result === 'error', disabled: !edge.enabled, src, dst };
}

function syncWires(seed?: { id: string; a: { x: number; y: number; vx: number; vy: number }; b: { x: number; y: number; vx: number; vy: number } }): void {
  stampWards();
  const specs: wires.WireSpec[] = [];
  for (const edge of edges.values()) {
    const spec = specFor(edge);
    if (spec) specs.push(spec);
  }
  for (const [consumer, workspace] of workspaceLinks) {
    const src = workspace && wardEl(workspace), dst = wardEl(consumer);
    if (src && dst) specs.push({ id: `workspace:${consumer}`, label: 'Workspace', error: false, disabled: false, src, dst });
  }
  wires.setWires(specs, seed);
  refreshList();
}

/** Wards passing `pred` as options, labelled `Page › Ward` once there is more
 *  than one page — so a cross-page leyline is a pick, not a drag. */
function fillWardSelect(sel: HTMLSelectElement, pred: (w: WardInstance) => boolean, blank?: string): void {
  const layout = readLayout();
  const pages = readPages();
  sel.replaceChildren();
  if (blank !== undefined) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = blank;
    sel.append(o);
  }
  for (const p of pages) {
    for (const w of layout) {
      if (!pred(w) || pageOf(w, pages, layout) !== p.id) continue;
      const o = document.createElement('option');
      o.value = w.i;
      o.textContent = pages.length > 1 ? `${p.title} › ${wardTitle(w)}` : wardTitle(w);
      sel.append(o);
    }
  }
}

function ensureGhostAnchor(): HTMLElement {
  if (!ghostAnchor) {
    ghostAnchor = el('div');
    ghostAnchor.style.cssText = 'position:fixed;left:50%;bottom:12px;width:2px;height:2px;pointer-events:none;opacity:0';
    document.body.append(ghostAnchor);
  }
  return ghostAnchor;
}

// ------------------------------------------------------------------ stamping

function stampWards(): void {
  const byId = layoutById();
  for (const node of grid.querySelectorAll<HTMLElement>('[data-wd]')) {
    const w = byId.get(node.dataset.wd ?? '');
    const type = w?.type ?? '';
    node.toggleAttribute('data-logic-src', type === 'workspace' || triggersFor(type).length > 0);
    node.toggleAttribute('data-logic-dst', workspaceConsumer(type) || actionsFor(type).length > 0);
  }
}

/** Outside Leylines mode a card with a leyline to another page shows a chip
 *  naming the far end; tapping it swaps page and pulses that card. */
function stampCross(): void {
  for (const c of grid.querySelectorAll('.wd-xpage')) c.remove();
  const layout = readLayout();
  const pages = readPages();
  if (pages.length < 2) return;
  const byId = new Map(layout.map((w) => [w.i, w]));
  const pg = (id: string) => {
    const w = byId.get(id);
    return w ? pageOf(w, pages, layout) : undefined;
  };
  const seen = new Set<string>();
  const bindings = layout.filter(w => w.workspace).map(w => ({ source: { ward: w.workspace! }, action: { ward: w.i } }));
  for (const e of [...saved, ...bindings]) {
    if (!e.action.ward) continue;
    for (const [here, there] of [
      [e.source.ward, e.action.ward],
      [e.action.ward, e.source.ward],
    ] as const) {
      const p = pg(there);
      if (!p || p === pg(here) || seen.has(`${here}>${there}`)) continue;
      seen.add(`${here}>${there}`);
      const card = wardEl(here);
      const far = byId.get(there);
      if (!card || !far) continue;
      const chip = el('button', 'wd-xpage') as HTMLButtonElement;
      chip.type = 'button';
      chip.append(icon('route'), el('span', undefined, `${pages.find((x) => x.id === p)?.title ?? p} › ${wardTitle(far)}`));
      chip.title = 'A leyline reaches this ward on another page';
      chip.addEventListener('click', () => {
        showPage(p);
        const target = wardEl(there);
        if (!target) return;
        target.removeAttribute('data-agent-touch');
        void target.offsetWidth; // restart the pulse
        target.setAttribute('data-agent-touch', '');
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => target.removeAttribute('data-agent-touch'), 1300);
      });
      card.querySelector('[data-wd-port]')?.before(chip);
    }
  }
}

// ---------------------------------------------------------------------- dock

function buildDock(): void {
  dock?.remove();
  dock = el('div');
  dock.id = 'logic-dock';
  const list = el('button', 'chip') as HTMLButtonElement;
  list.type = 'button';
  list.append(icon('list'), el('span', undefined, 'List'));
  list.title = 'Every leyline as a list — edit without drawing';
  list.addEventListener('click', () => (listEl ? closeList() : openList()));
  dock.append(list);
  for (const [id, spec] of globalActions()) {
    const chip = el('button', 'chip'); chip.append(icon(spec.icon), el('span', undefined, spec.label));
    chip.type = 'button';
    chip.dataset.chip = id;
    chip.title = 'Drag a leyline here';
    dock.append(chip);
  }
  document.body.append(dock);
}

// ------------------------------------------------------------------ popover

let popEl: HTMLElement | null = null;

function closePopover(discardPending = true): void {
  popEl?.remove();
  popEl = null;
  if (discardPending && pendingNew) {
    edges.delete(pendingNew);
    pendingNew = null;
    syncWires();
  }
  pendingNew = null;
}

interface Field {
  root: HTMLElement;
  read: () => unknown;
}

// A template field used to render as a bare box with chips under it, which is
// how a rule got built whose entire prompt was `{{item.what}}` — it rendered to
// the word "done" and asked the agent nothing. The placeholder says what the
// box is for; `slot` (`<type>.<param>`) lets the ones that matter say it in
// their own terms.
const TEMPLATE_HINTS: Record<string, string> = {
  'agent.ask.prompt': 'Tell Rime what to do, e.g. "Summarize this and text me"',
  'flow.sort.channels': 'billing: invoices and receipts; school: anything from .edu; noise',
  'model-says.question': 'Is this mail urgent? "{{mail.subject}}: {{mail.snippet}}"',
  'chat.send.channel': 'blank = where the message came from, else the ward\'s default',
  'chat.send.text': 'e.g. "{{msg.from}} said: {{msg.text}}" or "{{agent.reply}}"',
  'chat.react.emoji': '👍, or name:id for a custom emoji',
  'message-arrived.channel': 'a channel id — blank = every watched channel',
  'message-arrived.from': 'a sender id — blank = anyone',
  'reaction-added.channel': 'a channel id — blank = every watched channel',
  'reaction-added.emoji': 'blank = any emoji',
};

function fieldFor(label: string, spec: ParamSpec, value: unknown, trigger?: string, slot?: string): Field {
  const root = el('div', 'flex flex-col gap-1');
  root.append(el('label', 'label', label));
  if (spec.kind === 'select') {
    const sel = el('select', 'input') as HTMLSelectElement;
    for (const opt of spec.options ?? []) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    if (typeof value === 'string') sel.value = value;
    root.append(sel);
    return { root, read: () => sel.value };
  }
  if (spec.kind === 'ward') {
    const sel = el('select', 'input') as HTMLSelectElement;
    // Optional means optional: with no blank row the first ward is always
    // submitted, and an agent's reply would be delivered somewhere nobody chose.
    if (!spec.required) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '—';
      sel.append(none);
    }
    for (const w of readLayout()) {
      if (wardTypes(spec).length && !wardTypes(spec).includes(w.type)) continue;
      const o = document.createElement('option');
      o.value = w.i;
      o.textContent = wardTitle(w);
      sel.append(o);
    }
    if (typeof value === 'string') sel.value = value;
    root.append(sel);
    return { root, read: () => sel.value || undefined };
  }
  const NUMERIC: Partial<Record<string, [number, number]>> = { seconds: [1, 86400], minutes: [1, 1440], percent: [1, 100], count: [0, 10000], degrees: [-100, 150] };
  const range = NUMERIC[spec.kind];
  const input = el('input', 'input min-h-0 px-2 py-1 text-sm') as HTMLInputElement;
  input.type = spec.kind === 'time' ? 'time' : range ? 'number' : 'text'; // native picker for HH:MM
  if (range) {
    input.min = String(range[0]);
    input.max = String(range[1]);
  }
  input.placeholder =
    spec.kind === 'template' ? (TEMPLATE_HINTS[slot ?? ''] ?? 'Text — click a chip below to insert a value') :
    spec.kind === 'text' && TEMPLATE_HINTS[slot ?? ''] ? TEMPLATE_HINTS[slot ?? '']! :
    spec.kind === 'channel' ? 'channel (a-z, 0-9, -)' :
    spec.kind === 'email-list' ? 'a@b.com, c@d.com' :
    spec.kind === 'notion-id' ? 'Paste a Notion page link or id' :
    spec.kind === 'url' ? 'https://…' : '';
  input.value = Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value);
  root.append(input);
  if (spec.kind === 'template') {
    const chips = el('div', 'flex flex-wrap gap-1');
    for (const v of TEMPLATE_VARS) {
      // Only chips this edge's trigger can actually supply.
      if (v.triggers && (!trigger || !v.triggers.includes(trigger))) continue;
      const c = el('button', 'chip text-[10px]', v.label) as HTMLButtonElement;
      c.type = 'button';
      c.title = `{{${v.key}}}`;
      c.addEventListener('click', () => {
        input.setRangeText(`{{${v.key}}}`, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
        input.focus();
      });
      chips.append(c);
    }
    root.append(chips, el('div', 'text-[10px] text-ink-faint', 'Chips insert live values. Write an instruction around them — a chip alone just sends its value.'));
  }
  return {
    root,
    read: () => {
      const v = input.value.trim();
      if (!v) return undefined;
      if (range) return Number(v);
      if (spec.kind === 'email-list') return v.split(',').map((s) => s.trim()).filter(Boolean);
      return v;
    },
  };
}

function paramFields(
  specs: Record<string, ParamSpec>,
  values: Record<string, unknown>,
  trigger?: string,
  /** The trigger/condition/action these params belong to — half of a field's `slot`. */
  owner?: string
): { root: HTMLElement; read: () => Record<string, unknown> } {
  const root = el('div', 'flex flex-col gap-2');
  const fields: [string, Field][] = [];
  for (const [key, spec] of Object.entries(specs)) {
    const f = fieldFor(key === 'channel' && !spec.required ? 'channel filter (optional)' : key, spec, values[key], trigger, `${owner ?? ''}.${key}`);
    fields.push([key, f]);
    root.append(f.root);
  }
  return {
    root,
    read: () => {
      const out: Record<string, unknown> = {};
      for (const [key, f] of fields) {
        const v = f.read();
        if (v !== undefined) out[key] = v;
      }
      return out;
    },
  };
}

function openPopover(edge: LogicEdge, x: number, y: number): void {
  closePopover();
  const byId = layoutById();
  const srcW = byId.get(edge.source.ward);
  const dstW = edge.action.ward ? byId.get(edge.action.ward) : undefined;
  if (!srcW) return;

  const pop = el('div', 'wire-pop');
  popEl = pop;

  // header
  const head = el('div', 'flex items-center justify-between gap-2');
  const title = dstW ? `${wardTitle(srcW)} → ${wardTitle(dstW)}` : `${wardTitle(srcW)} → ${ACTIONS[edge.action.type]?.label ?? edge.action.type}`;
  head.append(el('div', 'section-title truncate', title));
  const close = el('button', 'btn min-h-0 px-2 py-1 text-xs'); close.append(icon('close')); close.setAttribute('aria-label', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => closePopover());
  head.append(close);
  pop.append(head);

  // Freely movable: grab anywhere on the header (except its buttons). Mobile
  // (<640px) keeps the pinned bottom sheet — its CSS inset would fight left/top.
  head.classList.add('wire-pop-grab');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    if (!matchMedia('(min-width: 640px)').matches) return;
    e.preventDefault(); // no text selection mid-drag
    const r = pop.getBoundingClientRect();
    const grabX = e.clientX - r.left;
    const grabY = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      // Free placement, but a graspable sliver of header always stays on-screen.
      pop.style.left = `${Math.min(Math.max(ev.clientX - grabX, 48 - r.width), innerWidth - 48)}px`;
      pop.style.top = `${Math.min(Math.max(ev.clientY - grabY, 8), innerHeight - 40)}px`;
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // When — trigger select + trigger params
  const whenWrap = el('div', 'flex flex-col gap-2');
  whenWrap.append(el('div', 'label', 'When'));
  const trigSel = el('select', 'input') as HTMLSelectElement;
  for (const [id, t] of triggersFor(srcW.type)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = t.label;
    trigSel.append(o);
  }
  trigSel.value = edge.source.trigger;
  whenWrap.append(trigSel);
  let trigParams = paramFields(TRIGGERS[trigSel.value]?.params ?? {}, edge.source.params, trigSel.value, trigSel.value);
  whenWrap.append(trigParams.root);
  trigSel.addEventListener('change', () => {
    const fresh = paramFields(TRIGGERS[trigSel.value]?.params ?? {}, {}, trigSel.value, trigSel.value);
    trigParams.root.replaceWith(fresh.root);
    trigParams = fresh;
  });
  pop.append(whenWrap);

  // If — condition rows
  const ifWrap = el('div', 'flex flex-col gap-2');
  ifWrap.append(el('div', 'label', 'If (all must hold)'));
  const rows = el('div', 'flex flex-col gap-2');
  ifWrap.append(rows);
  interface CondRow {
    root: HTMLElement;
    typeSel: HTMLSelectElement;
    read: () => { type: string; params: Record<string, unknown> };
  }
  const condRows: CondRow[] = [];
  const addCond = (type: string, params: Record<string, unknown>): void => {
    const root = el('div', 'flex flex-col gap-1 rounded border border-line p-2');
    const top = el('div', 'flex items-center gap-1');
    const typeSel = el('select', 'input min-h-0 flex-1 px-2 py-1 text-xs') as HTMLSelectElement;
    for (const [id, c] of Object.entries(CONDITIONS)) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = c.label;
      typeSel.append(o);
    }
    typeSel.value = type;
    const rm = el('button', 'btn min-h-0 px-2 py-1 text-xs'); rm.append(icon('close')); rm.setAttribute('aria-label', 'Remove condition');
    rm.type = 'button';
    top.append(typeSel, rm);
    root.append(top);
    let pf = paramFields(CONDITIONS[type]?.params ?? {}, params, trigSel.value, type);
    root.append(pf.root);
    typeSel.addEventListener('change', () => {
      const fresh = paramFields(CONDITIONS[typeSel.value]?.params ?? {}, {}, trigSel.value, typeSel.value);
      pf.root.replaceWith(fresh.root);
      pf = fresh;
    });
    const row: CondRow = { root, typeSel, read: () => ({ type: typeSel.value, params: pf.read() }) };
    rm.addEventListener('click', () => {
      root.remove();
      condRows.splice(condRows.indexOf(row), 1);
    });
    condRows.push(row);
    rows.append(root);
  };
  for (const c of edge.conditions) addCond(c.type, c.params);
  const addBtn = el('button', 'link self-start text-xs', '+ condition') as HTMLButtonElement;
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    if (condRows.length < MAX_CONDITIONS) addCond(Object.keys(CONDITIONS)[0]!, {});
  });
  ifWrap.append(addBtn);
  pop.append(ifWrap);

  // Do — target ward (the drop chose it; here it can change, across pages
  // too) + action select + params
  const doWrap = el('div', 'flex flex-col gap-2');
  doWrap.append(el('div', 'label', 'Do'));
  const targetSel = el('select', 'input') as HTMLSelectElement;
  fillWardSelect(targetSel, (w) => actionsFor(w.type).length > 0, '— no ward (a global action)');
  targetSel.value = edge.action.ward ?? '';
  targetSel.setAttribute('aria-label', 'Target ward');
  doWrap.append(targetSel);
  let dst = dstW;
  const actSel = el('select', 'input') as HTMLSelectElement;
  const fillActions = () => {
    actSel.replaceChildren();
    for (const [id, a] of dst ? actionsFor(dst.type) : globalActions()) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = a.label;
      actSel.append(o);
    }
  };
  fillActions();
  actSel.value = edge.action.type;
  doWrap.append(actSel);
  let actParams = paramFields(ACTIONS[actSel.value]?.params ?? {}, edge.action.params, trigSel.value, actSel.value);
  doWrap.append(actParams.root);
  actSel.addEventListener('change', () => {
    const fresh = paramFields(ACTIONS[actSel.value]?.params ?? {}, {}, trigSel.value, actSel.value);
    actParams.root.replaceWith(fresh.root);
    actParams = fresh;
  });
  targetSel.addEventListener('change', () => {
    dst = targetSel.value ? byId.get(targetSel.value) : undefined;
    fillActions();
    actSel.dispatchEvent(new Event('change', { bubbles: true })); // SearchSelect relabels on a bubbling change
  });
  pop.append(doWrap);

  // enabled + last run
  const enWrap = el('label', 'flex items-center gap-2 text-xs');
  const enCb = el('input') as HTMLInputElement;
  enCb.type = 'checkbox';
  enCb.checked = edge.enabled;
  enWrap.append(enCb, el('span', undefined, 'Enabled'));
  pop.append(enWrap);
  const run = runs[edge.id];
  if (run) {
    pop.append(
      el(
        'div',
        `text-[10px] ${run.result === 'error' ? 'text-warn' : 'text-ink-faint'}`,
        `Last run ${new Date(run.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${run.result}${run.detail ? `: ${run.detail}` : ''}`
      )
    );
  }

  const err = el('p', 'hidden text-xs text-err');
  pop.append(err);

  // footer
  const foot = el('div', 'flex items-center gap-2');
  const del = el('button', 'btn-danger min-h-0 px-2 py-1 text-xs', 'Delete') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => {
    const removed = edges.get(edge.id);
    const wasPending = pendingNew === edge.id;
    edges.delete(edge.id);
    pendingNew = null;
    closePopover(false);
    syncWires();
    if (removed && !wasPending) {
      toast('Removed leyline', {
        label: 'Undo',
        fn: () => {
          edges.set(removed.id, removed);
          syncWires();
        },
      });
    }
  });
  const spacer = el('div', 'flex-1');
  const cancel = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Cancel') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', () => closePopover());
  const save = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'Save') as HTMLButtonElement;
  save.type = 'button';
  save.addEventListener('click', () => {
    const candidate: LogicEdge = {
      id: edge.id,
      source: { ward: edge.source.ward, trigger: trigSel.value, params: trigParams.read() },
      conditions: condRows.map((r) => r.read()),
      action: { type: actSel.value, ...(targetSel.value ? { ward: targetSel.value } : {}), params: actParams.read() },
      enabled: enCb.checked,
    };
    const all = [...edges.values()].map((e) => (e.id === edge.id ? candidate : e));
    if (!edges.has(edge.id)) all.push(candidate);
    const why: string[] = [];
    const valid = validateGraph({ edges: all }, readLayout(), { isAdmin, why });
    if (!valid) {
      // Name the field. "Some fields are invalid" is the same dead end that
      // cost the agent nine tool calls against an unstated length cap.
      err.textContent = why[0] ?? 'Some fields are missing or invalid — check the required ones.';
      err.classList.remove('hidden');
      return;
    }
    for (const v of valid.edges) if (v.id === edge.id) edges.set(edge.id, v);
    pendingNew = null;
    closePopover(false);
    syncWires();
  });
  foot.append(del, spacer, cancel, save);
  pop.append(foot);

  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  if (matchMedia('(min-width: 640px)').matches) {
    pop.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  }
}

// --------------------------------------------------------------------- list
//
// The same graph as rows: `trigger → action @ target`, grouped by source ward
// in page order. It needs no drawing and no geometry — the leylines surface a
// phone opens first (the canvas is behind it), and the keyboard path on a
// desktop. A row opens the popover above; every mutation lands in `edges`
// and syncWires() repaints both the canvas and this.

let listEl: HTMLElement | null = null;
let listSource: string | null = null;
let listQuery = '';

function closeList(): void {
  listEl?.remove();
  listEl = null;
  listSource = null;
}

function openList(source: string | null = null): void {
  closeList();
  listSource = source;
  const pop = el('div', 'wire-pop wire-list');
  listEl = pop;
  const srcW = source ? layoutById().get(source) : undefined;

  const head = el('div', 'flex items-center justify-between gap-2');
  head.append(el('div', 'section-title truncate', srcW ? `Leylines · ${wardTitle(srcW)}` : 'Leylines'));
  const close = el('button', 'btn min-h-0 px-2 py-1 text-xs') as HTMLButtonElement;
  close.type = 'button';
  close.append(icon('close'));
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeList);
  head.append(close);
  pop.append(head);

  const bar = el('div', 'flex items-center gap-2');
  const filter = el('input', 'input min-h-0 flex-1 px-2 py-1 text-xs') as HTMLInputElement;
  filter.type = 'search';
  filter.placeholder = 'Filter';
  filter.value = listQuery;
  filter.setAttribute('aria-label', 'Filter leylines');
  filter.addEventListener('input', () => {
    listQuery = filter.value;
    refreshList();
  });
  const add = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'New leyline') as HTMLButtonElement;
  add.type = 'button';
  // With a source ward known the popover is the whole form; otherwise a
  // source pick comes first (its triggers are what the popover offers).
  const pick = el('select', 'input min-h-0 px-2 py-1 text-xs hidden') as HTMLSelectElement;
  fillWardSelect(pick, (w) => w.type === 'workspace' || triggersFor(w.type).length > 0, 'From which ward…');
  pick.setAttribute('aria-label', 'Source ward');
  pick.addEventListener('change', () => {
    if (pick.value) newEdge(pick.value, add);
    pick.value = '';
    pick.classList.add('hidden');
  });
  add.addEventListener('click', () => {
    if (listSource) newEdge(listSource, add);
    else {
      pick.classList.toggle('hidden');
      if (!pick.classList.contains('hidden')) pick.focus();
    }
  });
  bar.append(filter, add);
  pop.append(bar, pick);

  const rows = el('div', 'wire-list-rows');
  rows.dataset.rows = '';
  pop.append(rows);
  if (matchMedia('(pointer: coarse)').matches) pop.append(el('p', 'text-[10px] text-ink-faint', 'Close this to draw on the canvas instead.'));
  document.body.append(pop);
  refreshList();
}

/** A new edge from `source` — first trigger, first global action — straight
 *  into the popover, where the target and everything else is picked. */
function newEdge(source: string, at: HTMLElement): void {
  const w = layoutById().get(source);
  if (w?.type === 'workspace') { openList(source); return; }
  const trigger = w && triggersFor(w.type)[0]?.[0];
  const action = globalActions()[0]?.[0];
  if (!w || !trigger || !action) return;
  const edge: LogicEdge = { id: newId('e'), source: { ward: source, trigger, params: {} }, conditions: [], action: { type: action, params: {} }, enabled: true };
  edges.set(edge.id, edge);
  syncWires();
  const r = at.getBoundingClientRect();
  openPopover(edge, r.left, r.bottom + 8);
  pendingNew = edge.id; // after openPopover: its leading closePopover() discards pendingNew
}

function refreshList(): void {
  const rows = listEl?.querySelector<HTMLElement>('[data-rows]');
  if (!rows) return;
  rows.textContent = '';
  const layout = readLayout();
  const pages = readPages();
  const byId = new Map(layout.map((w) => [w.i, w]));
  const order = new Map(layout.map((w, i) => [w.i, i]));
  const pageIdx = (id: string) => {
    const w = byId.get(id);
    return w ? pages.findIndex((p) => p.id === pageOf(w, pages, layout)) : pages.length;
  };
  const title = (id: string | undefined) => (id && byId.get(id) ? wardTitle(byId.get(id)!) : (id ?? ''));
  const workspaceRows = layout.filter(w => workspaceConsumer(w.type) && (!listSource || w.i === listSource || byId.get(listSource)?.type === 'workspace'));
  for (const consumer of workspaceRows) {
    const query = listQuery.trim().toLowerCase();
    if (query && !`${wardTitle(consumer)} workspace ${title(workspaceLinks.get(consumer.i) ?? undefined)}`.toLowerCase().includes(query)) continue;
    const row = el('label', 'wire-row');
    row.append(el('span', 'wire-row-text', `${wardTitle(consumer)} · Workspace`));
    const select = el('select', 'input'); select.setAttribute('aria-label', `Workspace for ${wardTitle(consumer)}`);
    select.add(new Option('Default folder', ''));
    for (const workspace of layout.filter(w => w.type === 'workspace')) select.add(new Option(wardTitle(workspace), workspace.i));
    const chosen = workspaceLinks.get(consumer.i);
    if (chosen && !byId.has(chosen)) select.add(new Option('Missing Workspace', chosen));
    select.value = chosen ?? '';
    select.onchange = () => { workspaceLinks.set(consumer.i, select.value || null); syncWires(); };
    row.append(select); rows.append(row);
  }
  const text = (e: LogicEdge) =>
    `${title(e.source.ward)} ${TRIGGERS[e.source.trigger]?.label ?? ''} ${ACTIONS[e.action.type]?.label ?? ''} ${title(e.action.ward)}`.toLowerCase();
  const all = [...edges.values()].filter((e) => !listSource || e.source.ward === listSource);
  const q = listQuery.trim().toLowerCase();
  const shown = (q ? all.filter((e) => text(e).includes(q)) : all).sort(
    (a, b) => pageIdx(a.source.ward) - pageIdx(b.source.ward) || (order.get(a.source.ward) ?? 0) - (order.get(b.source.ward) ?? 0)
  );
  if (!shown.length) {
    if (!rows.children.length) rows.append(el('p', 'text-xs text-ink-faint', all.length ? 'No matches.' : 'No leylines yet.'));
    return;
  }
  let lastSrc = '';
  for (const e of shown) {
    if (!listSource && e.source.ward !== lastSrc) {
      lastSrc = e.source.ward;
      const w = byId.get(lastSrc);
      const page = w && pages.length > 1 ? pages.find((p) => p.id === pageOf(w, pages, layout))?.title : undefined;
      rows.append(el('div', 'label', `${title(lastSrc)}${page ? ` · ${page}` : ''}`));
    }
    const row = el('div', 'wire-row');
    if (!e.enabled) row.classList.add('opacity-60');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = e.enabled;
    cb.title = 'Enabled';
    cb.setAttribute('aria-label', 'Enabled');
    cb.addEventListener('change', () => {
      e.enabled = cb.checked;
      syncWires();
    });
    const main = el('button', 'wire-row-main') as HTMLButtonElement;
    main.type = 'button';
    const trig = TRIGGERS[e.source.trigger];
    const act = ACTIONS[e.action.type];
    main.append(
      el(
        'span',
        'wire-row-text',
        `${trig?.label ?? e.source.trigger}${e.conditions.length ? ' ⋯' : ''} → ${act?.label ?? e.action.type}${e.action.ward ? ` @ ${title(e.action.ward)}` : ''}`
      )
    );
    const run = runs[e.id];
    if (run) main.append(el('span', `wire-row-run ${run.result === 'error' ? 'text-warn' : 'text-ink-faint'}`, `${run.result} · ${ago(Date.now() - new Date(run.at).getTime())}`));
    main.addEventListener('click', (ev) => openPopover(e, ev.clientX, ev.clientY));
    row.append(cb, main);
    rows.append(row);
  }
}

// ---------------------------------------------------------------- wire drag

function bootPortDrag(): void {
  let src: HTMLElement | null = null;
  let started = false;
  let pointer = -1;
  let sx = 0;
  let sy = 0;
  let targets: { el: HTMLElement; left: number; top: number; right: number; bottom: number }[] = [];
  let hot: HTMLElement | null = null;
  // Touch draws after a 250ms still hold (frost.css: touch-action pan-y on
  // source cards for coarse pointers), so a move before that scrolls the page.
  let armed = true;
  let holdT = 0;
  const blockScroll = (ev: TouchEvent) => started && ev.preventDefault();

  const cleanup = () => {
    if (holdT) clearTimeout(holdT);
    holdT = 0;
    armed = true;
    window.removeEventListener('touchmove', blockScroll);
    for (const t of targets) {
      t.el.removeAttribute('data-drop-ok');
      t.el.removeAttribute('data-drop-hot');
    }
    grid.classList.remove('wire-dragging');
    targets = [];
    hot = null;
    src = null;
    started = false;
    pointer = -1;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };

  const collectTargets = () => {
    targets = [];
    const source = layoutById().get(src?.closest<HTMLElement>('[data-wd]')?.dataset.wd ?? src?.dataset.wd ?? '');
    for (const node of grid.querySelectorAll<HTMLElement>('[data-wd][data-logic-dst]')) {
      const target = layoutById().get(node.dataset.wd ?? '');
      if (!target || (source?.type === 'workspace' ? !workspaceConsumer(target.type) : !actionsFor(target.type).length)) continue;
      const r = node.getBoundingClientRect();
      targets.push({ el: node, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      node.setAttribute('data-drop-ok', '1');
    }
    for (const chip of dock?.querySelectorAll<HTMLElement>('[data-chip]') ?? []) {
      if (source?.type === 'workspace') continue;
      const r = chip.getBoundingClientRect();
      targets.push({ el: chip, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      chip.setAttribute('data-drop-ok', '1');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointer || !src) return;
    if (!started) {
      const far = Math.hypot(e.clientX - sx, e.clientY - sy) >= 6;
      if (!armed) {
        if (far) onCancel(); // moved before the hold fired: a scroll
        return;
      }
      if (!far) return;
      started = true;
      grid.classList.add('wire-dragging');
      wires.draftStart(src);
      collectTargets();
    }
    wires.draftTo(e.clientX + scrollX, e.clientY + scrollY);
    let over: HTMLElement | null = null;
    for (const t of targets) {
      if (e.clientX >= t.left && e.clientX <= t.right && e.clientY >= t.top && e.clientY <= t.bottom) {
        over = t.el;
        break;
      }
    }
    if (over !== hot) {
      hot?.removeAttribute('data-drop-hot');
      over?.setAttribute('data-drop-hot', '1');
      hot = over;
    }
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const dropped = started ? hot : null;
    const sourceWard = src?.closest<HTMLElement>('[data-wd]')?.dataset.wd ?? src?.dataset.wd;
    if (!dropped || !sourceWard) {
      wires.draftDiscard();
      cleanup();
      return;
    }
    const byId = layoutById();
    const srcW = byId.get(sourceWard);
    const seedPts = wires.draftEnd();
    cleanup();
    if (!srcW) return;
    if (srcW.type === 'workspace') {
      const target = dropped.dataset.wd;
      if (target && workspaceConsumer(byId.get(target)?.type ?? '')) {
        workspaceLinks.set(target, srcW.i);
        syncWires(seedPts ? { id: `workspace:${target}`, ...seedPts } : undefined);
      }
      return;
    }
    const firstTrigger = triggersFor(srcW.type)[0]?.[0];
    if (!firstTrigger) return;
    let action: LogicEdge['action'];
    const dstWardId = dropped.dataset.wd;
    if (dstWardId) {
      const dstW = byId.get(dstWardId);
      const first = dstW ? actionsFor(dstW.type)[0]?.[0] : undefined;
      if (!first) return;
      action = { type: first, ward: dstWardId, params: {} };
    } else {
      action = { type: dropped.dataset.chip!, params: {} };
      const spec = ACTIONS[action.type];
      for (const [key, p] of Object.entries(spec?.params ?? {})) {
        if (p.kind === 'select' && p.required && p.options?.length) action.params[key] = p.options[0];
      }
    }
    const edge: LogicEdge = { id: newId('e'), source: { ward: sourceWard, trigger: firstTrigger, params: {} }, conditions: [], action, enabled: true };
    edges.set(edge.id, edge);
    syncWires(seedPts ? { id: edge.id, ...seedPts } : undefined);
    openPopover(edge, e.clientX, e.clientY);
    // AFTER openPopover — its leading closePopover() discards pendingNew.
    pendingNew = edge.id;
  };

  const onCancel = () => {
    wires.draftDiscard();
    cleanup();
  };

  grid.addEventListener('pointerdown', (e) => {
    if (!isWiring() || e.button !== 0 || src) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, input, select, textarea')) return;
    // Any point on a trigger-capable ward starts a wire (reorder-drag is
    // edit-mode-only, so there's no gesture conflict); the port dot is the
    // affordance, not the only handle.
    const card = t.closest<HTMLElement>('[data-wd]');
    if (!card?.hasAttribute('data-logic-src')) return;
    e.preventDefault();
    e.stopPropagation();
    src = card;
    pointer = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    if (e.pointerType === 'touch') {
      armed = false;
      holdT = window.setTimeout(() => {
        holdT = 0;
        if (!src) return;
        armed = true;
        navigator.vibrate?.(10);
        window.addEventListener('touchmove', blockScroll, { passive: false });
      }, 250);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Never exit wiring itself on Escape — one keypress silently discarding
      // the session is a trap (menus/overlays share the key). Done/Cancel exit.
      if (src) onCancel();
      else if (popEl) closePopover();
      else if (listEl) closeList();
    }
  });
}

// -------------------------------------------------------------- mode toggle

function enterWiring(): void {
  ensureStream();
  edges.clear();
  workspaceLinks.clear();
  for (const w of readLayout()) if (workspaceConsumer(w.type)) workspaceLinks.set(w.i, w.workspace ?? null);
  workspaceBase = new Map(workspaceLinks);
  // Lenient revalidation against the CURRENT layout, exactly like the server's
  // reads: edges whose wards were removed since page load stay out of the
  // session (an invisible stale edge would 400 the strict PUT on Done).
  const alive = validateGraph({ edges: saved }, readLayout(), { isAdmin, lenient: true })?.edges ?? [];
  for (const e of alive) edges.set(e.id, structuredClone(e));
  grid.classList.add('wiring');
  relabel(logicBtn, 'check', 'Done');
  cancelBtn.classList.remove('hidden');
  document.querySelector<HTMLButtonElement>('[data-tb="edit"]')?.setAttribute('disabled', '');
  const hint = document.querySelector('[data-tb-hint]');
  if (hint) hint.textContent = 'Drag from any glowing ward to another to draw a leyline — click a leyline to edit it';
  wires.mountLayer();
  wires.setLive(true);
  buildDock();
  syncWires();
  if (!grid.querySelector('[data-logic-src]')) {
    toast('Nothing here can trigger yet — add a Timer, Flow, or other event ward to start drawing leylines.');
  }
}

function exitWiring(persist: boolean): void {
  closePopover();
  closeList();
  // An Undo toast surviving the mode would re-add wires over the live dashboard.
  document.querySelector('.fd-toast[data-logic]')?.remove();
  grid.classList.remove('wiring');
  relabel(logicBtn, 'route', 'Leylines');
  cancelBtn.classList.add('hidden');
  document.querySelector<HTMLButtonElement>('[data-tb="edit"]')?.removeAttribute('disabled');
  const hint = document.querySelector('[data-tb-hint]');
  if (hint) hint.textContent = 'Right-click a ward for options';
  wires.setLive(false);
  wires.clearWires();
  dock?.remove();
  dock = null;
  if (persist) saved = [...edges.values()].map((e) => structuredClone(e));
  stampCross();
}

async function saveAndExit(): Promise<void> {
  closePopover();
  logicBtn.disabled = true;
  try {
    const { workspaceDraft, applyWorkspaceLayout } = await import('./edit.ts');
    const links = [...workspaceLinks].filter(([ward, workspace]) => workspace !== workspaceBase.get(ward)).map(([ward, workspace]) => ({ ward, workspace, expectedWorkspace: workspaceBase.get(ward) ?? null }));
    if (links.length) {
      await flushWorkspaceEditors(links.map(link => link.ward));
      const result = await workspaceApi<{ layout: WardInstance[]; pages: ReturnType<typeof readPages> }>({ action: 'links', links, graph: { edges: [...edges.values()] }, expectedGraph: { edges: saved }, dashboard: workspaceDraft() });
      applyWorkspaceLayout(result.layout, result.pages);
    } else {
      const res = await postJson('/api/logic', { graph: { edges: [...edges.values()] } }, 'PUT');
      if (!res.ok) throw Error('Saving leylines failed.');
    }
    exitWiring(true);
    toast('Leylines saved.');
  } catch (e) { toast(`${(e as Error).message} Your Leylines draft is preserved.`, undefined, true); }
  finally { logicBtn.disabled = false; }
}

// --------------------------------------------------------------------- boot

export function bootLogicEdit(): void {
  const g = document.querySelector<HTMLElement>('#wd-grid');
  const toolbar = document.querySelector<HTMLElement>('#wd-toolbar');
  const btn = toolbar?.querySelector<HTMLButtonElement>('[data-tb="logic"]');
  if (!g || !toolbar || !btn) return;
  grid = g;
  logicBtn = btn;

  try {
    const data = JSON.parse(document.getElementById('logic-data')?.textContent ?? '{}') as {
      graph?: { edges?: LogicEdge[] };
      runs?: Record<string, RunRecord>;
      isAdmin?: boolean;
    };
    saved = data.graph?.edges ?? [];
    runs = data.runs ?? {};
    isAdmin = !!data.isAdmin;
  } catch {}

  cancelBtn = el('button', 'btn px-2 py-1 text-xs hidden') as HTMLButtonElement;
  cancelBtn.type = 'button';
  relabel(cancelBtn, 'close', 'Cancel');
  cancelBtn.addEventListener('click', () => exitWiring(false));
  logicBtn.insertAdjacentElement('afterend', cancelBtn);

  logicBtn.addEventListener('click', () => {
    if (isWiring()) void saveAndExit();
    else {
      enterWiring();
      // A phone opens the list first; the canvas is behind it.
      if (matchMedia('(pointer: coarse)').matches) openList();
    }
  });
  // The ward menu's "Leylines…" (edit.ts): this ward's leylines as a list.
  window.addEventListener('fd:leylines', (e) => {
    if (grid.classList.contains('editing')) return;
    if (!isWiring()) enterWiring();
    openList((e as CustomEvent<{ ward: string }>).detail.ward);
  });

  // Edit and Logic modes are mutually exclusive; edit.ts needs no changes.
  new MutationObserver(() => {
    logicBtn.disabled = grid.classList.contains('editing');
  }).observe(grid, { attributes: true, attributeFilter: ['class'] });

  wires.onWireClick((id, x, y) => {
    if (id.startsWith('workspace:') && isWiring()) { openList(id.slice('workspace:'.length)); return; }
    const edge = edges.get(id);
    if (edge && isWiring()) openPopover(edge, x, y);
  });

  bootPortDrag();
  stampCross();
  document.addEventListener('fd:layout-saved', stampCross);
  window.addEventListener('fd:pages-changed', stampCross);

  onRun((r: RunEvent) => {
    runs[r.edgeId] = { result: r.result, detail: r.detail, at: r.at };
    if (isWiring()) {
      syncWires();
      if (r.result === 'ok') wires.pulse(r.edgeId);
    } else if (r.result === 'ok') {
      const edge = saved.find((e) => e.id === r.edgeId);
      if (edge) {
        const spec = specFor(edge, true);
        if (spec) wires.ghost(spec);
      }
    }
  });
}
