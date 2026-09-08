// Ward data plumbing: one jittered poll helper and the renderer registry.
// All DOM built via createElement/textContent — mail subjects and Notion
// titles are hostile input. (Mail — the inbox wards, the reader and compose —
// lives in mail.ts; the header's Notion search in notion-search.ts.)
//
// Extension point: a new ward type = one CATALOG entry (src/lib/wards.ts)
// + one RENDERERS entry here (or registered from another module, like
// status.ts and charts.ts do).

import { CATALOG, DAY_END_H, biggestGap, fxOf, nextUp, rowsOf, sizeParts, type CalEventLite, type WardInstance } from '../../lib/wards.ts';
import { ago, el, getJson, hm, isHttpUrl } from './dom.ts';
import { currentPage, onPage, pageOfCard, readPages } from './pages.ts';
import { WMO_ICON } from '../../lib/icon-names.ts';
import { icon } from './icon.ts';
import { SCENES, sceneDefaults, type SceneId } from '../../lib/theme.ts';
import type { BgHandle } from './bg-scene.ts';

type LinkName = 'google' | 'microsoft' | 'notion' | 'zoho' | 'mailbox' | 'icloud';

/** How a Connect chip names each provider, and where it sends you. The generic
 *  mailbox and iCloud have no OAuth to redirect through — their forms live on /account. */
const LINK_UI: Record<LinkName, { label: string; href: string }> = {
  google: { label: 'Google', href: '/api/connect/google' },
  microsoft: { label: 'Microsoft', href: '/api/connect/microsoft' },
  notion: { label: 'Notion', href: '/api/connect/notion' },
  zoho: { label: 'Zoho', href: '/api/connect/zoho' },
  mailbox: { label: 'a mailbox', href: '/account#accounts' },
  icloud: { label: 'iCloud', href: '/account#icloud' },
};

interface Me {
  links: Record<LinkName, string | boolean>;
}

// The shared helpers live in dom.ts; re-exported so a renderer module only needs this import.
export { ago, el, getJson, hm, isHttpUrl };

export function body(id: string): HTMLElement | null {
  return document.querySelector(`[data-wd="${id}"] [data-body]`);
}

export function note(id: string, text: string): void {
  const b = body(id);
  if (!b) return;
  b.textContent = '';
  b.append(el('p', 'wd-note text-xs text-ink-faint', text));
}

function connectChip(id: string, provider: LinkName): void {
  const b = body(id);
  if (!b) return;
  b.textContent = '';
  const a = el('a', 'wd-note btn text-xs', `Connect ${LINK_UI[provider].label}`);
  a.setAttribute('href', LINK_UI[provider].href);
  b.append(a);
}

/** Polls fn now and every ms±10%, paused while the tab is hidden or `skip()`
 *  says the ward is off stage (another page); a tick it skipped is made up as
 *  soon as the tab or the page comes back. Returns a stop. */
export function poll(fn: () => void | Promise<void>, ms: number, skip: () => boolean = () => false): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let missed = false;
  const loop = () => {
    if (stopped) return;
    if (document.hidden || skip()) missed = true;
    else {
      missed = false;
      void fn();
    }
    timer = setTimeout(loop, ms * (0.9 + Math.random() * 0.2));
  };
  loop();
  const wake = () => {
    if (missed && !document.hidden && !skip() && !stopped) {
      clearTimeout(timer);
      loop();
    }
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('fd:page', wake);
  // Drop the listeners too: wards now come and go without a page reload, so a
  // stopper that only stops the timer still accumulates one closure per ward.
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('fd:page', wake);
  };
}

