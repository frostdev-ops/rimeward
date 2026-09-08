import { LiveEventSource } from './live-stream.ts';
// Client half of the logic system: the per-user SSE store (server timer
// state, packet-change notices, client-side acts, run results) and the
// timer / checklist / flow ward renderers. The visual wire editor lives in
// logic-edit.ts and feeds off onRun/ensureStream exported here.
//
// Packet text, notes and Notion titles are hostile input — createElement +
// textContent only, per the house rule in wards.ts.

import { CATALOG, rowsOf, sizeParts, timerSteps, validateLayout, validatePages, wardTitle, type WardInstance, type PageDef } from '../../lib/wards.ts';
import { ACTIONS } from '../../lib/logic.ts';
import { icon } from './icon.ts';
import { RENDERERS, TAB_ID, body, getJson, handled, note, readLayout, rerenderInstance } from './wards.ts';
import { offStage } from './pages.ts';

/** Wards a `refresh` reached while off stage; flushed when their page shows. */
const dirty = new Set<string>();
window.addEventListener('fd:page', () => {
  if (!dirty.size) return;
  const by = new Map(readLayout().map((w) => [w.i, w]));
  for (const id of [...dirty]) {
    if (offStage(id)) continue;
    dirty.delete(id);
    const w = by.get(id);
    if (w) rerenderInstance(w);
  }
});
import { ago, el, postJson, tapToast, typingInto } from './dom.ts';
import { propView } from './notion-view.ts';
import type { PropValue } from '../../lib/notion-props.ts';
import { applyLayout } from './edit.ts';

// ------------------------------------------------------------------ SSE store

export interface TimerState {
  ward: string;
  state: 'idle' | 'running' | 'paused';
  durationMs: number;
  endsAt: number | null;
  remainingMs: number | null;
  /** Routine step index (see lib/timers.ts); 0 on a plain timer. */
  step: number;
}

export interface RunEvent {
  edgeId: string;
  result: 'ok' | 'skipped' | 'error';
  detail: string;
  at: string;
}

const timers = new Map<string, TimerState>();
const timerSubs = new Map<string, Set<() => void>>();
const packetSubs = new Map<string, Set<() => void>>();
/** What the server says about a turn that just landed on an agent ward. */
export interface AgentPing {
  ward: string;
  source?: 'chat' | 'automation' | 'wake' | 'agent';
  /** Short slice of the reply, for the toast. */
  summary?: string;
  /** Server-side policy: headless answers toast unless the rule opted out. */
  toast?: boolean;
}
const agentSubs = new Map<string, Set<(p?: AgentPing) => void>>();
/** One streamed event from a turn in flight on this user's account, mirrored to
 *  every other open client. Same frames the chat POST stream carries, plus
 *  'user' (what started the turn) and 'end' (it died without settling). */
export interface AgentLive {
  ward: string;
  source?: 'chat' | 'automation' | 'wake' | 'agent';
  event: any;
}
const agentLiveSubs = new Map<string, Set<(d?: AgentLive) => void>>();
const runSubs = new Set<(r: RunEvent) => void>();
let es: LiveEventSource | null = null;
const instanceStreams = new Map<string, LiveEventSource>();
const instanceHandlers = new Map<string, (data: any) => void>();
window.addEventListener('fd:instance', (event) => {
  if (!es) return;
  const status = (event as CustomEvent).detail;
  const paths = new Set<string>();
  if (status.ownDevice && status.configured) paths.add('/api/instance/events');
  for (const device of status.devices ?? []) if (device.online && device.id !== status.ownDevice) paths.add(`/runtime/${device.id}/api/logic/stream`);
  for (const [path, stream] of instanceStreams) if (!paths.has(path)) { stream.close(); instanceStreams.delete(path); }
  for (const path of paths) {
    if (instanceStreams.has(path)) continue;
    const stream = new LiveEventSource(path);
    stream.onopen = () => window.dispatchEvent(new CustomEvent('fd:agent-reconnect'));
    instanceStreams.set(path, stream);
    // Only 5xx/network errors auto-retry; a 401/403/404/429 closes the source for good. Forget it so
    // the next instance poll (15 s) opens a fresh one instead of keeping a dead object forever.
    stream.onerror = () => { if (stream.readyState === EventSource.CLOSED && instanceStreams.get(path) === stream) instanceStreams.delete(path); };
    // Dashboard/theme changes arrive through reconciliation, never over an unsaved local edit.
    for (const [name, handle] of instanceHandlers) {
      if (name === 'layout' || name === 'theme') continue;
      stream.addEventListener(name, e => { try { handle(JSON.parse((e as MessageEvent).data)); } catch {} });
    }
  }
});
window.addEventListener('pagehide', () => { for (const stream of instanceStreams.values()) stream.close(); instanceStreams.clear(); });

