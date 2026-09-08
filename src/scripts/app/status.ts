import { LiveEventSource } from './live-stream.ts';
// SSE client: a snapshot store with pub/sub. Ward renderers (host,
// service, service-group — registered into RENDERERS below) subscribe and
// draw wards; applink status dots update from the same stream. Page-level
// alerts + stale dimming stay here.

import { RENDERERS, body, readLayout } from './wards.ts';
import { ago, el, getJson, hm } from './dom.ts';
import { groupTitle, HOST_LABELS, HOST_SERVICE_IDS, shownServiceIds, sizeParts, type WardInstance } from '../../lib/wards.ts';
import { GROUPS, TARGETS } from '../../lib/targets.ts';

interface ServiceStatus {
  id: string;
  label: string;
  group: string;
  kind: string;
  ok: boolean | null;
  latencyMs: number | null;
  detail: string;
  since: string | null;
  /** pm2 kinds only — mirror of lib/status.ts. */
  cpu?: number;
  memMb?: number;
  restarts?: number;
  limitMb?: number;
  /** Client-only host rows: the value's unit (latencyMs holds a percent). */
  unit?: string;
}

interface Snapshot {
  at: string;
  host: {
    disk: { usedPct: number; freeGb: number };
    mem: { usedPct: number };
    load: number[] | null;
    cores: number;
  };
  alerts: string[];
  services: ServiceStatus[];
  /** Server boot marker; changes across deploys/restarts. */
  bootId?: string;
  /** The build actually running (frame decoration, like bootId). */
  build?: { stamp: string; bootedAt: string; node: string; rssMb: number };
  /** The first tick's time: a `since` equal to it is "since boot", not a change. */
  baselineAt?: string;
}

// ------------------------------------------------------------------ store

type Listener = (snap: Snapshot) => void;
let latest: Snapshot | null = null;
const listeners = new Set<Listener>();

/** Subscribe to snapshots; fires (async) immediately when one is already in. */
export function onSnapshot(fn: Listener): () => void {
  listeners.add(fn);
  if (latest) {
    const snap = latest;
    queueMicrotask(() => {
      if (listeners.has(fn)) fn(snap);
    });
  }
  return () => listeners.delete(fn);
}

/** Subscribe on behalf of a ward; self-drops once the ward leaves the
 *  DOM, and re-rendering the same instance (config change) replaces the old
 *  subscription instead of stacking a second one. */
const wardSubs = new Map<string, () => void>();
function wardSnapshots(w: WardInstance, fn: Listener): void {
  wardSubs.get(w.i)?.();
  const un = onSnapshot((snap) => {
    if (!document.querySelector(`[data-wd="${w.i}"]`)) {
      un();
      wardSubs.delete(w.i);
      return;
    }
    fn(snap);
  });
  wardSubs.set(w.i, un);
}

// ------------------------------------------------------------- sparklines

const SPARK_SAMPLES = 30;
const sparks = new Map<string, (number | null)[]>();
let seeded = false;

function pushSample(id: string, ms: number | null): void {
  const buf = sparks.get(id) ?? [];
  buf.push(ms);
  while (buf.length > SPARK_SAMPLES) buf.shift();
  sparks.set(id, buf);
}