/** Shared error handling: 404 not-linked → connect chip, 409 → reconnect chip. */
export function handled(id: string, provider: LinkName, status: number): boolean {
  if (status === 404) {
    connectChip(id, provider);
    return true;
  }
  if (status === 409) {
    const b = body(id);
    if (b) {
      b.textContent = '';
      const a = el('a', 'wd-note btn text-xs', `Reconnect ${LINK_UI[provider].label}`);
      a.setAttribute('href', LINK_UI[provider].href);
      b.append(el('p', 'wd-note text-xs text-warn', 'Connection expired.'), a);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- weather
//
// Config-free: the ward grows with its size. 1x1 = now; Nx1 = now + 3 or 7
// days; Nx2+ = now, the next 24 hours, the week. Everything drawn is already
// in the /api/weather payload.

const RAIN_PCT = 40; // ponytail: constant, not a knob — keeps the ward config-free
const SVG = 'http://www.w3.org/2000/svg';
const hourAt = (t: string) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });

interface Hour {
  t: string;
  tempF: number;
  code: number;
  precipPct: number;
}

function dayCell(d: { date: string; code: number; hiF: number; loF: number }): HTMLElement {
  const day = el('div', 'text-center');
  day.append(el('div', 'text-[10px] text-ink-faint', new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'short' })));
  day.append(icon(WMO_ICON[d.code] ?? 'cloud', 'text-sm'));
  day.append(el('div', 'text-[10px] tabular-nums text-ink-muted', `${Math.round(d.hiF)}/${Math.round(d.loF)}`));
  return day;
}

