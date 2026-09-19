// The Screen lens ward: a status card over /api/lens/<ward> — whether the lens
// is reading (screen / accessibility / helper), the app, window and field it is
// reading, the last deliveries it handed over, and the three controls. The lens
// itself runs in the desktop app, so off it the card says so and nothing else.
import type { WardInstance } from '../../lib/wards.ts';
import { el, getJson, postJson, toast } from './dom.ts';
import { icon } from './icon.ts';
import { RENDERERS, body, note } from './wards.ts';

// A ward added in edit mode renders before Done saves the layout, and the
// server resolves the ward against the STORED layout ("not a lens ward") —
// the same idiom as the mcp, agent and browser wards.
const unsaved = new Map<string, WardInstance>();
document.addEventListener('fd:layout-saved', () => {
  for (const [id, w] of [...unsaved]) {
    unsaved.delete(id);
    if (body(id)) void renderLens(w);
  }
});

interface Status {
  state: 'live' | 'offline';
  error: string | null;
  v: number;
  lines: number;
  incomplete: boolean;
  paused: boolean;
  dots: { screen: boolean; ax: boolean; helper: boolean };
  head: { app: string; window: string; focus: string };
  overlay: string[];
  captions: { on: boolean; from: string; to: string; state: 'off' | 'on' | 'unavailable'; error?: string };
  recent: { delivery: string; v: number; kind: 'key' | 'delta'; line: string }[];
}

const DOTS: [keyof Status['dots'], string][] = [
  ['screen', 'Screen — the lens is reading this computer'],
  ['ax', 'Accessibility — text the apps themselves expose'],
  ['helper', 'Helper — the on-device model behind watches'],
];

async function act(w: WardInstance, payload: Record<string, unknown>): Promise<void> {
  const res = await postJson(`/api/lens/${w.i}`, payload);
  if (!res.ok) return toast(res.data?.error ?? 'The lens refused that', undefined, true);
  void renderLens(w);
}

function button(label: string, id: string, fn: () => void): HTMLButtonElement {
  const b = el('button', 'btn min-h-0 px-2 py-1 text-xs flex items-center gap-1');
  b.type = 'button';
  b.append(icon(id), el('span', undefined, label));
  b.addEventListener('click', fn);
  return b;
}

async function renderLens(w: WardInstance): Promise<void> {
  const { status, data } = await getJson(`/api/lens/${w.i}`);
  const b = body(w.i);
  if (!b) return;
  if (status === 400 && data?.error === 'not a lens ward') {
    unsaved.set(w.i, w);
    note(w.i, 'Reads the screen once the layout is saved — press Done.');
    return;
  }
  if (status !== 200) {
    note(w.i, data?.error ?? 'Screen lens is not running on this computer.');
    return;
  }
  const s = data as Status;
  b.textContent = '';

  const head = el('div', 'flex items-center gap-2 text-xs');
  for (const [key, title] of DOTS) {
    const dot = el('span', `inline-block h-2 w-2 rounded-full shrink-0 ${s.dots[key] ? 'bg-ok' : 'bg-err'}`);
    dot.title = title;
    head.append(dot);
  }
  head.append(
    el('span', 'text-ink-faint truncate', s.paused ? 'paused' : s.state === 'live' ? `v${s.v} · ${s.lines} lines${s.incomplete ? ' · incomplete' : ''}` : 'not reading')
  );
  b.append(head);
  if (s.error) b.append(el('p', 'text-[10px] text-err', s.error));

  const where = [s.head.app, s.head.window, s.head.focus].filter((x) => x !== '').join(' · ');
  b.append(el('p', 'text-[10px] text-ink-faint truncate', where || 'nothing in front yet'));

  if (s.recent.length) {
    const d = el('details', 'mt-1 text-[10px]');
    d.append(el('summary', 'cursor-pointer text-ink-faint', `${s.recent.length} recent deliveries`));
    const ul = el('ul', 'mt-1 flex flex-col gap-0.5');
    for (const r of s.recent) {
      const li = el('li', 'truncate');
      li.title = r.delivery;
      li.append(
        el('span', 'font-mono', `${r.kind === 'key' ? 'key' : 'delta'} v${r.v}`),
        el('span', 'text-ink-faint', ` ${r.line}`)
      );
      ul.append(li);
    }
    d.append(ul);
    b.append(d);
  }

  const bar = el('div', 'mt-1 flex flex-wrap items-center gap-1');
  bar.append(
    s.paused
      ? button('Resume', 'play', () => void act(w, { action: 'resume' }))
      : button('Pause', 'pause', () => void act(w, { action: 'pause' })),
    button(s.overlay.length ? `Clear overlay (${s.overlay.length})` : 'Clear overlay', 'eraser', () =>
      void act(w, { action: 'overlay-clear' })
    )
  );
  b.append(bar);

  // Captions: the language pair rides with the switch, so one line does both.
  const caps = el('form', 'mt-1 flex items-center gap-1');
  const from = el('input', 'input text-xs w-14 min-w-0');
  from.value = s.captions.on ? s.captions.from : '';
  from.placeholder = 'from';
  from.setAttribute('aria-label', 'Translate captions from');
  const to = el('input', 'input text-xs w-14 min-w-0');
  to.value = s.captions.on ? s.captions.to : '';
  to.placeholder = 'to';
  to.setAttribute('aria-label', 'Translate captions into');
  const on = button('Captions on', 'note', () => void act(w, { action: 'captions', on: true, from: from.value.trim(), to: to.value.trim() }));
  const off = button('off', 'close', () => void act(w, { action: 'captions', on: false }));
  caps.append(from, to, on, off);
  caps.addEventListener('submit', (e) => e.preventDefault());
  b.append(caps);
  // `unavailable` is the language pair the machine has not got; the error names it.
  if (s.captions.state !== 'off') {
    b.append(
      el(
        'p',
        `text-[10px] ${s.captions.state === 'unavailable' ? 'text-err' : 'text-ink-faint'}`,
        s.captions.error ?? `captions ${s.captions.from} → ${s.captions.to}`
      )
    );
  }
}

RENDERERS.lens = { intervalMs: 60_000, render: renderLens };