function drawSpark(ward: HTMLElement, buf: (number | null)[]): void {
  const line = ward.querySelector('polyline');
  if (!line) return;
  const vals = buf.filter((v): v is number => v !== null);
  if (vals.length < 2) {
    line.setAttribute('points', '');
    return;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  const max = Math.max(p95, 1);
  const step = 60 / (SPARK_SAMPLES - 1);
  const pts: string[] = [];
  buf.forEach((v, i) => {
    if (v === null) return;
    const y = 15 - Math.min(v / max, 1.4) * 13;
    pts.push(`${(i * step).toFixed(1)},${y.toFixed(1)}`);
  });
  line.setAttribute('points', pts.join(' '));
}

function redrawSparks(id: string): void {
  const buf = sparks.get(id);
  if (!buf) return;
  document.querySelectorAll<HTMLElement>(`[data-ward="${id}"]`).forEach((t) => drawSpark(t, buf));
}

async function seedSparks(services: ServiceStatus[]): Promise<void> {
  seeded = true;
  // Host metrics ride status_history as host:* rows, so they seed the same way.
  const ids = [...services.filter((s) => s.kind === 'http' || s.kind === 'tcp').map((s) => s.id), ...HOST_SERVICE_IDS];
  for (const id of ids) {
    try {
      const res = await fetch(`/api/status/history?service=${encodeURIComponent(id)}&hours=1`);
      if (!res.ok) continue;
      const rows = (await res.json()) as { ms: number | null }[];
      const buf = rows.slice(-SPARK_SAMPLES).map((r) => r.ms);
      const live = sparks.get(id) ?? [];
      sparks.set(id, [...buf, ...live].slice(-SPARK_SAMPLES));
      redrawSparks(id);
    } catch {
      return; // seeding is decoration; stop on first network hiccup
    }
  }
}

// ------------------------------------------------------------------ wards

function statusWord(ok: boolean | null): string {
  return ok === true ? 'up' : ok === false ? 'down' : 'unknown';
}

/** Host metrics as members of a Services ward, synthesized on the client
 *  from snap.host: the value is a percent, `ok` flips at the banner's
 *  thresholds (lib/status.ts alerts: disk ≥90, mem ≥92, load > 2×cores). */
const HOST_ROWS: Record<string, [label: string, read: (h: Snapshot['host']) => number, warn: number]> = {
  'host:cpu': ['Load', (h) => ((h.load?.[0] ?? 0) / h.cores) * 100, 200], // the number status_history stores as host:cpu
  'host:mem': ['Memory', (h) => h.mem.usedPct, 92],
  'host:disk': ['Disk', (h) => h.disk.usedPct, 90],
};
function hostRow(id: string, snap: Snapshot): ServiceStatus | undefined {
  const r = HOST_ROWS[id];
  if (!r) return;
  const pct = Math.round(r[1](snap.host));
  const detail = id === 'host:disk' ? `${snap.host.disk.freeGb} GB free` : id === 'host:cpu' ? `load ${snap.host.load?.[0] ?? '—'} · ${snap.host.cores} cores` : '';
  return { id, label: HOST_LABELS[id] ?? r[0], group: 'host', kind: 'host', ok: pct < r[2], latencyMs: pct, unit: '%', detail, since: null };
}

/** The pill: up/down/unknown for a service; a host row reads ok/high and
 *  borrows the degraded colour for high. */
function pillOf(s: ServiceStatus): { status: string; text: string } {
  if (s.kind === 'host') return s.ok ? { status: 'up', text: 'ok' } : { status: 'degraded', text: 'high' };
  const w = statusWord(s.ok);
  return { status: w, text: w };
}

/** Flash on an up/down transition, and on a pm2 restart (a crash loop pm2
 *  still reports as online); previous state lives on the element itself. */
function flashFlip(node: HTMLElement, s: ServiceStatus): void {
  const prev = node.dataset.ok;
  const nowWord = statusWord(s.ok);
  if (prev !== undefined && prev !== nowWord && s.ok !== null) node.dataset.flash = s.ok ? 'up' : 'down';
  node.dataset.ok = nowWord;
  if (s.restarts !== undefined) {
    const seen = node.dataset.restarts;
    if (seen !== undefined && s.restarts > Number(seen)) node.dataset.flash = 'down';
    node.dataset.restarts = String(s.restarts);
  }
  if (node.dataset.flash) node.addEventListener('animationend', () => delete node.dataset.flash, { once: true });
}

function makeWard(s: ServiceStatus, bare = false): HTMLElement {
  const ward = el('div', bare ? 'ward ward-bare' : 'ward');
  ward.dataset.ward = s.id;

  // Bare wards live inside a single-service ward whose header already
  // names the service — no monogram/label row, no second border.
  if (!bare) {
    const head = el('div', 'flex items-center gap-2');
    head.append(el('span', 'ward-mono', s.label.charAt(0).toUpperCase()));
    head.append(el('span', 'min-w-0 flex-1 truncate text-xs font-medium', s.label));
    ward.append(head);
  }

  const row = el('div', 'flex items-center justify-between gap-2');
  const pill = el('span', 'pill');
  pill.dataset.role = 'pill';
  const lat = el('span', 'text-xs text-ink-muted tabular-nums');
  lat.dataset.role = 'lat';
  row.append(pill, lat);
  ward.append(row);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 60 16');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'polyline'));
  ward.append(svg);

  const detail = el('div', 'truncate text-[10px] text-ink-faint');
  detail.dataset.role = 'detail';
  detail.title = '';
  ward.append(detail);
  return ward;
}

/** Create-or-update one service ward inside a container grid. */
function renderServiceInto(container: HTMLElement, s: ServiceStatus, bare = false): void {
  let ward = container.querySelector<HTMLElement>(`[data-ward="${s.id}"]`);
  if (!ward) {
    ward = makeWard(s, bare);
    container.append(ward);
  }
  const pill = ward.querySelector<HTMLElement>('[data-role="pill"]')!;
  const p = pillOf(s);
  pill.dataset.status = p.status;
  pill.textContent = p.text;
  // The lat slot is empty for pm2 kinds — it shows memory and cpu there,
  // red from 80% of the process's own max_memory_restart.
  const lat = ward.querySelector<HTMLElement>('[data-role="lat"]')!;
  lat.textContent = s.latencyMs !== null ? `${s.latencyMs}${s.unit ?? ' ms'}` : s.memMb !== undefined ? `${s.memMb} MB${s.limitMb ? `/${s.limitMb}` : ''} · ${s.cpu ?? 0}%` : '';
  lat.classList.toggle('text-err', !!s.limitMb && (s.memMb ?? 0) >= s.limitMb * 0.8);
  const detail = ward.querySelector<HTMLElement>('[data-role="detail"]')!;
  detail.textContent = s.detail + (s.since ? ` · since ${hm(s.since)}` : '');
  detail.title = s.detail;

  if (s.latencyMs !== null) drawSpark(ward, sparks.get(s.id) ?? []);
  flashFlip(ward, s);
}

/** The ward body's root, created on first use (replaces the skeleton) and
 *  rebuilt when the view class changes (a config edit clears the body first). */
function bodyRoot(instanceId: string, cls: string): HTMLElement | null {
  const b = body(instanceId);
  if (!b) return null;
  let root = b.querySelector<HTMLElement>('[data-root]');
  if (!root || root.className !== cls) {
    b.textContent = '';
    root = el('div', cls);
    root.dataset.root = '';
    b.append(root);
  }
  return root;
}

// ------------------------------------------------------- ward renderers

/** A Services ward's members: a group's targets, or the listed ids — real
 *  services from the snapshot, host:* rows synthesized here. */
function membersOf(w: WardInstance, snap: Snapshot): ServiceStatus[] {
  const cfg = w.config ?? {};
  if (Array.isArray(cfg.services)) {
    const byId = new Map(snap.services.map((s) => [s.id, s]));
    return (cfg.services as string[]).map((id) => byId.get(id) ?? hostRow(id, snap)).filter((s): s is ServiceStatus => !!s);
  }
  return typeof cfg.group === 'string' ? snap.services.filter((s) => s.group === cfg.group) : snap.services;
}

/** The dots wall: one column per group, members in TARGETS order, a dot each. */
function renderDots(w: WardInstance, members: ServiceStatus[], cols: number): void {
  const root = bodyRoot(w.i, 'dots');
  if (!root) return;
  const order = new Map(TARGETS.map((t, i) => [t.id, i]));
  for (const g of [...GROUPS, 'host'] as string[]) {
    const ms = members.filter((s) => s.group === g).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
    let col = root.querySelector<HTMLElement>(`[data-col="${g}"]`);
    if (!ms.length) {
      col?.remove();
      continue;
    }
    if (!col) {
      col = el('div', 'dots-col');
      col.dataset.col = g;
      col.append(el('div', 'dots-cap'), el('div', 'dots-row'));
      root.append(col);
    }
    const cap = col.querySelector<HTMLElement>('.dots-cap')!;
    cap.hidden = cols < 2;
    cap.textContent = `${groupTitle(g)} ${ms.filter((s) => s.ok).length}/${ms.length}`;
    const row = col.querySelector<HTMLElement>('.dots-row')!;
    for (const s of ms) {
      let dot = row.querySelector<HTMLElement>(`[data-ward="${s.id}"]`);
      if (!dot) {
        dot = el('span', 'dot');
        dot.dataset.ward = s.id;
        row.append(dot);
      }
      dot.title = `${s.label} · ${pillOf(s).text}${s.detail ? ` · ${s.detail}` : ''}${s.since ? ` · since ${hm(s.since)}` : ''}`;
      flashFlip(dot, s);
    }
  }
}

/** The deploy stamp on a ward that shows host rows: which build is running,
 *  since when, and its RSS. It rides the card header's status slot (free on a
 *  Services ward; groups and agent wards use it for their own counts), so it
 *  never competes with the cells for a one-row body. */
function buildLine(b: HTMLElement, build: NonNullable<Snapshot['build']>): void {
  const line = b.closest('[data-wd]')?.querySelector<HTMLElement>(':scope > header .wd-status');
  if (!line) return;
  const { stamp, bootedAt, node, rssMb } = build;
  const dirty = stamp.endsWith('-dirty');
  line.title = `node ${node} · booted ${new Date(bootedAt).toLocaleString()}`;
  line.textContent = `${dirty ? stamp.slice(0, -6) : stamp} · up ${ago(Date.now() - Date.parse(bootedAt))} · ${rssMb} MB`;
  if (dirty) line.append(' · ', el('span', 'text-err font-semibold', 'dirty'));
}

/** THE status ward: a group or a custom set (host rows allowed) as a ward
 *  grid — compact on one-row wards, bare when there is one member — or a
 *  dots wall. */
function renderServiceGroupWard(w: WardInstance, snap: Snapshot): void {
  const b = body(w.i);
  if (!b) return;
  const cfg = w.config ?? {};
  const members = membersOf(w, snap);
  const [cols, rows] = sizeParts(w.size);
  if (cfg.view === 'dots') renderDots(w, members, cols);
  else if (members.length === 1) {
    if (!b.querySelector('[data-ward]')) b.textContent = '';
    renderServiceInto(b, members[0]!, true);
  } else {
    const grid = bodyRoot(w.i, rows === 1 ? 'ward-grid ward-grid-compact' : 'ward-grid');
    if (!grid) return;
    for (const s of members) renderServiceInto(grid, s);
  }
  if (snap.build && members.some((s) => s.kind === 'host')) buildLine(b, snap.build);
}

// ------------------------------------------------------------- incidents

interface IncidentSpan {
  service: string;
  down: string;
  up: string | null;
}
const label = (id: string): string | undefined => TARGETS.find((t) => t.id === id)?.label;
/** The last good 24h list — a failed fetch keeps rendering it. */
let spans: IncidentSpan[] | null = null;
const dur = (ms: number) => ago(Math.max(0, ms));

/** What went down and came back: the pill, then live transitions from the
 *  snapshot (1 column = the latest one; wider = a list) or, on a tall ward,
 *  the 24h spans from status_history. Ages tick because a snapshot lands
 *  every minute and the ward repaints on each. */
async function renderIncidents(w: WardInstance, snap: Snapshot): Promise<void> {
  const res = await getJson('/api/status/incidents').catch(() => null);
  if (res?.status === 200 && Array.isArray(res.data?.spans)) spans = res.data.spans as IncidentSpan[];
  const b = body(w.i);
  if (!b) return;
  const now = Date.parse(snap.at);
  const [cols, rows] = sizeParts(w.size);
  // Rows whose since is the boot tick carry no information — drop them, say so once.
  const live = snap.services.filter((s) => s.since && s.since !== snap.baselineAt).sort((a, c) => c.since!.localeCompare(a.since!));
  const down = snap.services.filter((s) => s.ok === false).length;
  const open = spans?.some((s) => s.up === null) ?? false;
  b.textContent = '';
  const wrap = el('div', 'flex h-full flex-col gap-1 text-xs');
  const pill = el('span', 'pill self-start');
  pill.dataset.status = down || open ? 'down' : spans?.length ? 'degraded' : 'up';
  pill.textContent = down ? `${down} down` : spans?.length ? `${spans.length} incident${spans.length > 1 ? 's' : ''}` : 'all up';
  wrap.append(pill);
  if (cols === 1) {
    const total = (spans ?? []).reduce((n, s) => n + (Date.parse(s.up ?? snap.at) - Date.parse(s.down)), 0);
    wrap.append(el('div', 'truncate text-ink-muted', spans ? (spans.length ? `${dur(total)} down · 24h` : 'nothing moved · 24h') : live[0] ? `changed ${ago(now - Date.parse(live[0].since!))} ago` : `steady since deploy · ${ago(now - Date.parse(snap.baselineAt ?? snap.at))}`));
  } else if (rows >= 2 && spans) {
    for (const s of spans.slice(0, rows * 4)) {
      const r = el('div', 'flex justify-between gap-2');
      r.append(el('span', `truncate${s.up ? '' : ' text-err'}`, label(s.service) ?? s.service));
      r.append(el('span', 'shrink-0 tabular-nums text-ink-muted', `${hm(s.down)} → ${s.up ? hm(s.up) : 'now'} · ${dur(Date.parse(s.up ?? snap.at) - Date.parse(s.down))}`));
      wrap.append(r);
    }
    if (!spans.length) wrap.append(el('div', 'text-ink-faint', 'nothing moved in 24h'));
  } else {
    for (const s of live.slice(0, rows * 3)) {
      const r = el('div', 'flex justify-between gap-2');
      r.append(el('span', `truncate ${s.ok === false ? 'text-err' : ''}`, `${s.ok ? '↑' : '↓'} ${s.label}`));
      r.append(el('span', 'shrink-0 tabular-nums text-ink-muted', `${ago(now - Date.parse(s.since!))} · ${s.detail}`));
      wrap.append(r);
    }
    if (!live.length) wrap.append(el('div', 'text-ink-faint', `nothing changed since deploy (${ago(now - Date.parse(snap.baselineAt ?? snap.at))})`));
  }
  b.append(wrap);
}

RENDERERS.incidents = { render: (w) => wardSnapshots(w, (snap) => void renderIncidents(w, snap)) };
RENDERERS['service-group'] = { render: (w) => wardSnapshots(w, (snap) => renderServiceGroupWard(w, snap)) };

// ------------------------------------------------------------- page level

/** Page-level alerts. Host alerts (disk, load) are about the box this whole
 *  dashboard runs on, so they always show; the services-down line is scoped
 *  by the user's `alerts` preference, stamped on #alerts by the dash page:
 *    visible (default) — only services a ward on this dashboard shows
 *    all               — every monitored service
 *    off               — no banner at all
 *  Anything unrecognised reads as 'visible'. */
function renderAlerts(snap: Snapshot): void {
  const box = document.getElementById('alerts');
  if (!box) return;
  box.textContent = '';
  const mode = box.dataset.mode;
  if (mode === 'off') return;

  const lines = [...snap.alerts];
  const down = snap.services.filter((s) => s.ok === false);
  // Nothing down, or mode 'all' — no need to read the layout at all.
  let shown = down;
  if (down.length && mode !== 'all') {
    const ids = shownServiceIds(readLayout());
    shown = down.filter((s) => ids.has(s.id));
  }
  if (shown.length) lines.push(`${shown.length} service${shown.length > 1 ? 's' : ''} down`);

  for (const a of lines) box.append(el('div', 'banner banner-warn', a));
}

function updateStatusDots(snap: Snapshot): void {
  const dots = document.querySelectorAll<HTMLElement>('[data-svc]');
  if (dots.length === 0) return;
  const byId = new Map(snap.services.map((s) => [s.id, s.ok]));
  dots.forEach((dot) => {
    const ok = byId.get(dot.dataset.svc!);
    dot.classList.remove('bg-ok', 'bg-err', 'bg-ink-faint');
    dot.classList.add(ok === true ? 'bg-ok' : ok === false ? 'bg-err' : 'bg-ink-faint');
  });
}

let bootSeen: string | undefined;
let bootSeenAt = 0;

function apply(snap: Snapshot): void {
  // The server restarted (deploy) since this page loaded — the bundle running
  // here is stale. Reload once to pick up the new code. The 15s floor stops
  // reload loops when dev-server HMR churns module instances (and their
  // boot ids) faster than pages can settle.
  if (snap.bootId) {
    if (bootSeen && bootSeen !== snap.bootId && Date.now() - bootSeenAt > 15_000) {
      location.reload();
      return;
    }
    if (!bootSeen) {
      bootSeen = snap.bootId;
      bootSeenAt = Date.now();
    }
  }
  latest = snap;
  // Latency samples accrue once per snapshot per service (wards just draw);
  // the host rows' percents ride the same buffers.
  for (const s of snap.services) if (s.latencyMs !== null) pushSample(s.id, s.latencyMs);
  for (const id of HOST_SERVICE_IDS) pushSample(id, hostRow(id, snap)!.latencyMs);
  renderAlerts(snap);
  updateStatusDots(snap);
  for (const fn of [...listeners]) {
    try {
      fn(snap);
    } catch {}
  }
  document.querySelectorAll('.ward').forEach((t) => (t as HTMLElement).removeAttribute('data-stale'));
  if (!seeded) requestIdleCallback ? requestIdleCallback(() => void seedSparks(snap.services)) : void seedSparks(snap.services);
}

export function bootStatus(): void {
  let lastMessage = Date.now();
  const banner = document.getElementById('sse-banner');

  const markStale = () => {
    banner?.classList.remove('hidden');
    document.querySelectorAll('.ward').forEach((t) => ((t as HTMLElement).dataset.stale = '1'));
  };

  const connect = () => {
    const es = new LiveEventSource('/api/status/stream');
    es.addEventListener('status', (ev) => {
      lastMessage = Date.now();
      banner?.classList.add('hidden');
      try {
        apply(JSON.parse((ev as MessageEvent).data));
      } catch {}
    });
    es.onerror = () => {
      // EventSource retries on its own; if it gives up entirely, rebuild it.
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5_000);
    };
  };
  connect();

  setInterval(() => {
    if (Date.now() - lastMessage > 90_000) markStale();
  }, 10_000);

  // First paint from the plain endpoint so the grid isn't empty while the
  // stream handshakes (or before the engine's first tick completes).
  fetch('/api/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((snap) => snap && apply(snap))
    .catch(() => {});
}