/** Hour · icon · temperature line · °F · rain% as one sideways-scrolling grid. */
function hourGrid(hours: Hour[]): HTMLElement {
  // shrink-0: a scroll container in a flex column would otherwise shrink to nothing and clip its rows.
  const g = el('div', 'grid shrink-0 overflow-x-auto text-center text-[10px] leading-none');
  g.style.gridTemplateColumns = `repeat(${hours.length}, 2.25rem)`;
  for (const h of hours) g.append(el('div', 'text-ink-faint', hourAt(h.t)));
  for (const h of hours) g.append(icon(WMO_ICON[h.code] ?? 'cloud', 'text-sm justify-self-center'));
  const temps = hours.map((h) => h.tempF);
  const lo = Math.min(...temps);
  const span = Math.max(...temps) - lo || 1; // flat day: no NaN
  const svg = document.createElementNS(SVG, 'svg');
  const line = document.createElementNS(SVG, 'polyline');
  svg.setAttribute('viewBox', `-0.5 0 ${hours.length} 16`); // x=i lands on column i's centre
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'h-3 w-full');
  svg.style.gridColumn = '1 / -1';
  line.setAttribute('points', temps.map((t, i) => `${i},${15 - ((t - lo) / span) * 14}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('vector-effect', 'non-scaling-stroke'); // else the x-stretch fattens the stroke
  line.style.stroke = 'var(--color-accent)';
  svg.append(line);
  g.append(svg);
  for (const h of hours) g.append(el('div', 'tabular-nums', `${Math.round(h.tempF)}°`));
  for (const h of hours) g.append(el('div', 'tabular-nums text-accent-hi', h.precipPct >= RAIN_PCT ? `${h.precipPct}%` : ''));
  return g;
}

async function renderWeather(w: WardInstance): Promise<void> {
  const b = body(w.i);
  if (!b) return;
  const { status, data } = await getJson(`/api/weather?ward=${encodeURIComponent(w.i)}`);
  if (status !== 200 || !data?.current) {
    note(w.i, data?.error === 'no-location' ? 'No place set — configure this ward.' : 'Weather unavailable.');
    return;
  }
  const [cols, rows] = sizeParts(w.size);
  const hourly = (data.hourly ?? []) as Hour[];
  const daily = (data.daily ?? []) as { date: string; code: number; hiF: number; loF: number }[];
  b.textContent = '';
  const wrap = el('div', rows >= 2 ? 'flex h-full flex-col justify-between gap-0.5' : 'h-full');
  const row = el('div', rows === 1 ? 'flex h-full items-center gap-3' : 'flex items-center gap-3');
  row.append(icon(WMO_ICON[data.current.code] ?? 'cloud', 'text-3xl'));
  const now = el('div', 'min-w-0');
  now.append(el('div', 'text-xl leading-tight font-semibold tabular-nums', `${Math.round(data.current.tempF)}°`));
  // The subtitle answers "jacket or umbrella": the first wet hour, else wind and humidity.
  const wet = hourly.find((h) => h.precipPct >= RAIN_PCT);
  const sub = wet
    ? `${WMO_ICON[wet.code] === 'snow' ? 'Snow' : 'Rain'} ${hourAt(wet.t)} · ${wet.precipPct}%`
    : `${data.current.condition} · ${Math.round(data.current.windMph ?? 0)} mph · ${data.current.humidity ?? 0}%`;
  now.append(el('div', 'truncate text-xs text-ink-muted', sub));
  row.append(now);
  if (rows === 1) {
    const days = cols === 1 ? 0 : cols === 2 ? 3 : 7;
    const strip = el('div', 'ml-auto flex shrink-0 gap-3');
    for (const d of daily.slice(0, days)) strip.append(dayCell(d));
    row.append(strip);
  }
  wrap.append(row);
  if (rows >= 2) {
    if (hourly.length) wrap.append(hourGrid(hourly));
    const week = el('div', 'flex justify-between');
    for (const d of daily.slice(0, 7)) week.append(dayCell(d));
    wrap.append(week);
  }
  b.append(wrap);
}

// --------------------------------------------------------------- calendar

/** The merged agenda for a calendar ward, or null once the chip/note that
 *  explains why is on the ward. Shared by the Agenda and Next up wards. */
async function loadAgenda(id: string): Promise<CalEventLite[] | null> {
  const { status, data } = await getJson('/api/calendar?days=5');
  const b = body(id);
  if (!b) return null;
  if (status === 404) {
    // Four possible sources, none set up — the account page is where any of them is connected.
    b.textContent = '';
    const a = el('a', 'wd-note btn text-xs', 'Connect a calendar');
    a.setAttribute('href', '/account#accounts');
    b.append(a);
    return null;
  }
  // A 409 names the source whose grant died; the chip sends you to reconnect that one.
  if (handled(id, (data?.provider as LinkName) in LINK_UI ? (data.provider as LinkName) : 'google', status)) return null;
  if (status !== 200) {
    note(id, 'Calendar unavailable.');
    return null;
  }
  return (data?.events ?? []) as CalEventLite[];
}

async function renderCalendar(id: string, rows: number): Promise<void> {
  const events = await loadAgenda(id);
  const b = body(id);
  if (!events || !b) return;
  b.textContent = '';
  if (events.length === 0) {
    note(id, 'Nothing scheduled.');
    return;
  }
  // The free-time line: the biggest unbooked stretch left before DAY_END_H.
  // "Free until" is preferred over "Free now–" so it does not drift while
  // you are inside the gap.
  const now = Date.now();
  const dayEnd = new Date(now).setHours(DAY_END_H, 0, 0, 0);
  const gap = now < dayEnd ? biggestGap(events, now, dayEnd) : null;
  if (gap) {
    const min = Math.round((gap.to - gap.from) / 60_000);
    const dur = min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}` : `${min}m`;
    b.append(
      el(
        'div',
        'mb-1 text-xs tabular-nums text-ink-muted',
        min < 15 ? `Booked until ${hm(dayEnd)}` : gap.from - now < 60_000 ? `Free until ${hm(gap.to)} · ${dur}` : `Free ${hm(gap.from)}–${hm(gap.to)} · ${dur}`
      )
    );
  }
  let lastDay = '';
  const list = el('div');
  for (const ev of events.slice(0, Math.min(50, rows * 6)) as (CalEventLite & { calendar?: string })[]) {
    const day = new Date(ev.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    if (day !== lastDay) {
      list.append(el('div', 'section-title mt-2 first:mt-0', day));
      lastDay = day;
    }
    const row = el('div', 'flex items-baseline gap-2 py-0.5');
    row.append(el('span', 'shrink-0 text-[10px] tabular-nums text-ink-faint', ev.allDay ? 'all day' : hm(ev.start)));
    const title = el('span', 'truncate text-xs', ev.title || '(untitled)');
    // Google is the unmarked default; everything else says which calendar it came from.
    if (ev.source !== 'google') title.append(el('span', 'ml-1 text-[9px] text-ink-faint', `· ${ev.calendar || ev.source}`));
    row.append(title);
    list.append(row);
  }
  b.append(list);
}

// ---------------------------------------------------------------- next up

/** "23m" · "1h 05m" · "now"; beyond a day the weekday and time. */
function lead(ms: number): string {
  if (ms < 60_000) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

async function renderNextUp(w: WardInstance): Promise<void> {
  const events = await loadAgenda(w.i);
  const b = body(w.i);
  if (!events || !b) return;
  const [cols, rows] = sizeParts(w.size);
  const first = nextUp(events, Date.now());
  if (!first.now && !first.next.length) {
    note(w.i, 'Nothing scheduled.');
    return;
  }
  b.textContent = '';
  const wrap = el('div', 'flex h-full flex-col justify-center gap-0.5');
  const big = el('div', 'text-2xl leading-tight font-semibold tabular-nums');
  const title = el('div', 'truncate text-xs');
  wrap.append(big, title);
  const meta = cols >= 2 ? el('div', 'truncate text-[10px] text-ink-faint') : null;
  const join = cols >= 2 ? el('a', 'btn min-h-0 self-start px-2 py-0.5 text-xs', 'Join') : null;
  if (meta) wrap.append(meta);
  if (join) {
    join.target = '_blank';
    join.rel = 'noreferrer';
    wrap.append(join);
  }
  const following = rows >= 2 ? el('div', 'mt-1 flex flex-col gap-0.5 text-[10px] text-ink-faint') : null;
  if (following) wrap.append(following);
  b.append(wrap);

  // Built once; the tick rewrites text only, so nothing reflows.
  const paint = () => {
    const now = Date.now();
    const { now: cur, next } = nextUp(events, now);
    const focus = cur ?? next[0];
    if (!focus) {
      big.textContent = 'free';
      title.textContent = 'Nothing else today.';
      big.className = 'text-2xl leading-tight font-semibold tabular-nums';
      if (meta) meta.textContent = '';
      if (join) join.hidden = true;
      if (following) following.textContent = '';
      return;
    }
    const ms = cur ? Date.parse(cur.end) - now : Date.parse(focus.start) - now;
    big.textContent = cur
      ? `ends ${lead(ms)}`
      : ms < 86_400_000
        ? `in ${lead(ms)}`
        : new Date(focus.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    big.classList.toggle('text-warn', !cur && ms < 10 * 60_000 && ms >= 2 * 60_000);
    big.classList.toggle('text-err', !cur && ms < 2 * 60_000);
    title.textContent = focus.title || '(untitled)';
    if (meta) {
      meta.textContent = `${hm(focus.start)}–${hm(focus.end)}${focus.location ? ` · ${focus.location}` : ''}${focus.source !== 'google' ? ` · ${focus.source}` : ''}`;
    }
    if (join) {
      join.hidden = !isHttpUrl(focus.joinUrl);
      if (!join.hidden) join.href = focus.joinUrl!;
    }
    if (following) {
      following.textContent = '';
      for (const e of (cur ? next : next.slice(1)).slice(0, 3)) following.append(el('div', 'truncate', `${hm(e.start)} · ${e.title || '(untitled)'}`));
    }
  };
  paint();
  const tick = setInterval(() => {
    if (!big.isConnected) return clearInterval(tick); // repainted or removed
    if (!document.hidden) paint();
  }, 30_000);
}

// ----------------------------------------------------------------- notion

async function renderNotionRecent(id: string, rows: number): Promise<void> {
  const { status, data } = await getJson('/api/notion/recent');
  if (handled(id, 'notion', status)) return;
  const b = body(id);
  if (!b) return;
  if (status !== 200) {
    note(id, 'Notion unavailable.');
    return;
  }
  b.textContent = '';
  const pages = (data?.pages ?? []) as any[];
  if (pages.length === 0) {
    note(id, 'No recent pages.');
    return;
  }
  const list = el('ul');
  for (const p of pages.slice(0, rows * 4)) {
    const li = el('li', 'truncate py-0.5');
    const a = el('a', 'text-xs hover:underline', `${p.icon ? p.icon + ' ' : ''}${p.title || '(untitled)'}`);
    a.setAttribute('href', p.url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
    li.append(a);
    list.append(li);
  }
  b.append(list);
}

// ------------------------------------------------- applink / embed wards

interface AppLink {
  url: string;
  icon?: string;
  statusService?: string;
}

/** One launcher cell. The status dot carries [data-svc], which
 *  updateStatusDots (status.ts) repaints from every snapshot. */
function linkCell(l: AppLink, big: boolean): HTMLElement {
  const a = el('a', `flex flex-col items-center justify-center gap-1 rounded p-1 text-center hover:bg-surface-2/60${big ? ' h-full' : ''}`);
  a.href = l.url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  const row = el('div', 'flex items-center gap-1');
  row.append(icon(l.icon ?? 'link', big ? 'text-3xl' : 'text-2xl'));
  if (l.statusService) {
    const dot = el('span', 'inline-block h-2 w-2 rounded-full bg-ink-faint');
    dot.dataset.svc = l.statusService;
    row.append(dot);
  }
  a.append(row, el('div', 'w-full truncate text-[10px] text-ink-muted', new URL(l.url).host));
  return a;
}

function renderApplink(w: WardInstance): void {
  const b = body(w.i);
  if (!b) return;
  const links = ((Array.isArray(w.config?.links) ? w.config.links : []) as AppLink[]).filter((l) => isHttpUrl(l?.url));
  if (!links.length) {
    note(w.i, 'Invalid link.');
    return;
  }
  b.textContent = '';
  if (links.length === 1) {
    b.append(linkCell(links[0]!, true));
    b.classList.add('flex');
    return;
  }
  // auto-fill does the per-size cap: 1x1 two across, 2x1 four, 2x2 eight, 3x2 twelve.
  const grid = el('div', 'grid grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-1');
  for (const l of links) grid.append(linkCell(l, false));
  b.append(grid);
}

function renderEmbed(w: WardInstance): void {
  const b = body(w.i);
  if (!b) return;
  const url = w.config?.url;
  if (!isHttpUrl(url)) {
    note(w.i, 'Invalid URL.');
    return;
  }
  b.textContent = '';
  const frame = document.createElement('iframe');
  frame.className = 'h-full w-full rounded border-0';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'lazy');
  frame.src = url;
  b.append(frame);
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
}

// --------------------------------------------------------- spacer / group

/** Live scene canvases by ward id — destroyed on repaint and on unboot: a
 *  canvas left rendering into a detached body is a leaked WebGL context. */
const sceneWards = new Map<string, BgHandle>();
/** Every live scene ward is its own WebGL context, and browsers keep about
 *  sixteen per page before silently dropping the oldest — the page background
 *  and the header banner are two of them. Past this many, a scene ward shows
 *  a still of its preset instead (scene-thumbs.ts: one throwaway context, no
 *  three), so nothing on the board ever goes blank. */
const MAX_LIVE_SCENES = 8;
/** Slots claimed the moment a ward decides to go live — the handle itself
 *  only lands after the async import, and a whole board boots before that. */
const liveScenes = new Set<string>();

function stopScene(id: string): void {
  sceneWards.get(id)?.destroy();
  sceneWards.delete(id);
  liveScenes.delete(id);
}

/** A spacer: no data, only a look. The effect rides `data-fx` on
 *  the card (frost.css paints none/glass/magnify/aurora); `scene` mounts the
 *  background renderer on a canvas in the body — same shaders, sized to the
 *  ward by its own ResizeObserver. */
function renderFx(w: WardInstance): void {
  const b = body(w.i);
  if (!b) return;
  stopScene(w.i);
  const fx = fxOf(w) ?? 'none';
  const card = b.closest<HTMLElement>('[data-wd]');
  if (card) card.dataset.fx = fx;
  b.textContent = '';
  b.classList.remove('overflow-y-auto');
  // The rule: the knob on, or a title to show.
  if (w.config?.rule || w.title) {
    const rule = el('div', 'wd-sep');
    if (w.title) rule.append(el('span', undefined, w.title));
    b.append(rule);
  }
  if (fx !== 'scene') return;
  const scene = (typeof w.config?.scene === 'string' && w.config.scene in SCENES ? w.config.scene : 'aurora') as SceneId;
  if (liveScenes.size >= MAX_LIVE_SCENES) {
    const img = document.createElement('img');
    img.className = 'wd-fx-canvas';
    img.alt = '';
    b.prepend(img);
    // Half the card's pixels, like a live preset at res 0.5; a card that is
    // display:none right now (inside a folded group) gets a 2x1-shaped default.
    const r = card?.getBoundingClientRect();
    const sw = r && r.width > 8 ? Math.round(r.width / 2) : 400;
    const sh = r && r.height > 8 ? Math.round(r.height / 2) : 100;
    void import('./scene-thumbs.ts')
      .then((m) => {
        if (!img.isConnected) return;
        img.onload = () => img.classList.add('live');
        img.src = m.sceneStill(scene, sw, sh);
      })
      .catch(() => {});
    return;
  }
  liveScenes.add(w.i);
  const canvas = document.createElement('canvas');
  canvas.className = 'wd-fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  b.prepend(canvas);
  void import('./bg-scene.ts')
    .then((m) => {
      if (!canvas.isConnected) return;
      const h = m.createBgScene(canvas, sceneDefaults(scene));
      if (h) sceneWards.set(w.i, h);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- registry

export interface Renderer {
  /** Present → jittered poll; absent → render once (capture, wards, embeds). */
  intervalMs?: number;
  render: (w: WardInstance) => void | Promise<void>;
  /** Release what render() holds outside the DOM (a WebGL context) when the
   *  ward leaves the layout. */
  stop?: (id: string) => void;
}

export const RENDERERS: Record<string, Renderer> = {
  weather: { intervalMs: 15 * 60_000, render: renderWeather },
  // rowsOf(w): the item cap scales with the ward's height. No `link`: any of
  // four sources powers it, and the route's 404 draws the connect chip.
  calendar: { intervalMs: 5 * 60_000, render: (w) => renderCalendar(w.i, rowsOf(w)) },
  // The poll refetches events; a 30 s tick inside moves the countdown.
  'next-up': { intervalMs: 5 * 60_000, render: renderNextUp },
  'notion-recent': { intervalMs: 5 * 60_000, render: (w) => renderNotionRecent(w.i, rowsOf(w)) },
  applink: { render: renderApplink },
  embed: { render: renderEmbed },
  spacer: { render: renderFx, stop: stopScene },
  // A group's body IS the nested grid — Ward.astro and edit.ts build it,
  // and nothing here may ever wipe it (see rerenderInstance).
  container: { render: () => {} },
  // mail from mail.ts, service-group / incidents from status.ts, chart from
  // charts.ts, the notion page wards (capture included) from notion.ts, note from note.ts.
};

// ------------------------------------------------------------------- boot

let ME: Me = { links: { google: false, microsoft: false, notion: false, zoho: false, mailbox: false, icloud: false } };
/** Booted instance id -> how to stop it again (a no-op for one-shot renderers). */
const booted = new Map<string, () => void>();

/** This tab's identity, so a layout it saved can be told apart from one another
 *  tab (or the agent) saved — the saver skips animating its own change back. */
export const TAB_ID = Math.random().toString(36).slice(2);

export function readLayout(): WardInstance[] {
  try {
    return JSON.parse(document.getElementById('layout-data')?.textContent ?? '[]') as WardInstance[];
  } catch {
    return [];
  }
}

/** Boot one ward instance (idempotent per instance id). edit.ts uses this
 *  for freshly added wards too. */
export function bootInstance(w: WardInstance): void {
  if (booted.has(w.i)) return;
  booted.set(w.i, () => {});
  const r = RENDERERS[w.type];
  if (!r) {
    note(w.i, 'Unavailable.');
    return;
  }
  // The catalog names the account a type needs; no link → the Connect chip.
  const link = CATALOG[w.type]?.link;
  if (link && !ME.links[link]) {
    connectChip(w.i, link);
    return;
  }
  const stop = r.intervalMs ? poll(() => r.render(w), r.intervalMs, () => pageOfCard(w.i) !== currentPage()) : () => {};
  booted.set(w.i, () => {
    stop();
    RENDERERS[w.type]?.stop?.(w.i);
  });
  if (!r.intervalMs) void r.render(w);
}

/** Stop a ward that left the layout. Its poll would otherwise keep fetching
 *  forever (most renderers hit the network BEFORE checking the card is still
 *  there), and the id would stay booted — so a re-add, or the remove/Undo pair,
 *  silently never starts polling again. */
export function unbootInstance(id: string): void {
  booted.get(id)?.();
  booted.delete(id);
}

/** Immediate re-render after a config change. The instance object identity is
 *  stable (edit.ts mutates it), so poll/subscription closures see the new
 *  config too; this just repaints now instead of next tick. */
export function rerenderInstance(w: WardInstance): void {
  if (w.type === 'container') return; // its body holds live wards, not a paint
  const b = body(w.i);
  if (b) {
    b.textContent = '';
    b.classList.add('overflow-y-auto');
  }
  const r = RENDERERS[w.type];
  if (r) void r.render(w);
}

const idle = (fn: () => void, timeout: number) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 300));

/** Renderers that hold a canvas/GL context: released when their page leaves
 *  the stage, remounted on return. (The browser ward already drops its
 *  stream on its own IntersectionObserver.) */
const CANVAS_TYPES = new Set(['spacer']);

/** The page on stage boots (idempotent); the NEXT tab pre-warms on idle so the
 *  likely swap is warm; every other page is unbooted — never more than two
 *  pages live per tab. The DOM keeps every page's last render regardless. */
function bootStage(): void {
  const layout = readLayout();
  const pages = readPages();
  const cur = currentPage();
  const i = pages.findIndex((p) => p.id === cur);
  const next = pages.length > 1 ? pages[(i + 1) % pages.length]!.id : cur;
  const pg = (w: WardInstance) => pageOfCard(w.i) ?? cur;
  for (const w of layout) {
    const p = pg(w);
    if (p === cur) bootInstance(w);
    // Pollers on a third page stop; event-driven wards (agent, chat, browser)
    // keep their DOM state — a draft in a composer survives a page tour.
    else if (CANVAS_TYPES.has(w.type) || (p !== next && RENDERERS[w.type]?.intervalMs)) unbootInstance(w.i);
  }
  if (next === cur) return;
  idle(() => {
    if (currentPage() !== cur) return; // moved on — that swap's bootStage owns the stage now
    for (const w of layout) if (pg(w) === next && !CANVAS_TYPES.has(w.type)) bootInstance(w);
  }, 4000);
}

export function bootWards(): void {
  fetch('/api/me')
    .then((r) => r.json())
    .then((me: Me) => {
      ME = me;
      onPage(bootStage);
      // Status wards boot immediately elsewhere; data wards can wait a beat.
      idle(bootStage, 2000);
    })
    .catch(() => {});
}