/** Connect the per-user logic stream once (native EventSource retry handles
 *  reconnects). Renderers and the wire editor call this on boot. */
export function ensureStream(): void {
  if (es) return;
  es = new LiveEventSource('/api/logic/stream');
  es.onopen = () => window.dispatchEvent(new CustomEvent('fd:agent-reconnect'));
  const on = (event: string, fn: (data: any) => void) => {
    instanceHandlers.set(event, fn);
    es!.addEventListener(event, (e) => {
      try {
        fn(JSON.parse((e as MessageEvent).data));
      } catch {}
    });
  };
  on('timer', (t: TimerState) => {
    timers.set(t.ward, t);
    timerSubs.get(t.ward)?.forEach((fn) => fn());
  });
  on('packets', (d: { wards?: string[] }) => {
    for (const ward of d.wards ?? []) packetSubs.get(ward)?.forEach((fn) => fn());
  });
  on('runs', (r: RunEvent) => runSubs.forEach((fn) => fn(r)));
  on('act', (a: { action?: string; params?: Record<string, unknown> }) => {
    if (a.action) CLIENT_ACTS[a.action]?.(a.params ?? {});
  });
  on('agent', (d: AgentPing) => {
    if (d?.ward) agentSubs.get(d.ward)?.forEach((fn) => fn(d));
  });
  on('agent-live', (d: AgentLive) => {
    if (d?.ward) agentLiveSubs.get(d.ward)?.forEach((fn) => fn(d));
  });
  // A layout the agent (or another of this user's tabs) just saved. Animate it
  // in place if we can; the reload is the fallback, not the plan.
  on('layout', (d: { layout?: unknown; pages?: unknown; from?: string }) => {
    if (d?.from && d.from === TAB_ID) return; // our own save, already on screen
    const next = validateLayout(d?.layout);
    const pages = validatePages(d?.pages) ?? undefined;
    pendingLayout = next ? { layout: next, pages } : null;
    if (next && applyLayout(next, reloadHolds, false, pages)) {
      pendingLayout = null;
      pendingLayoutReload = false;
      return;
    }
    pendingLayoutReload = true;
    flushPendingLayout();
  });
  // The agent wrote into a notepad; its ward reloads the document (note.ts).
  on('note', (d: { ward?: string }) => window.dispatchEvent(new CustomEvent('fd:note', { detail: d })));
  // Theme knobs apply straight to <html> — no reload has anything to add. The
  // derivation is imported on demand: changing the theme from the agent is rare
  // and every dashboard would otherwise carry theme.ts for it.
  on('theme', (d: unknown) => {
    void Promise.all([import('../../lib/theme.ts'), import('./theme-live.ts')]).then(([t, live]) =>
      live.applyThemeLive(t.normalizeTheme(d as Record<string, unknown>))
    );
  });
  // A server action changed data behind a linked account (an automation writing
  // to Notion) or behind one ward type (Rime remembered something). Repaint
  // every ward fed by that account — CATALOG's own `link` field is the list,
  // so a new Notion ward type is covered for free — or of that type.
  on('refresh', (d: { link?: string; type?: string }) => {
    const focused = document.activeElement;
    for (const w of readLayout()) {
      const hit = (d?.link && CATALOG[w.type]?.link === d.link) || (d?.type && w.type === d.type);
      if (!hit) continue;
      // Off stage (another page): repaint when it comes back, not now.
      if (offStage(w.i)) {
        dirty.add(w.i);
        continue;
      }
      // Never yank the DOM out from under someone typing — the capture
      // textarea, an inline property editor mid-edit.
      const card = document.querySelector(`[data-wd="${w.i}"]`);
      if (focused && card?.contains(focused)) continue;
      rerenderInstance(w);
    }
  });
}

// ------------------------------------------------------------ layout reloads
//
// Keep the latest pushed layout while a turn or dialog holds a ward. Apply
// it in place when the hold clears; an incompatible change requires an
// explicit reload so other wards and unsaved work remain usable.

/** Wards with a turn running here or on another client. */
export const reloadHolds = new Set<string>();
let pendingLayoutReload = false;
let pendingLayout: { layout: WardInstance[]; pages?: PageDef[] } | null = null;

/** Re-check after a blocker clears — a turn ending, a dialog closing. */
export function flushPendingLayout(): void {
  if (!pendingLayoutReload) return;
  // Still held or still covered: a toast now would be invisible anyway.
  if (reloadHolds.size || document.querySelector('dialog[open]')) return;
  const next = pendingLayout;
  pendingLayout = null;
  pendingLayoutReload = false;
  if (next && applyLayout(next.layout, reloadHolds, false, next.pages)) return;
  // A layout conflict must not silently reload terminals, browsers or unsaved work.
  tapToast('The agent changed your layout — tap to reload', () => location.reload());
}

// Any dialog closing may have been the blocker ('close' doesn't bubble, but
// the capture phase reaches document all the same).
document.addEventListener('close', () => flushPendingLayout(), true);

export function timerState(ward: string): TimerState | undefined {
  return timers.get(ward);
}

type Sub<T> = (payload?: T) => void;

function addSub<T>(map: Map<string, Set<Sub<T>>>, key: string, fn: Sub<T>): () => void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function onRun(fn: (r: RunEvent) => void): () => void {
  runSubs.add(fn);
  return () => runSubs.delete(fn);
}

// Renderers re-run on config changes — keep one live subscription per ward.
const wardUnsubs = new Map<string, () => void>();
function resubscribe<T>(ward: string, map: Map<string, Set<Sub<T>>>, fn: Sub<T>): void {
  wardUnsubs.get(ward)?.();
  wardUnsubs.set(ward, addSub(map, ward, fn));
}

/** Agent wards re-render when a turn lands server-side (headless logic runs
 *  broadcast 'agent' over the stream). One live subscription per ward. */
export function onAgentPing(ward: string, fn: (p?: AgentPing) => void): void {
  resubscribe(ward, agentSubs, fn);
}

/** Live headless-turn events for a ward. Distinct unsub key — a ward holds
 *  this AND its onAgentPing subscription. */
export function onAgentLive(ward: string, fn: (d?: AgentLive) => void): void {
  wardUnsubs.get(`live:${ward}`)?.();
  wardUnsubs.set(`live:${ward}`, addSub(agentLiveSubs, ward, fn));
}

// ---------------------------------------------------------------- client acts

/** Actions the engine can only perform in an open tab, delivered over SSE. */
const CLIENT_ACTS: Record<string, (params: Record<string, unknown>) => void> = {
  'audio.play': (p) => {
    const sound = String(p.sound ?? '');
    if (!['chime', 'alarm', 'ping'].includes(sound)) return;
    const audio = new Audio(`/sounds/${sound}.wav`);
    // Autoplay policy: without a prior gesture the play() rejects — offer a tap.
    audio.play().catch(() => tapToast('Logic fired — tap for the sound', () => void audio.play().catch(() => {})));
  },
  'youtube.play': (p) => {
    const id = String(p.videoId ?? '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    openYoutube(id);
  },
  'notify.flash': (p) => {
    const msg = String(p.text ?? '').slice(0, 60);
    if (!msg) return;
    stopFlash?.();
    const original = document.title;
    let on = false;
    const timer = setInterval(() => {
      document.title = (on = !on) ? `${msg}` : original;
    }, 1200);
    let timeout: ReturnType<typeof setTimeout>;
    const stop = () => {
      // Idempotent AND cancels its own timeout — a stale 60s timer from flash
      // A firing during flash B would otherwise null stopFlash mid-flight and
      // leave B's interval fighting over the title forever.
      clearInterval(timer);
      clearTimeout(timeout);
      document.title = original;
      document.removeEventListener('visibilitychange', onVis);
      if (stopFlash === stop) stopFlash = undefined;
    };
    const onVis = () => {
      if (!document.hidden) stop(); // they looked — message delivered
    };
    stopFlash = stop;
    document.addEventListener('visibilitychange', onVis);
    timeout = setTimeout(stop, 60_000);
    tapToast(`${msg}`, () => {}); // also visible when the tab IS focused
  },
  'speak.say': (p) => {
    const text = String(p.text ?? '').slice(0, 200);
    if (!text || !('speechSynthesis' in window)) return;
    // ponytail: some browsers no-op speech without a prior gesture — silent then.
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  },
};

let stopFlash: (() => void) | undefined;

function openYoutube(id: string): void {
  document.getElementById('yt-overlay')?.remove();
  const wrap = el('div', 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4');
  wrap.id = 'yt-overlay';
  const box = el('div', 'w-full max-w-2xl');
  const frame = document.createElement('iframe');
  frame.className = 'aspect-video w-full rounded-lg border-0';
  frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`;
  frame.allow = 'autoplay; encrypted-media';
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const close = el('button', 'btn mt-2', 'Close') as HTMLButtonElement;
  close.type = 'button';
  close.addEventListener('click', () => wrap.remove());
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) wrap.remove();
  });
  box.append(frame, close);
  wrap.append(box);
  document.body.append(wrap);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('yt-overlay')?.remove();
});

// --------------------------------------------------------------------- timer

const timerTicks = new Map<string, ReturnType<typeof setInterval>>();

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function renderTimer(w: WardInstance): void {
  ensureStream();
  const b = body(w.i);
  if (!b) return;
  b.textContent = '';
  b.classList.add('flex');
  const steps = timerSteps(w.config);
  const rounds = steps.filter((s) => s.label === 'Focus').length;
  const wrap = el('div', 'flex h-full w-full flex-col items-center justify-center gap-1.5');
  const label = el('div', 'text-[10px] uppercase tracking-wide text-ink-faint');
  const time = el('div', 'text-2xl leading-none font-semibold tabular-nums');
  const bar = el('div', 'flex gap-1');
  const mkBtn = (label: string, op: 'start' | 'pause' | 'reset' | 'skip') => {
    const btn = el('button', 'btn min-h-0 px-2 py-1 text-xs', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      void postJson(`/api/timers/${encodeURIComponent(w.i)}`, { op });
    });
    return btn;
  };
  const start = mkBtn('Start', 'start');
  const pause = mkBtn('Pause', 'pause');
  const reset = mkBtn('Reset', 'reset');
  const skip = mkBtn('Skip', 'skip');
  bar.append(start, pause, skip, reset);
  if (steps.length) wrap.append(label);
  wrap.append(time, bar);
  // A tall routine ward lists its steps; the current one is bold.
  const list = steps.length && rowsOf(w) >= 2 ? el('div', 'flex flex-col text-xs') : null;
  const rowsEl = steps.map((s) => el('div', 'text-ink-faint', `${s.label} ${s.min}m`));
  if (list) {
    list.append(...rowsEl);
    wrap.append(list);
  }
  b.append(wrap);

  const paint = () => {
    // Ward removed from the dashboard: stop ticking, drop the subscription.
    if (!time.isConnected) {
      clearInterval(timerTicks.get(w.i));
      timerTicks.delete(w.i);
      wardUnsubs.get(w.i)?.();
      wardUnsubs.delete(w.i);
      return;
    }
    const t = timers.get(w.i);
    const state = t?.state ?? 'idle';
    const step = t?.step ?? 0;
    const cur = steps[step];
    const ms =
      state === 'running'
        ? (t!.endsAt ?? 0) - Date.now()
        : state === 'paused'
          ? (t!.remainingMs ?? 0)
          : (cur ? cur.min * 60 : Number(w.config?.duration) || 300) * 1000; // config, not the SSE snapshot — reconfigure repaints instantly
    time.textContent = fmtMs(ms);
    time.classList.toggle('text-warn', state === 'running' && ms < 10_000);
    start.textContent = state === 'paused' ? 'Resume' : 'Start';
    start.classList.toggle('hidden', state === 'running');
    pause.classList.toggle('hidden', state !== 'running');
    reset.classList.toggle('hidden', state === 'idle');
    skip.classList.toggle('hidden', !steps.length || state === 'idle');
    if (steps.length) {
      // Focus · 2/4: the round is the Focus steps up to and including this one.
      const round = steps.slice(0, step + 1).filter((s) => s.label === 'Focus').length;
      label.textContent = cur ? `${cur.label} · ${round}/${rounds}` : 'Done';
      rowsEl.forEach((r, i) => {
        r.classList.toggle('font-semibold', i === step && state !== 'idle');
        r.classList.toggle('text-ink-faint', !(i === step && state !== 'idle'));
      });
    }
  };
  clearInterval(timerTicks.get(w.i));
  timerTicks.set(
    w.i,
    setInterval(() => {
      // Disconnected node must still reach paint() — that's where cleanup lives.
      if (!time.isConnected || (!document.hidden && timers.get(w.i)?.state === 'running')) paint();
    }, 500)
  );
  resubscribe(w.i, timerSubs, paint);
  paint();
}

// ---------------------------------------------------------------------- flow

async function renderFlow(w: WardInstance): Promise<void> {
  ensureStream();
  const b = body(w.i);
  if (!b) return;
  // Don't yank the input out from under someone mid-thought (60s poll).
  if (typingInto(b)) return;
  const { status, data } = await getJson(`/api/flow?ward=${encodeURIComponent(w.i)}`);
  if (status !== 200) {
    note(w.i, 'Flow unavailable.');
    return;
  }
  if (typingInto(b)) return;
  b.textContent = '';
  const form = el('form', 'mb-1 flex');
  const input = el('input', 'input min-h-0 w-full px-2 py-1 text-xs') as HTMLInputElement;
  input.placeholder = 'New packet… Enter drops it in';
  form.append(input);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    // ponytail: manual packets land on 'inbox'; per-ward channel picker if it matters
    const res = await postJson('/api/flow', { ward: w.i, channel: 'inbox', text });
    input.disabled = false;
    if (!res.ok) {
      input.classList.add('ring-2', 'ring-err/50');
      setTimeout(() => input.classList.remove('ring-2', 'ring-err/50'), 1200);
      input.focus(); // disabled=true blurred it; unfocused text loses the typingInto() guard
      return; // keep the typed text — it didn't land
    }
    input.value = '';
    void renderFlow(w).then(() => (body(w.i)?.querySelector('input') as HTMLInputElement | null)?.focus());
  });
  b.append(form);

  const packets = (data?.packets ?? []) as any[];
  if (packets.length === 0) {
    // Not .wd-note: that class makes the body center EVERYTHING, input included.
    b.append(el('p', 'py-3 text-center text-xs text-ink-faint', 'No packets — type above, or draw a leyline in.'));
    resubscribe(w.i, packetSubs, () => void renderFlow(w));
    return;
  }
  const list = el('ul', 'divide-y divide-line/60');
  for (const p of packets) {
    const li = el('li', 'flex items-center gap-1.5 py-1');
    if (p.status === 'done') li.classList.add('opacity-50');
    const text = el('span', `min-w-0 flex-1 truncate text-xs${p.status === 'done' ? ' line-through' : ''}`, p.text);
    text.title = ((p.history ?? []) as any[])
      .map((h) => `${new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${h.event}${h.note ? `: ${h.note}` : ''}`)
      .join('\n');
    li.append(el('span', 'shrink-0 text-[9px] text-ink-faint', `#${p.channel}`), text);
    // The sorter's verdict rides the row, not only the tooltip (model output: textContent only).
    const why = [...((p.history ?? []) as { note?: string }[])].reverse().find((h) => h.note?.startsWith('sorted #'))?.note?.replace(/^sorted #[^:]*:\s*/, '');
    if (why) li.append(el('span', 'max-w-[35%] shrink-0 truncate text-[9px] italic text-ink-faint', why));
    if (p.status === 'waiting') {
      const act = (op: string, extra?: Record<string, unknown>) => async () => {
        await postJson(`/api/flow/${p.id}`, { op, ...extra });
        void renderFlow(w);
      };
      const mkAct = (id: string, title: string, fn: () => void) => {
        const btn = el('button', 'btn min-h-0 shrink-0 px-1.5 py-0.5 text-[10px]'); btn.append(icon(id)); btn.setAttribute('aria-label', title);
        btn.type = 'button';
        btn.title = title;
        btn.addEventListener('click', fn);
        return btn;
      };
      li.append(
        mkAct('pen', 'Add a note', () => {
          const n = prompt('Add a note to this packet');
          if (n?.trim()) void act('annotate', { note: n })();
        }),
        mkAct('right', 'Pass along', () => void act('pass')()),
        mkAct('check', 'Complete', () => void act('complete')())
      );
    }
    list.append(li);
  }
  b.append(list);
  resubscribe(w.i, packetSubs, () => void renderFlow(w));
}

// --------------------------------------------------------------------- button

/** One ward = one button whose only job is to fire the graph. Press-and-hold
 *  on touch pointers, a click on a mouse. The wired line reads the graph, so
 *  it is never a mystery what a press does; the run line is the last result. */
async function renderButton(w: WardInstance): Promise<void> {
  ensureStream();
  const { data } = await getJson('/api/logic');
  const b = body(w.i);
  if (!b) return;
  const edges = ((data?.graph?.edges ?? []) as { id: string; source: { ward: string; trigger: string }; conditions: unknown[]; action: { type: string } }[]).filter(
    (e) => e.source.ward === w.i && e.source.trigger === 'button-pressed'
  );
  const edgeIds = new Set(edges.map((e) => e.id));
  const [cols, rows] = sizeParts(w.size);
  b.textContent = '';
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
  const card = b.closest<HTMLElement>('[data-wd]');
  const wrap = el('div', cols >= 2 ? 'flex h-full w-full items-stretch gap-2' : 'flex h-full w-full');
  // One-row wards are too short for an icon over a label: icon beside it.
  const btn = el('button', rows === 1 ? 'btn flex h-full min-w-0 flex-1 items-center justify-center gap-2' : 'btn flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1');
  btn.type = 'button';
  btn.append(icon(typeof w.config?.icon === 'string' ? w.config.icon : 'button', rows === 1 ? 'text-2xl' : 'text-3xl'), el('span', 'truncate text-xs', wardTitle(w)));
  wrap.append(btn);
  const side = cols >= 2 ? el('div', 'flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-[10px] text-ink-faint') : null;
  const wired = el('div', 'truncate', edges.length ? edges.map((e) => `${e.conditions.length ? 'When matched → ' : ''}${ACTIONS[e.action.type]?.label ?? e.action.type}`).join(' · ') : 'Draw a leyline to me in Leylines mode.');
  const run = el('div', 'truncate');
  if (side) {
    side.append(wired, run);
    if (rows >= 2) for (const e of edges) { const row = el('div', 'truncate'); row.append(icon(ACTIONS[e.action.type]?.icon ?? 'flow'), document.createTextNode(' ' + (ACTIONS[e.action.type]?.label ?? e.action.type))); side.append(row); }
    wrap.append(side);
  } else btn.title = wired.textContent ?? '';
  b.append(wrap);

  const paintRun = (r: RunEvent) => {
    run.textContent = `fired ${ago(Date.now() - Date.parse(r.at))} ago · ${r.result}${r.detail ? ` · ${r.detail}` : ''}`;
    run.classList.toggle('text-warn', r.result === 'error');
  };
  const runs = (data?.runs ?? {}) as Record<string, RunEvent & { at: string }>;
  const latest = [...edgeIds].map((id) => (runs[id] ? { ...runs[id]!, edgeId: id } : null)).filter((r): r is RunEvent => !!r).sort((a, c) => c.at.localeCompare(a.at))[0];
  if (latest) paintRun(latest);
  wardUnsubs.get(`run:${w.i}`)?.();
  const un = onRun((r) => {
    if (!btn.isConnected) return un();
    if (edgeIds.has(r.edgeId)) paintRun(r);
  });
  wardUnsubs.set(`run:${w.i}`, un);

  const press = async () => {
    btn.disabled = true;
    setTimeout(() => (btn.disabled = false), 800);
    if (card) {
      card.dataset.agentTouch = '1';
      setTimeout(() => delete card.dataset.agentTouch, 1200);
    }
    const res = await postJson(`/api/button/${encodeURIComponent(w.i)}`, {});
    if (!res.ok) {
      run.textContent = res.status === 429 ? 'too many presses — wait a bit' : res.status === 404 ? 'save the layout first' : (res.data?.error ?? 'press failed');
      run.classList.add('text-warn');
    }
  };
  if (matchMedia('(pointer: coarse)').matches) {
    let hold = 0;
    const arm = () => {
      btn.classList.add('scale-95', 'opacity-60');
      hold = window.setTimeout(() => {
        cancel();
        void press();
      }, 600);
    };
    const cancel = () => {
      clearTimeout(hold);
      btn.classList.remove('scale-95', 'opacity-60');
    };
    btn.addEventListener('pointerdown', arm);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, cancel);
  } else btn.addEventListener('click', () => void press());
}

// ----------------------------------------------------------- notion task list
// One renderer behind both task wards. The server hands over the WHOLE
// database (one cached read shared by every ward and watcher on it); show /
// sort / limit / which columns to chip are per-ward config applied here.

interface TaskItem {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  url: string;
  created: string;
  edited: string;
  fields: Record<string, PropValue>;
}

const byDue = (a: TaskItem, b: TaskItem) => (a.due ?? '9999').localeCompare(b.due ?? '9999');
const SORTS: Record<string, (a: TaskItem, b: TaskItem) => number> = {
  due: byDue,
  created: (a, b) => b.created.localeCompare(a.created),
  edited: (a, b) => b.edited.localeCompare(a.edited),
  title: (a, b) => a.title.localeCompare(b.title),
};

/** Open first, then done — inside each half, the ward's sort. */
function arrange(items: TaskItem[], cfg: Record<string, unknown>): TaskItem[] {
  const show = cfg.show === 'all' || cfg.show === 'done' ? cfg.show : 'open';
  const keep = items.filter((i) => (show === 'all' ? true : show === 'done' ? i.done : !i.done));
  const sort = SORTS[String(cfg.sort ?? 'due')] ?? byDue;
  const open = keep.filter((i) => !i.done).sort(sort);
  const closed = keep.filter((i) => i.done).sort(sort);
  const all = [...open, ...closed];
  const limit = Number(cfg.limit);
  return limit > 0 ? all.slice(0, limit) : all;
}

/** Today/tomorrow/overdue read better than a bare ISO date on a small ward.
 *  Local calendar days, not UTC — a due date is a date, not an instant. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dueLabel(due: string): { text: string; cls: string } {
  const now = new Date();
  const today = localDay(now);
  now.setDate(now.getDate() + 1);
  const date = due.slice(0, 10);
  if (date < today) return { text: `${date} · late`, cls: 'text-err' };
  if (date === today) return { text: 'today', cls: 'text-warn' };
  if (date === localDay(now)) return { text: 'tomorrow', cls: 'text-ink-faint' };
  return { text: date, cls: 'text-ink-faint' };
}

function chips(item: TaskItem, want: unknown): HTMLElement[] {
  if (!Array.isArray(want)) return [];
  const out: HTMLElement[] = [];
  for (const name of want as string[]) {
    const f = item.fields[name];
    if (!f?.text) continue;
    const v = propView(f);
    v.title = `${name}: ${f.text}`;
    out.push(v);
  }
  return out;
}

export function pickDbNote(w: WardInstance, b: HTMLElement): void {
  b.textContent = '';
  b.append(
    el('p', 'wd-note text-xs text-ink-faint', 'No database picked yet.'),
    el('p', 'wd-note text-[10px] text-ink-faint', 'Configure this ward in edit mode, or set a default in Account → Notion.')
  );
}

export async function renderChecklist(w: WardInstance): Promise<void> {
  const { status, data } = await getJson(`/api/checklist?ward=${encodeURIComponent(w.i)}`);
  if (handled(w.i, 'notion', status)) return;
  const b = body(w.i);
  if (!b) return;
  if (status !== 200) {
    note(w.i, String(data?.error ?? 'Notion unavailable.').slice(0, 120));
    return;
  }
  if (typingInto(b)) return;
  if (data?.needsConfig) return pickDbNote(w, b);
  b.textContent = '';

  const cfg = (w.config ?? {}) as Record<string, unknown>;
  const items = arrange((data?.items ?? []) as TaskItem[], cfg);
  const list = el('ul');
  for (const item of items) {
    const li = el('li', 'flex items-baseline gap-2 py-1');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.className = 'self-center';
    cb.checked = item.done;
    cb.addEventListener('change', async () => {
      li.style.opacity = '0.5';
      const res = await postJson(`/api/checklist/${encodeURIComponent(item.id)}`, { ward: w.i, done: cb.checked }, 'PATCH');
      li.style.opacity = '1';
      if (!res.ok) {
        cb.checked = !cb.checked;
        return;
      }
      // An open-only ward drops the row it just closed; every other view keeps it.
      if (cb.checked && cfg.show !== 'all' && cfg.show !== 'done') setTimeout(() => li.remove(), 400);
      label.classList.toggle('line-through', cb.checked);
      label.classList.toggle('text-ink-muted', cb.checked);
    });
    li.append(cb);

    const main = el('span', 'min-w-0 flex-1');
    const label = el('a', `block truncate text-xs hover:underline${item.done ? ' line-through text-ink-muted' : ''}`, item.title || '(untitled)');
    if (item.url) {
      label.setAttribute('href', item.url);
      label.setAttribute('target', '_blank');
      label.setAttribute('rel', 'noreferrer');
    }
    main.append(label);
    const tags = chips(item, cfg.props);
    if (tags.length) {
      const row = el('span', 'mt-0.5 flex flex-wrap gap-1');
      row.append(...tags);
      main.append(row);
    }
    li.append(main);

    if (item.due) {
      const d = dueLabel(item.due);
      li.append(el('span', `shrink-0 text-[10px] tabular-nums ${item.done ? 'text-ink-faint' : d.cls}`, d.text));
    }
    list.append(li);
  }
  b.append(list);
  if (!items.length) b.append(el('p', 'wd-note text-xs text-ink-faint', cfg.show === 'done' ? 'Nothing finished yet.' : 'All clear.'));

  b.append(addRowForm(w, () => renderChecklist(w), true));
}

/** The "add a row" line under a database ward — the list view (with a due
 *  date) and the table view share it. A new row is a new page; the checklist
 *  route knows the source's title column and open-state default. */
export function addRowForm(w: WardInstance, reload: () => Promise<void>, withDue: boolean): HTMLFormElement {
  const form = el('form', 'mt-1 flex gap-1');
  const input = el('input', 'input min-h-0 min-w-0 flex-1 px-2 py-1 text-xs');
  input.type = 'text';
  input.placeholder = withDue ? 'Add a task…' : 'Add a row…';
  form.append(input);
  let due: HTMLInputElement | undefined;
  if (withDue) {
    due = el('input', 'input min-h-0 w-[7.5rem] shrink-0 px-1 py-1 text-[10px]');
    due.type = 'date'; // native picker; the server re-checks the YYYY-MM-DD shape
    due.title = 'Due date (optional)';
    form.append(due);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true;
    const res = await postJson('/api/checklist', { ward: w.i, title, due: due?.value || undefined });
    input.disabled = false;
    if (res.ok) {
      input.value = '';
      if (due) due.value = '';
      void reload().then(() => (body(w.i)?.querySelector('input[type="text"]') as HTMLInputElement | null)?.focus());
    } else {
      input.title = res.data?.error ?? 'Add failed';
      input.classList.add('ring-1', 'ring-err');
      setTimeout(() => input.classList.remove('ring-1', 'ring-err'), 2000);
      input.focus();
    }
  });
  return form;
}

// ------------------------------------------------------------------- registry

RENDERERS.timer = { render: renderTimer };
RENDERERS.button = { render: (w) => renderButton(w) };
RENDERERS.checklist = { intervalMs: 2 * 60_000, render: (w) => renderChecklist(w) };
RENDERERS['notion-tasks'] = RENDERERS.checklist;
RENDERERS.flow = { intervalMs: 60_000, render: (w) => renderFlow(w) };
RENDERERS.flow = { intervalMs: 60_000, render: (w) => renderFlow(w) };
