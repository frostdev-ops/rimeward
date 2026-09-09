import { readDesktopState, readDesktopCheckpoint, saveDesktopState, expandedDesktopWard, restoreExpandedWard } from "./desktop-state.ts";
import type { ContextUsage } from '../../lib/agent/context.ts';
// Agent wards: a chat client over the streamed POST /api/agent/<ward>
// protocol. One per-ward State drives every attached view — the compact ward
// and the shared #agent-dialog. Unchanged message nodes stay mounted while
// live events update the item model, preserving selection and reading position.
//
// Model output, tool results and file names are hostile input — createElement
// + textContent only, per the house rule in wards.ts. The markdown renderer
// below builds DOM nodes and never touches innerHTML.

import { ACTIONS } from '../../lib/logic.ts';
import { createAgentVoice, type VoiceState } from './agent-voice.ts';
import { completeCommand, parseCommand, type CommandSpec } from '../../lib/agent/commands.ts';
import type { AgentTask } from '../../lib/agent/tasks.ts';
import { CATALOG, pageOf, wardTitle, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body, note, readLayout } from './wards.ts';
import { el, getJson, postJson, tapToast, toast } from './dom.ts';
import { icon } from './icon.ts';
import { currentPage, readPages } from './pages.ts';
import { activeMentions, mentionPattern, tagMentionMessage, plainMentionText, MAX_WARD_MENTIONS, type WardMention } from '../../lib/agent/mentions.ts';
import { dialog } from './workspace-dialogs.ts';
import '../../styles/conversation.css';
import { ensureStream, flushPendingLayout, onAgentLive, onAgentPing, reloadHolds } from './logic.ts';

// ------------------------------------------------------------------ markdown
// Covers the subset a chat actually emits: inline code/bold/italic/strike/
// links, fenced code, headings, rules, tables, lists, quotes.

function inline(text: string, into: Node): void {
  // code | bold | italic | strike | link — code first so its content is literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/;
  let rest = text;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      into.appendChild(el('code', 'rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]', tok.slice(1, -1)));
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      const n = el('strong');
      inline(tok.slice(2, -2), n);
      into.appendChild(n);
    } else if (tok.startsWith('~~')) {
      const n = el('s');
      inline(tok.slice(2, -2), n);
      into.appendChild(n);
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      if (/^ward:[a-z0-9-]{1,32}$/.test(href)) {
        into.appendChild(mentionTag(label, href.slice(5)));
        rest = rest.slice(m.index + tok.length);
        continue;
      }
      // Only navigable schemes — no javascript:/data:, and no protocol-
      // relative //host smuggled past the leading-slash test.
      const safe = /^(https?:\/\/|mailto:|\/(?!\/))/i.test(href);
      const n = document.createElement(safe ? 'a' : 'span');
      if (safe && n instanceof HTMLAnchorElement) {
        n.href = href;
        n.className = 'text-accent-hi underline underline-offset-2';
        // New tab only for OTHER sites; same-origin links navigate in place.
        // The link regex admits hosts URL() rejects (`https://loot^vps`, stray
        // %, bad ports) — a throw here would take the whole ward down, so an
        // unparseable href is simply treated as foreign.
        let external = false;
        if (href.startsWith('http')) {
          try {
            external = new URL(href, location.href).origin !== location.origin;
          } catch {
            external = true;
          }
        }
        if (external) {
          n.target = '_blank';
          n.rel = 'noopener noreferrer';
        }
      }
      inline(label, n);
      into.appendChild(n);
    } else {
      const n = el('em');
      inline(tok.slice(1, -1), n);
      into.appendChild(n);
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) into.appendChild(document.createTextNode(rest));
}

function markdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = (src || '').replace(/\r/g, '').split('\n');
  let i = 0;
  const para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = el('p', 'whitespace-pre-wrap');
    inline(para.join('\n'), p);
    frag.appendChild(p);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      const code = buf.join('\n');
      const block = el('div', 'ag-code');
      const head = el('div', 'ag-code-head');
      head.append(el('span', undefined, line.slice(3).trim() || 'Code'), copyButton(code, 'Copy code'));
      const pre = el('pre');
      pre.appendChild(el('code', undefined, code));
      block.append(head, pre);
      frag.appendChild(block);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const n = document.createElement(`h${Math.min(h[1]!.length + 2, 6)}`);
      n.className = 'mt-1 font-bold';
      inline(h[2]!, n);
      frag.appendChild(n);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      frag.appendChild(el('hr', 'border-line'));
      i++;
      continue;
    }

    // table: | a | b |  with a --- separator row
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flushPara();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const table = el('table', 'w-full text-left text-xs');
      const thead = table.createTHead().insertRow();
      for (const c of cells(line)) {
        const th = el('th', 'border-b border-line px-2 py-1 font-semibold');
        inline(c, th);
        thead.appendChild(th);
      }
      const tbody = table.createTBody();
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const row = tbody.insertRow();
        for (const c of cells(lines[i]!)) {
          const td = row.insertCell();
          td.className = 'border-b border-line/60 px-2 py-1';
          inline(c, td);
        }
        i++;
      }
      const wrap = el('div', 'overflow-x-auto');
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      const list = el(ordered ? 'ol' : 'ul', ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5');
      while (i < lines.length) {
        const m = ordered ? lines[i]!.match(/^\s*\d+[.)]\s+(.*)$/) : lines[i]!.match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        const li = el('li');
        inline(m[1]!, li);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = el('blockquote', 'border-l-2 border-line-strong pl-3 text-ink-muted');
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      inline(buf.join('\n'), quote);
      frag.appendChild(quote);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return frag;
}

// --------------------------------------------------------------- step cards

interface Step {
  /** Provider call id + the tool round: every step of one round ran in parallel. */
  id?: string;
  round?: number;
  tool: string;
  kind: 'read' | 'write' | 'confirm';
  args?: Record<string, unknown>;
  reason?: string;
  result?: unknown;
  error?: string;
  ms?: number;
}

const ICON: Record<string, string> = { read: 'eye', write: 'pen', confirm: 'stop' };

/** Fallback label if the agent somehow sent no reason. */
function humanise(tool: string): string {
  return String(tool ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** One tool call, as the user reads it: the reason first, in plain words.
 *  Tool name, args and raw result live behind a <details> click. */
function stepCard(step: Step, running = false, ward = ''): HTMLElement {
  const row = el('div', 'ag-step');

  const head = el('div', 'flex items-start gap-2');
  const mark = el('span', running ? 'spinner mt-0.5 shrink-0' : 'mt-px shrink-0');
  if (!running) {
    mark.append(icon(step.error ? 'close' : ICON[step.kind] ?? 'eye'));
    if (step.error) mark.classList.add('text-err');
  }
  const line = el('span', `min-w-0 flex-1${step.error ? ' text-err' : ''}`, step.reason || humanise(step.tool));
  head.append(mark, line);
  if (step.result && typeof step.result === 'object' && 'background' in step.result && step.result.background)
    head.append(el('span', 'text-[10px] text-ink-faint', 'Background task'));

  if (!running && step.ms) head.append(el('span', 'shrink-0 text-[10px] text-ink-faint', fmtMs(step.ms)));
  row.append(head);
  if (typeof step.args?.device === 'string') row.append(el('small', 'ml-5 text-ink-faint', `Computer: ${step.args.device}`));

  // An error is something the user has to know about, so it stays visible.
  if (step.error) {
    row.append(el('div', 'mt-1 pl-5 text-err', step.error));
  } else if (!running && step.result !== undefined) {
    const det = document.createElement('details');
    const sum = el('summary', 'mt-0.5 ml-5 cursor-pointer text-[11px] text-ink-faint select-none hover:text-ink-muted', 'details');
    const pre = el('pre', 'mt-1 ml-5 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px] whitespace-pre-wrap');
    const args = { ...(step.args ?? {}) };
    delete args.reason; // already said, in English, above
    const text =
      `${step.tool}(${Object.keys(args).length ? JSON.stringify(args, null, 1) : ''})\n\n` +
      (typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 1));
    pre.textContent = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated for display)` : text;
    det.append(sum, pre);
    if (['computer_screenshot', 'computer_app_state', 'computer_app_input', 'render_document_page'].includes(step.tool) && step.result && typeof step.result === 'object' && 'image_sha256' in step.result && typeof step.result.image_sha256 === 'string' && /^[a-f0-9]{64}$/.test(step.result.image_sha256)) {
      const image = el('img', 'mt-2 max-w-full rounded'); image.alt = step.tool === 'render_document_page' ? 'Rime PDF page' : 'Rime computer screenshot'; image.loading = 'lazy';
      image.src = `/api/agent/files?sha=${step.result.image_sha256}&_ward=${encodeURIComponent(ward)}`;
      det.append(image);
    }
    row.append(det);
  }
  return row;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// -------------------------------------------------------------------- state

interface Pending {
  confirmId: string;
  summary: string;
  patch?: string;
}

/** Who asked for the turn this item belongs to. Server-stamped and stored, so
 *  an automation still reads as one after a reload. */
type TurnSource = 'chat' | 'automation' | 'wake' | 'agent';

interface StepItem {
  k: 'step';
  step: Step;
  running?: boolean;
  src?: TurnSource;
  /** Same key = same tool round = ran in parallel; consecutive ones draw as one batch. */
  batch?: string;
}

/** The in-flight cards of one streamed turn, keyed by call id, plus a per-turn
 *  seq so a round number can't collide with the previous turn's. */
interface Run {
  steps: Map<string, StepItem>;
  seq: number;
  spoken: Set<string>;
}
let runSeq = 0;
const newRun = (): Run => ({ steps: new Map(), seq: ++runSeq, spoken: new Set() });
const batchKey = (seq: number | string, round: unknown) => (typeof round === 'number' ? `${seq}:${round}` : undefined);

type Item =
  | { k: 'msg'; role: 'user' | 'assistant'; text: string; src?: TurnSource }
  | StepItem
  | { k: 'thinking'; label?: string }
  | { k: 'note'; text: string; err?: boolean; icon?: string };

/** One attached view of a ward's conversation (the ward, or the dialog). */
interface Ui {
  root: HTMLElement;
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  background: HTMLButtonElement;
  tasksButton: HTMLButtonElement;
  microphone: HTMLButtonElement;
  voiceStop: HTMLButtonElement;
  voiceStatus: HTMLElement;
  readResponses: HTMLInputElement;
  conversationMode: HTMLSelectElement;
  chips: HTMLElement;
  pendingBox: HTMLElement;
  pendingText: HTMLElement;
  pendingDetails: HTMLDetailsElement;
  pendingPatch: HTMLElement;
  status: HTMLElement;
  /** How full the thread is, next to the status line. */
  context: HTMLElement;
  jump: HTMLButtonElement;
  follow: boolean;
  restored?: boolean;
  rendered: { signature: string; node: HTMLElement }[];
}

interface State {
  w: WardInstance;
  items: Item[];
  pending: Pending | null;
  /** A locally-streamed turn is in flight (server `busy` just adds a row). */
  busy: boolean;
  /** A turn is running somewhere else — another tab, another device, or an
   *  automation. Painted from the mirror; the composer waits it out. */
  remote: boolean;
  revision: number;
  refresh: number;
  abort: AbortController | null;
  attachments: { id: string; name: string }[];
  uploading: number;
  draft: string;
  mentions: WardMention[];
  clearing: boolean;
  tasks: AgentTask[];
  sharedStatus?: string;
  configured?: boolean;
  context?: ContextUsage;
  uis: Set<Ui>;
  voice?: ReturnType<typeof createAgentVoice>;
  voiceState?: VoiceState;
}

const kTokens = (t: number) => t < 1000 ? `${Math.round(t)}` : `${Math.round(t / 1000)}k`;
function paintContext(el: HTMLElement, c: State['context']): void {
  el.hidden = !c;
  if (!c) return;
  const pct = c.window ? Math.round(100 * c.tokens / c.window) : null;
  el.textContent = pct === null ? `~${kTokens(c.tokens)}` : `~${pct}%`;
  el.style.setProperty('--ag-ctx', `${Math.min(100, pct ?? 0)}%`);
  el.dataset.hot = String(c.compactAt !== null && c.tokens >= c.compactAt * .9);
  const billed = c.input ? ` · last request ${kTokens(c.input)} input tokens, ${Math.round(100 * (c.cached ?? 0) / c.input)}% cached` : '';
  const capacity = c.window ? `${kTokens(c.window)} token window; compacts near ${kTokens(c.compactAt!)}${c.source === 'cache' ? ' (cached model limits)' : ''}` : 'model capacity unavailable';
  el.title = `${c.model}: approximately ${kTokens(c.tokens)} tokens including instructions, tools and conversation · ${capacity}${billed}. Unseen text and media are estimates.`;
  el.setAttribute('aria-label', pct === null ? `Approximately ${kTokens(c.tokens)} context tokens; capacity unknown` : `Context approximately ${pct}% full`);
}

const states = new Map<string, State>();

function hideVoiceCapture(st: State) {
  if (![...st.uis].some(ui => ui.root.isConnected && ui.root.getClientRects().length > 0)) void st.voice?.viewHidden();
}
window.addEventListener('fd:page', () => { for (const st of states.values()) hideVoiceCapture(st); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') for (const st of states.values()) void st.voice?.viewHidden();
});

function voiceFor(st: State) {
  return st.voice ??= createAgentVoice({
    ward: st.w.i,
    getDraft: () => st.draft,
    setDraft: value => setDraft(st, value),
    isAlive: () => readLayout().some(w => w.i === st.w.i && w.type === 'agent'),
    canAutoSend: () => document.visibilityState !== 'hidden' && !st.pending && !st.clearing && !st.uploading && !st.attachments.length && st.configured !== false &&
      [...st.uis].some(ui => ui.root.isConnected && ui.root.getClientRects().length > 0) &&
      ![...st.uis].some(ui => document.activeElement === ui.input),
    submitDraft: async expected => {
      if (st.draft !== expected || st.pending || st.clearing || st.uploading || st.configured === false) return false;
      const ui = [...st.uis].find(ui => ui.root.isConnected && ui.root.getClientRects().length > 0);
      if (!ui || !expected.trim()) return false;
      submit(st, ui);
      return st.draft === '';
    },
    onState: state => { st.voiceState = state; paint(st); },
  });
}


function stateFor(w: WardInstance): State {
  let st = states.get(w.i);
  if (!st) {
    st = { w, items: [], pending: null, busy: false, remote: false, revision: 0, refresh: 0, abort: null, attachments: [], uploading: 0, draft: '', mentions: [], clearing: false, tasks: [], uis: new Set() };
    const saved = readDesktopState<{ draft?: string; mentions?: WardMention[]; attachments?: { id: string; name: string }[] }>(`agent:${w.i}:${w.device ?? ''}`);
    if (typeof saved?.draft === 'string') st.draft = saved.draft;
    if (Array.isArray(saved?.attachments)) st.attachments = saved.attachments.filter(a => typeof a?.id === 'string' && typeof a?.name === 'string');
    if (Array.isArray(saved?.mentions)) st.mentions = saved.mentions.filter(m => typeof m?.ward === 'string' && typeof m?.title === 'string').slice(0, MAX_WARD_MENTIONS);
    states.set(w.i, st);
    watchAgent(w.i);
  }
  if (st.w.device !== w.device) st.voice?.dispose();
  st.w = w; // config changes keep the same id — track the live instance
  return st;
}

function itemsFrom(transcript: any[]): Item[] {
  const items: Item[] = [];
  transcript.forEach((m, mi) => {
    // Older rows predate the column; anything unrecognised reads as chat.
    const src: TurnSource = m.source === 'automation' || m.source === 'wake' || m.source === 'agent' ? m.source : 'chat';
    for (const step of (m.steps ?? []) as Step[]) items.push({ k: 'step', step, src, batch: batchKey(mi, step.round) });
    if (typeof m.text === 'string' && m.text.trim()) items.push({ k: 'msg', role: m.role === 'user' ? 'user' : 'assistant', text: m.text, src });
  });
  return items;
}

function copyButton(text: string, label: string): HTMLButtonElement {
  const button = el('button', 'ag-copy');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon('copy'), el('span', undefined, 'Copy'));
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.lastElementChild!.textContent = 'Copied';
      setTimeout(() => { button.lastElementChild!.textContent = 'Copy'; }, 1600);
    } catch {
      toast('Clipboard unavailable. Select the text to copy it.');
    }
  };
  return button;
}

function mentionTag(label: string, ward: string): HTMLElement {
  const tag = el('span', 'ag-mention-tag');
  tag.dataset.agMention = ward;
  const w = readLayout().find(w => w.i === ward);
  tag.append(icon(CATALOG[w?.type ?? '']?.icon ?? 'attach'), el('span', 'truncate', label));
  tag.title = `${label} · Attached ward context`;
  tag.setAttribute('aria-label', `Attached ward: ${label.replace(/^@/, '')}`);
  return tag;
}

/** User prose stays literal; only our persisted ward tags receive inline styling. */
function appendMentionText(text: string, into: HTMLElement): void {
  let from = 0;
  for (const m of text.matchAll(/\[(@[^\]]+)\]\(ward:([a-z0-9-]{1,32})\)/g)) {
    into.append(document.createTextNode(text.slice(from, m.index)), mentionTag(m[1]!, m[2]!));
    from = m.index + m[0].length;
  }
  into.append(document.createTextNode(text.slice(from)));
}

function bubble(role: 'user' | 'assistant', text: string): HTMLElement {
  const wrap = el('article', `ag-message ag-${role}`);
  wrap.setAttribute('aria-label', role === 'user' ? 'You' : 'Assistant');
  const inner = el('div', 'ag-prose');
  if (role === 'user') appendMentionText(text, inner);
  else inner.append(markdown(text));
  const actions = el('div', 'ag-message-actions');
  actions.append(copyButton(plainMentionText(text), 'Copy message'));
  wrap.append(inner, actions);
  return wrap;
}

// ------------------------------------------------------------- empty state
//
// "Ask the agent anything" told nobody anything, so the first thing typed was
// "test". What replaces it is generated from the live catalogs wherever one
// exists — a hand-written feature list rots the day a ward type or a logic
// action lands.

/** Under ~45 chars each so they wrap sanely in a 2x2 ward. Each one maps to a
 *  tool the agent actually has (status, mail, add_ward, the logic graph,
 *  schedule_wake, resize/set_theme). */
const STARTERS = [
  "What's down right now?",
  'Summarize my unread mail',
  'Add a 25-minute timer ward',
  'What automations do I have?',
  'Every morning at 8, brief me on the day',
  'Make the dashboard more compact',
];

/** Area → what it can do there. The first two rows read the real catalogs; the
 *  rest name the agent's own tools, which live server-side (lib/agent/tools.ts
 *  imports the db) and so can't be enumerated from the client bundle. */
function capabilities(): [string, string][] {
  const wards = Object.values(CATALOG)
    .map((c) => c.title)
    .join(', ');
  const acts = Object.values(ACTIONS)
    .filter((a) => !a.adminOnly)
    .map((a) => a.label)
    .join(', ');
  return [
    ['Dashboard', `add, move, resize, configure and remove wards, and retheme — ${wards}`],
    ['Leylines', `draw leylines between wards, then edit, disable or delete them — ${acts}`],
    ['Reading', 'service status, weather, mail, agenda, Notion, checklists, timers, packets, files you attach'],
    ['Doing', 'send mail (it asks first), capture to Notion, tick checklists, run timers, move packets'],
    ['Power', 'a sandboxed bash shell, web search and fetch, wake-ups it schedules for itself — and any browser ward, a real Chromium it reads and drives alongside you'],
  ];
}

function emptyState(st: State, ui: Ui): HTMLElement {
  const wrap = el('div', 'ag-empty');
  const mark = el('div', 'ag-empty-mark');
  mark.append(icon('sparkle'));
  wrap.append(mark, el('h3', undefined, 'What would you like to work on?'),
    el('p', undefined, 'Plan a project, explore an idea, or put your workspace to work.'));
  const chips = el('div', 'ag-starters');
  const starters = st.w.config?.project ? [
    'Explore this project and explain how it fits together',
    'Review the current changes',
    'Help me plan the next feature',
    'Check on my terminal agents',
  ] : STARTERS.slice(0, 4);
  for (const text of starters) {
    const c = el('button', 'ag-starter', text);
    c.type = 'button';
    c.addEventListener('click', () => {
      setDraft(st, text);
      ui.input.focus();
    });
    chips.append(c);
  }
  wrap.append(chips);

  const det = document.createElement('details');
  det.append(el('summary', 'cursor-pointer text-[11px] text-ink-faint select-none hover:text-ink-muted', 'What can it do?'));
  const list = el('div', 'mt-1 space-y-1');
  for (const [area, what] of capabilities()) {
    const row = el('div', 'text-[10px] leading-snug text-ink-faint');
    row.append(el('span', 'text-ink-muted', `${area} — `), document.createTextNode(what));
    list.append(row);
  }
  det.append(list);
  wrap.append(det);
  return wrap;
}

// ----------------------------------------------------------------- the log

const SRC_LABEL: Record<TurnSource, string> = { chat: '', automation: 'automation', wake: 'scheduled', agent: 'another agent' };

function buildLog(st: State, ui: Ui): void {
  const log = ui.log;
  const entries: { signature: string; create: () => HTMLElement }[] = [];
  if (!st.items.length) entries.push({ signature: 'empty', create: () => emptyState(st, ui) });
  let prev: TurnSource = 'chat';
  for (let i = 0; i < st.items.length; i++) {
    const it = st.items[i]!;
    const src = it.k === 'msg' || it.k === 'step' ? it.src ?? 'chat' : 'chat';
    const label = src !== 'chat' && src !== prev ? SRC_LABEL[src] : '';
    const group: StepItem[] = [];
    if (it.k === 'step') {
      group.push(it);
      while (st.items[i + 1]?.k === 'step' && (st.items[i + 1] as StepItem).src === it.src)
        group.push(st.items[++i] as StepItem);
    }
    entries.push({ signature: JSON.stringify([label, group.length ? group : it]), create: () => {
      let node: HTMLElement;
      if (it.k === 'msg') {
        node = bubble(it.role, it.text);
        if (it.role === 'assistant') {
          const read = el('button', 'ag-copy');
          read.type = 'button'; read.title = 'Read this message aloud'; read.setAttribute('aria-label', 'Read this message aloud');
          read.append(icon('volume'), el('span', undefined, 'Read aloud'));
          read.onclick = () => { void voiceFor(st).speak(it.text); };
          node.querySelector('.ag-message-actions')!.append(read);
        }
      }
      else if (it.k === 'step') {
        const activity = el('details', 'ag-activity');
        const running = group.filter(g => g.running).length;
        const failed = group.filter(g => g.step.error).length;
        const summary = el('summary');
        const mark = el('span', running ? 'spinner' : 'ag-activity-mark');
        if (!running) mark.append(icon(failed ? 'warning' : 'check'));
        summary.append(mark,
          el('span', undefined, running ? group.find(g => g.running)!.step.reason || 'Working…' : `${group.length} ${group.length === 1 ? 'agent action' : 'agent actions'}${failed ? ` · ${failed} need attention` : ''}`));
        activity.open = failed > 0;
        activity.append(summary, ...group.map(g => stepCard(g.step, g.running, st.w.i)));
        node = activity;
      } else if (it.k === 'thinking') {
        node = el('div', 'ag-thinking');
        node.append(el('span', 'spinner'), el('span', undefined, it.label ?? 'Thinking…'));
      } else {
        node = el('div', `ag-notice${it.err ? ' ag-error' : ''}`);
        if (it.icon || it.err) node.append(icon(it.icon ?? 'warning'), document.createTextNode(' '));
        node.append(document.createTextNode(it.text));
      }
      if (label) {
        const rail = el('div', 'ag-source');
        const source = el('span', 'ag-source-label');
        source.append(icon(src === 'wake' ? 'timer' : src === 'agent' ? 'bot' : 'flow'), document.createTextNode(' ' + label));
        rail.append(source, node);
        return rail;
      }
      return node;
    }});
    prev = src;
  }
  // Keep unchanged message nodes in place: selecting text, reading older
  // replies and expanding tool details must survive live activity.
  const top = log.scrollTop;
  const rendered = entries.map((entry, i) => {
    const old = ui.rendered[i];
    if (old?.signature === entry.signature) return old;
    const node = entry.create();
    if (old?.node instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement)
      node.open ||= old.node.open;
    if (old) old.node.replaceWith(node);
    else log.append(node);
    return { signature: entry.signature, node };
  });
  for (const old of ui.rendered.slice(entries.length)) old.node.remove();
  ui.rendered = rendered;
  log.scrollTop = ui.follow ? log.scrollHeight : top;
  if (!ui.restored && entries.length) {
    ui.restored = true;
    const saved = readDesktopCheckpoint<{ follow: boolean; top: number; details: number[] }>(`agent-view:${st.w.i}:${st.w.device ?? ''}`);
    if (saved && Number.isFinite(saved.top)) {
      ui.follow = saved.follow === true;
      log.querySelectorAll('details').forEach((detail, index) => { detail.open = saved.details?.includes(index) ?? false; });
      log.scrollTop = ui.follow ? log.scrollHeight : saved.top;
    }
  }
  ui.jump.hidden = ui.follow || log.scrollHeight - log.clientHeight < 48;
}

function setDraft(st: State, value: string): void {
  st.draft = value;
  try { saveDraft(st); } catch { /* Explicit permission checkpoint reports storage failure. */ }
  for (const ui of st.uis) {
    if (ui.input.value !== value) ui.input.value = value;
    autoGrow(ui.input);
    paintChips(st, ui.chips);
    ui.send.disabled = st.configured === false || st.uploading > 0 || st.clearing || (!value.trim() && !st.attachments.length);
  }
}

function paintChips(st: State, chips: HTMLElement): void {
  chips.replaceChildren();
  for (const m of activeMentions(st.draft, st.mentions)) {
    const chip = el('button', 'ag-mention-chip');
    chip.type = 'button';
    const w = readLayout().find(w => w.i === m.ward);
    chip.append(icon(CATALOG[w?.type ?? '']?.icon ?? 'folder'), el('span', 'truncate', `@${m.title}`), icon('close'));
    chip.title = `${w ? mentionSummary(w.type) : 'Ward unavailable'} · Captured when sent · Click to remove`;
    chip.setAttribute('aria-label', `Remove mention ${m.title}`);
    chip.onclick = () => {
      setDraft(st, st.draft.replace(mentionPattern(m), ''));
      st.mentions = st.mentions.filter(x => x.ward !== m.ward);
      paint(st);
    };
    chips.append(chip);
  }
  for (const a of st.attachments) {
    const chip = el('span', 'inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs');
    chip.append(el('span', 'truncate', a.name));
    const rm = el('button', 'shrink-0 text-ink-faint hover:text-err');
    rm.type = 'button';
    rm.append(icon('close'));
    rm.setAttribute('aria-label', `Remove ${a.name}`);
    rm.addEventListener('click', () => {
      st.attachments = st.attachments.filter((x) => x !== a);
      paint(st);
    });
    chip.append(rm);
    chips.append(chip);
  }
  if (st.uploading > 0) {
    const chip = el('span', 'inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs text-ink-faint');
    chip.append(el('span', 'spinner'), document.createTextNode(`uploading ${st.uploading}…`));
    chips.append(chip);
  }
  const any = chips.childElementCount > 0;
  chips.classList.toggle('hidden', !any);
  chips.classList.toggle('flex', any);
}

/** Repaint every attached view from the item model. Cheap and impossible to
 *  desync — transcripts are short and streams emit tens of frames, not
 *  thousands. */
function saveDraft(st: State) {
  saveDesktopState(`agent:${st.w.i}:${st.w.device ?? ''}`, { draft: st.draft, mentions: st.mentions, attachments: st.attachments });
}
window.addEventListener('fd:before-workspace-navigation', event => {
  (event as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(Promise.resolve().then(() => {
    for (const st of states.values()) {
      st.voice?.dispose();
      if (st.uploading) throw Error('Wait for Rime attachments to finish uploading before relaunching.');
      saveDraft(st);
      const ui = [...st.uis].find(ui => ui.root.closest('dialog[open]')) ?? [...st.uis][0];
      if (ui) saveDesktopState(`agent-view:${st.w.i}:${st.w.device ?? ''}`, { follow: ui.follow, top: ui.log.scrollTop, details: [...ui.log.querySelectorAll('details')].flatMap((detail, index) => detail.open ? [index] : []) });
    }
  }));
});
function paint(st: State): void {
  if (st.busy || st.remote) reloadHolds.add(st.w.i);
  else reloadHolds.delete(st.w.i);
  try { saveDraft(st); } catch { /* Retain the in-memory draft until recovery can be saved. */ }
  for (const ui of [...st.uis]) if (!ui.root.isConnected) st.uis.delete(ui);
  for (const ui of st.uis) {
    buildLog(st, ui);
    const voicePhase = st.voiceState?.phase ?? 'idle';
    const voiceActive = voicePhase !== 'idle' && voicePhase !== 'error';
    const conversationMode = st.voiceState?.mode ?? 'off';
    ui.readResponses.checked = st.voiceState?.readEnabled ?? false;
    ui.conversationMode.value = conversationMode;
    ui.conversationMode.disabled = st.clearing || voicePhase === 'finishing';
    ui.microphone.disabled = st.clearing || voicePhase === 'finishing' || (conversationMode !== 'off' && voicePhase !== 'listening');
    ui.microphone.setAttribute('aria-pressed', String(voicePhase === 'listening'));
    const microphoneLabel = conversationMode !== 'off' ? 'Finish & Send' : voicePhase === 'listening' ? 'Finish dictation' : voiceActive ? 'Stop voice' : 'Dictate message';
    ui.microphone.title = microphoneLabel;
    ui.microphone.setAttribute('aria-label', microphoneLabel);
    ui.voiceStop.hidden = !voiceActive && !st.voiceState?.readEnabled && conversationMode === 'off';
    ui.voiceStatus.hidden = !st.voiceState?.message;
    ui.voiceStatus.textContent = st.voiceState?.message ?? '';
    ui.voiceStatus.dataset.error = String(voicePhase === 'error');
    // Mid-turn the composer stays open: a send steers the running turn.
    ui.send.disabled = st.configured === false || st.uploading > 0 || st.clearing || (!st.draft.trim() && !st.attachments.length);
    const working = st.busy || st.remote;
    const status = st.pending ? 'Approval needed' : st.clearing ? 'Starting a new chat…' : working ? 'Working · send a follow-up to steer' : st.sharedStatus || 'Rimeward agent';
    if (ui.status.textContent !== status) ui.status.textContent = status;
    paintContext(ui.context, st.context);
    ui.root.dataset.working = String(working);
    ui.input.placeholder = st.configured === false ? 'Reconnect or configure a local provider in Account…' : working ? 'Add a follow-up…' : 'Message Rime…';
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-attach]').forEach(b => { b.disabled = st.configured === false; });
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-clear]').forEach(b => { b.disabled = working || st.clearing || st.uploading > 0; });
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-history]').forEach(b => { b.disabled = working || st.clearing || st.uploading > 0; });
    ui.stop.classList.toggle('hidden', !st.busy && !st.remote); // server-side stop — any client, any turn
    ui.background.classList.toggle('hidden', !st.busy && !st.remote && !st.tasks.some(t => t.state === 'running' && !t.background));
    const running = st.tasks.filter(t => t.state === 'running' || t.state === 'stopping').length;
    ui.tasksButton.setAttribute('aria-label', `Tasks${running ? ` (${running} running)` : ''}`);
    ui.tasksButton.title = `Tasks${running ? ` · ${running} running` : ''}`;
    ui.tasksButton.dataset.count = running ? String(running) : '';
    ui.pendingBox.classList.toggle('hidden', !st.pending);
    ui.pendingBox.classList.toggle('flex', !!st.pending);
    ui.pendingText.textContent = st.pending?.summary ?? '';
    ui.pendingDetails.hidden = !st.pending?.patch;
    if (ui.pendingPatch.textContent !== (st.pending?.patch ?? '')) ui.pendingPatch.textContent = st.pending?.patch ?? '';
    paintChips(st, ui.chips);
  }
}

/** Reload the persisted transcript. `settled` marks the call that follows a
 *  turn-finished ping: the chain hasn't released `busy` yet at that instant, so
 *  trusting it there would strand a spinner and a disabled composer. */
async function refetch(st: State, settled = false): Promise<void> {
  if (!st.uis.size) return; // The initial render owns mounting; a reconnect must not supersede it.
  const revision = st.revision;
  const refresh = ++st.refresh;
  const { status, data } = await getJson(`/api/agent/${encodeURIComponent(st.w.i)}`).catch(() => ({ status: 0, data: null }));
  if (status !== 200 || !data) return;
  if (st.busy || st.revision !== revision || st.refresh !== refresh) return;
  st.configured = data.configured;
  st.context = data.context ?? undefined;
  st.tasks = data.tasks ?? [];
  if (!st.remote || !data.busy) st.items = itemsFrom(data.transcript ?? []);
  st.pending = data.pending ?? null;
  // A turn is running elsewhere (another client, or an automation) — its live
  // frames repaint over this, but the thread is busy either way.
  st.remote = !settled && !!data.busy;
  if (st.remote && !st.items.some(it => it.k === 'thinking' || (it.k === 'step' && it.running))) st.items.push({ k: 'thinking' });
  paint(st);
  if (settled) flushPendingLayout();
}

// --------------------------------------------------------------- turn flow

function endTurn(st: State): void {
  st.busy = false;
  // A stream that ends mid-call must not leave spinners running forever.
  for (const it of st.items) if (it.k === 'step') it.running = false;
  dropThinking(st);
}

function dropThinking(st: State): void {
  st.items = st.items.filter((it) => it.k !== 'thinking');
}

/** What a send that didn't land puts back. */
interface Restore {
  mentions?: WardMention[];
  text?: string;
  files?: { id: string; name: string }[];
  /** The confirm decide() hid optimistically — the server still has it parked. */
  pending?: Pending | null;
}

function fail(st: State, msg: string, restore: Restore): void {
  st.items.push({ k: 'note', err: true, text: msg });
  // Nothing typed, uploaded or parked is lost — the request didn't land.
  if (restore.mentions?.length) st.mentions = [...new Map([...st.mentions, ...restore.mentions].map(m => [m.ward, m])).values()];
  if (restore.files?.length) st.attachments = [...restore.files, ...st.attachments];
  if (restore.pending) st.pending = restore.pending;
  paint(st);
  if (restore.text && !st.draft) setDraft(st, restore.text);
}

/** Apply one streamed AgentEvent to the item model. Shared by the local POST
 *  stream and the SSE mirror of headless runs ('user' only ever arrives on the
 *  mirror). Returns false for the types the caller owns (done/error). */
function applyEvent(st: State, run: Run, e: any, src?: TurnSource): boolean {
  st.revision++;
  switch (e.type) {
    case 'user':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'msg', role: 'user', text: e.text, src });
      return true;
    case 'thinking':
      dropThinking(st);
      st.items.push({ k: 'thinking', ...(typeof e.label === 'string' ? { label: e.label } : {}) });
      return true;
    case 'note':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'note', text: e.text });
      return true;
    case 'says':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) {
        st.items.push({ k: 'msg', role: 'assistant', text: e.text, src });
        const speechKey = typeof e.id === 'string' ? e.id : e.text;
        if (!run.spoken.has(speechKey)) {
          run.spoken.add(speechKey);
          st.voice?.read(e.text, typeof e.id === 'string' ? e.id : `${run.seq}:${run.spoken.size}`);
        }
      }
      return true;
    case 'step_start': {
      dropThinking(st); // the spinner on the card carries the signal now
      const it: StepItem = {
        k: 'step',
        step: { id: e.id, round: e.round, tool: e.tool, kind: e.kind, args: e.args, reason: e.reason },
        running: true,
        src,
        batch: batchKey(run.seq, e.round),
      };
      run.steps.set(String(e.id), it);
      st.items.push(it);
      return true;
    }
    case 'step': {
      const it = run.steps.get(String(e.step?.id));
      if (it) {
        it.step = e.step;
        it.running = false;
        run.steps.delete(String(e.step.id));
      } else {
        st.items.push({ k: 'step', step: e.step, src, batch: batchKey(run.seq, e.step?.round) });
      }
      return true;
    }
    case 'pending':
      st.pending = e.pending ?? null;
      return true;
    case 'usage':
      if (typeof e.tokens === 'number' && typeof e.model === 'string') st.context = e;
      return true;
    case 'reply':
      // 'reply' is the final text ('says' are mid-turn interjections);
      // done's reply field repeats it and is ignored by the caller.
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) {
        st.items.push({ k: 'msg', role: 'assistant', text: e.text, src });
        const speechKey = typeof e.id === 'string' ? e.id : e.text;
        if (!run.spoken.has(speechKey)) {
          run.spoken.add(speechKey);
          st.voice?.read(e.text, typeof e.id === 'string' ? e.id : `${run.seq}:${run.spoken.size}`);
        }
      }
      return true;
  }
  return false;
}

async function flushMentionedWards(wards: string[]): Promise<void> {
  if (!wards.length) return;
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('fd:ward-context', { detail: { wards, waitUntil: (p: Promise<unknown>) => pending.push(p) } }));
  await Promise.all(pending);
}

async function post(st: State, payload: Record<string, unknown>, back: Restore = {}): Promise<void> {
  st.revision++;
  st.busy = true;
  // Hold off any server-side layout reload until this turn is done — the
  // agent's own edits broadcast 'layout' mid-stream.
  reloadHolds.add(st.w.i);
  st.abort = new AbortController();
  // /compact is a model round-trip that answers as plain JSON — no stream
  // frames to paint status from, so the wait is announced here.
  if (typeof payload.message === 'string' && /^\/(compact|summari[sz]e)\b/.test(payload.message.trim()))
    st.items.push({ k: 'thinking', label: 'compacting the older part of this thread…' });
  paint(st);
  const restore: Restore = { text: typeof payload.message === 'string' ? payload.message : '', ...back };
  const running = newRun();
  let accepted = false;
  let completed = false;
  const reconnect = () => {
    st.busy = false;
    st.remote = true;
    remoteRuns.set(st.w.i, running);
    st.items.push({ k: 'note', text: 'Response connection lost. Checking the running turn…' });
    paint(st);
    void refetch(st);
  };

  const dispatch = (e: any): void => {
    if (!applyEvent(st, running, e)) {
      if (e.type === 'done') {
        completed = true;
        endTurn(st);
        st.pending = e.pending ?? null;
      } else if (e.type === 'error') {
        completed = true;
        endTurn(st);
        // A stream means the server took the request — the confirm is spent,
        // so this one doesn't put the bar back.
        fail(st, String(e.error ?? 'agent error'), { ...restore, pending: null });
        return; // fail() painted
      }
    }
    paint(st);
  };

  try {
    await flushMentionedWards(Array.isArray(payload.ward_ids) ? payload.ward_ids : []);
    const res = await fetch(`/api/agent/${encodeURIComponent(st.w.i)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: st.abort.signal,
    });

    // Error paths (busy, not-configured) and slash commands answer plain JSON.
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      endTurn(st);
      if (res.ok && data?.command) {
        if (data.command === 'clear') {
          st.voice?.dispose();
          // The empty log IS the confirmation, and clearThread's ping would
          // wipe a note here anyway. Other clients follow from that ping.
          st.items = [];
          st.pending = null;
          st.attachments = [];
        } else {
          st.items.push({ k: 'note', text: String(data.text ?? '') });
        }
        paint(st);
        return;
      }
      if (!res.ok) {
        const msg =
          data?.error === 'busy'
            ? 'The agent is mid-turn — try again in a moment.'
            : data?.error === 'not-configured'
              ? 'Provider not configured — see Account → Agent.'
              : (data?.error ?? `Request failed (HTTP ${res.status}).`);
        fail(st, msg, restore);
      } else {
        paint(st);
      }
      return;
    }

    accepted = true;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          dispatch(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
    if (!completed) reconnect();
  } catch (err) {
    if (accepted && !completed) { reconnect(); return; }
    endTurn(st);
    if ((err as Error)?.name === 'AbortError') {
      st.items.push({ k: 'note', icon: 'stop', text: 'Stopped.' });
      paint(st);
      void refetch(st); // the server may have finished the turn anyway
      return;
    }
    fail(st, err instanceof Error ? err.message : 'network error', restore);
  } finally {
    st.abort = null;
    if (!st.remote) reloadHolds.delete(st.w.i);
    flushPendingLayout(); // a layout broadcast that landed mid-turn can go now
  }
}

function submit(st: State, ui: Ui): void {
  if (st.configured === false) return;
  const text = ui.input.value.trim();
  if (text.length > 8000) { toast('Your draft exceeds 8,000 characters. Shorten it before sending.'); return; }
  const mentions = activeMentions(text, st.mentions);
  if ((!text && !st.attachments.length) || st.uploading > 0 || st.clearing) return;
  for (const view of st.uis) view.follow = true;
  if (parseCommand(text)?.name === 'tasks') {
    setDraft(st, '');
    openTasks(st);
    return;
  }
  if (parseCommand(text)?.name === 'background') {
    setDraft(st, '');
    void background(st);
    return;
  }
  // Mid-turn (here or elsewhere), a message is a steer: it lands inside the
  // running turn and paints from its 'user' event. Commands stay commands.
  if ((st.busy || st.remote) && !text.startsWith('/')) {
    if (st.attachments.length) {
      toast('Send attached files after the current turn finishes. Your draft is saved.');
      return;
    }
    setDraft(st, '');
    st.mentions = [];
    void steer(st, text, mentions);
    return;
  }
  if (st.busy) return; // a command while this client streams — the server answers it, the stream stays
  setDraft(st, '');
  if (text) st.items.push({ k: 'msg', role: 'user', text: tagMentionMessage(text, mentions) });
  const sent = st.attachments;
  const file_ids = sent.map((a) => a.id);
  if (sent.length) st.items.push({ k: 'note', icon: 'attach', text: sent.map((a) => a.name).join(', ') });
  st.attachments = [];
  st.mentions = [];
  void post(st, { message: text, file_ids, ward_mentions: mentions, ward_ids: mentions.map(m => m.ward) }, { files: sent, mentions });
}

/** Steer the running turn. steered:false = it ended first, so send normally. */
async function steer(st: State, text: string, mentions: WardMention[] = []): Promise<void> {
  try { await flushMentionedWards(mentions.map(m => m.ward)); }
  catch (e) { fail(st, e instanceof Error ? e.message : 'Could not save ward context', { text, mentions }); return; }
  const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { message: text, ward_mentions: mentions, ward_ids: mentions.map(m => m.ward), mode: 'steer' });
  if (status === 200 && data?.steered) return;
  if (status === 200 && data && !st.busy) {
    st.items.push({ k: 'msg', role: 'user', text: tagMentionMessage(text, mentions) });
    void post(st, { message: text, ward_mentions: mentions, ward_ids: mentions.map(m => m.ward) }, { mentions });
    return;
  }
  fail(st, data?.error ?? 'could not reach the agent', { text, mentions });
}

/** The Stop button: the server ends the turn at its next round boundary. */
async function interrupt(st: State): Promise<void> {
  const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'interrupt' });
  if (status !== 200) fail(st, data?.error ?? 'could not stop the agent', {});
}

async function background(st: State): Promise<void> {
  const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'background' });
  if (status !== 200) { toast(data?.error ?? 'Could not background the task.'); return; }
  for (const task of data.tasks ?? []) updateTask(st, task);
  toast(data.forked ? 'The run continues in the background as a child run. You can keep chatting.' : data.tasks?.length ? 'Task continues in the background. You can keep chatting.' : 'Nothing is running.');
}

function updateTask(st: State, task: AgentTask): void {
  const before = st.tasks.find(t => t.id === task.id);
  st.tasks = [task, ...st.tasks.filter(t => t.id !== task.id)].slice(0, 100);
  if (task.background && !['running', 'stopping'].includes(task.state) && before?.state !== task.state) {
    if (!logVisible(st.w.i)) { unread.set(st.w.i, (unread.get(st.w.i) ?? 0) + 1); paintBadge(st.w.i); }
    tapToast(`Task ${task.state}: ${task.reason}`, () => openTasks(st));
  }
  paint(st);
}

/** Task controls fetch their own small surface; opening a drawer never runs a model. */
function openTasks(st: State): void {
  const { d, form, actions, submit } = dialog('Tasks');
  submit.remove();
  actions.querySelector('button')!.textContent = 'Close';
  form.onsubmit = e => e.preventDefault();
  const list = el('div', 'ag-task-list');
  actions.before(list);
  let selected: string | null = null, cursor = 0, result = false;
  let output: HTMLPreElement | null = null, more: HTMLButtonElement | null = null;
  let signature = '', fetching = false;
  const endpoint = `/api/agent/${encodeURIComponent(st.w.i)}?tasks=1`;
  const loadOutput = async () => {
    if (!selected || !output) return;
    const id = selected, from = cursor, final = result;
    const { status, data } = await getJson(`${endpoint}&task=${encodeURIComponent(id)}&cursor=${cursor}&output=${!result}`).catch(() => ({ status: 0, data: null }));
    if (selected !== id || from !== cursor || final !== result || !d.open) return;
    if (status !== 200) { output.textContent = data?.error ?? 'Could not read task output.'; return; }
    if (data.truncated) output.textContent += '\n[Earlier output is no longer retained]\n';
    output.textContent = (output.textContent + data.text).slice(result ? -128_000 : -64_000);
    cursor = data.next;
    more!.hidden = data.complete;
    output.dataset.empty = !output.textContent ? 'true' : 'false';
  };
  const refresh = async () => {
    if (!d.open || fetching) return;
    fetching = true;
    try {
      const { status, data } = await getJson(endpoint);
      if (!d.open) return;
      if (status !== 200) { if (!list.childElementCount) list.append(el('p', undefined, data?.error ?? 'Tasks unavailable.')); return; }
      st.tasks = data.tasks ?? []; paint(st);
      const next = JSON.stringify(st.tasks);
      if (next !== signature) {
        signature = next;
        list.replaceChildren();
        if (!st.tasks.length) list.append(el('p', undefined, 'No tasks yet. Press Ctrl+B while Rime works to keep the run going in the background, or ask Rime to delegate to a child run.'));
        for (const task of st.tasks) {
          const row = el('article', 'ag-task-row');
          const detail = el('div', 'ag-task-description');
          const status = el('span', 'ag-task-status');
          status.dataset.task = task.id;
          detail.append(el('strong', undefined, task.reason), status);
          if (task.error) detail.append(el('span', 'text-err', task.error));
          const rowActions = el('div', 'ag-task-actions');
          for (const final of [false, true]) {
            const button = el('button', 'btn', final ? 'Result' : 'Output'); button.type = 'button';
            button.onclick = () => {
              selected = task.id; cursor = 0; result = final;
              output ??= el('pre', 'ag-task-output');
              output.setAttribute('aria-label', final ? 'Task result' : 'Task output');
              output.dataset.placeholder = final ? 'The result will appear when the task finishes.' : 'No command output yet. Other tools report their result when finished.';
              output.textContent = '';
              more ??= el('button', 'btn', 'Load more'); more.type = 'button'; more.hidden = true;
              more.onclick = () => { void loadOutput(); };
              actions.before(output, more);
              void loadOutput();
            };
            rowActions.append(button);
          }
          if (task.state === 'running' && !task.background) {
            const detach = el('button', 'btn', 'Background'); detach.type = 'button';
            detach.onclick = async () => {
              detach.disabled = true;
              const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'background', task: task.id });
              if (status !== 200) { toast(data?.error ?? 'Could not background task.'); detach.disabled = false; }
              else { for (const task of data.tasks ?? []) updateTask(st, task); void refresh(); }
            };
            rowActions.append(detach);
          }
          if (task.cancellable) {
            const stop = el('button', 'btn', 'Stop'); stop.type = 'button'; stop.title = 'Stop this task; partial changes remain';
            stop.onclick = async () => {
              stop.disabled = true;
              const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'cancel-task', task: task.id });
              if (status !== 200) { toast(data?.error ?? 'Could not stop task.'); stop.disabled = false; }
              else { updateTask(st, data.task); void refresh(); }
            };
            rowActions.append(stop);
          }
          row.append(detail, rowActions); list.append(row);
        }
      }
      for (const status of list.querySelectorAll<HTMLElement>('.ag-task-status')) {
        const task = st.tasks.find(t => t.id === status.dataset.task)!;
        const age = Math.max(0, Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000));
        const route = task.tool === 'spawn_agent' && task.model ? ` · ${task.provider ?? ''}${task.endpoint ? `:${task.endpoint}` : ''} ${task.model}` : '';
        status.textContent = `${task.state}${task.background ? ' · background' : ''} · ${age}s · ${task.tool === 'spawn_agent' ? 'Child run' : humanise(task.tool)}${route}`;
      }
      if (selected && (!result || cursor === 0)) await loadOutput();
    } catch { if (!list.childElementCount) list.append(el('p', undefined, 'Connection lost. Reopen Tasks to retry.')); }
    finally { fetching = false; }
  };
  const timer = setInterval(() => { void refresh(); }, 2000);
  d.addEventListener('close', () => { clearInterval(timer); d.remove(); }, { once: true });
  void refresh();
}

function decide(st: State, action: 'confirm' | 'decline'): void {
  const pending = st.pending;
  if (!pending || st.busy) return;
  st.pending = null; // hide the bar immediately; the stream reports the outcome
  // …but a request that never landed (busy 409) leaves the confirm parked
  // server-side, so the bar has to come back or the retry is unclickable.
  void post(st, { action, confirmId: pending.confirmId }, { pending });
}

async function clearChat(st: State): Promise<void> {
  if (st.busy || st.remote || st.clearing || st.uploading) return;
  st.voice?.dispose();
  st.clearing = true;
  paint(st);
  const { ok, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'clear' });
  st.clearing = false;
  if (!ok) { fail(st, data?.error ?? 'Could not start a new chat. Try again.', {}); return; }
  st.items = [];
  st.pending = null;
  st.attachments = [];
  st.mentions = [];
  setDraft(st, '');
  for (const ui of st.uis) ui.follow = true;
  paint(st);
}

async function addFiles(st: State, picked: FileList | File[]): Promise<void> {
  if (st.configured === false) return;
  const list = Array.from(picked);
  if (!list.length) return;
  const form = new FormData();
  form.append('ward', st.w.i);
  for (const f of list) form.append('files', f);
  st.uploading += list.length;
  paint(st);
  try {
    const res = await fetch(`/api/agent/files?_ward=${encodeURIComponent(st.w.i)}`, { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      st.items.push({ k: 'note', err: true, text: `Upload failed${data?.error ? ` — ${data.error}` : ''}.` });
      return;
    }
    // Nothing is dropped quietly: a rejected file says why, by name.
    for (const f of data?.files ?? []) {
      if (f.ok && f.id) st.attachments.push({ id: f.id, name: String(f.name ?? 'file') });
      else st.items.push({ k: 'note', err: true, text: `${f.name ?? 'file'} — ${f.error ?? 'rejected'}` });
    }
  } catch {
    st.items.push({ k: 'note', err: true, text: 'Upload failed — network error.' });
  } finally {
    st.uploading -= list.length;
    paint(st);
  }
}

// ----------------------------------------------------------------- composer

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

/**
 * The slash-command completion menu, CLI conventions: it appears the moment you
 * type "/" at the start of the box, filters as you keep typing, and
 *   ↑/↓  move      Tab  complete (so you can add arguments)
 *   ⏎    run       Esc  dismiss
 *
 * The command list comes from lib/agent/commands.ts — the same module the
 * server parses with, so the menu can never offer something that does not run.
 */
function mentionSummary(type: string): string {
  if (type === 'browser') return 'Screenshot, active page, tabs and page text';
  if (type === 'note') return 'Note text and drawing';
  if (['editor', 'project-files', 'changes', 'terminal'].includes(type)) return 'Current project, file or terminal context';
  if (type === 'remote-desktop') return 'Computer and screen-access status';
  return 'Current ward content and settings';
}

function wireCommandMenu(ui: Ui, run: () => void, cur: () => State | undefined): void {
  const anchor = ui.input.parentElement!;
  anchor.style.position = 'relative'; // set here, not as a class — this is the one thing that needs it
  const menu = el('div', 'fd-cmd hidden');
  menu.setAttribute('role', 'listbox');
  menu.id = 'ag-commands-' + crypto.randomUUID();
  ui.input.setAttribute('aria-controls', menu.id);
  ui.input.setAttribute('aria-autocomplete', 'list');
  ui.input.setAttribute('aria-expanded', 'false');
  anchor.append(menu);

  let items: (CommandSpec | WardInstance)[] = [];
  let mentionStart = -1;
  let active = 0;
  const isOpen = () => !menu.classList.contains('hidden');

  function close(): void {
    menu.classList.add('hidden');
    ui.input.setAttribute('aria-expanded', 'false');
    ui.input.removeAttribute('aria-activedescendant');
  }

  function paint(): void {
    menu.replaceChildren();
    items.forEach((c, i) => {
      const row = el('button', `fd-cmd-row${i === active ? ' fd-cmd-active' : ''}`);
      row.type = 'button';
      row.id = `${menu.id}-${i}`;
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active));
      if ('i' in c) {
        row.classList.add('ag-mention-row');
        row.append(icon(CATALOG[c.type]?.icon ?? 'folder'));
        const label = el('span', 'ag-mention-label');
        label.append(el('span', 'fd-cmd-name', wardTitle(c)));
        const pages = readPages(), layout = readLayout();
        const page = pages.find(p => p.id === pageOf(c, pages, layout));
        label.append(el('span', 'ag-mention-detail', `${CATALOG[c.type]?.title ?? c.type} · ${page?.title ?? 'Page'}${c.hidden ? ' · Hidden' : ''} · ${c.i}`));
        row.append(label);
        row.title = mentionSummary(c.type);
      } else {
        row.append(el('span', 'fd-cmd-name', `/${c.name}`));
        if (c.args) row.append(el('span', 'fd-cmd-args', c.args));
        row.append(el('span', 'fd-cmd-desc', c.summary));
      }
      // mousedown, not click: the textarea must not lose focus before we act.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        active = i;
        pick(true);
      });
      menu.append(row);
    });
    ui.input.setAttribute('aria-activedescendant', `${menu.id}-${active}`);
    menu.scrollTop = 0;
    menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta: number): void {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length; // wraps, like a shell
    paint();
  }

  /** Tab completes and leaves you typing; Enter runs it. */
  function pick(now: boolean): void {
    const c = items[active];
    if (!c) return;
    if ('i' in c) {
      const st = cur();
      if (!st) return;
      const selected = activeMentions(ui.input.value, st.mentions);
      if (selected.length >= MAX_WARD_MENTIONS && !selected.some(m => m.ward === c.i)) {
        toast(`Mention up to ${MAX_WARD_MENTIONS} wards per message.`); return;
      }
      let title = wardTitle(c).replace(/\s+/g, ' ').trim();
      const layout = readLayout(), pages = readPages();
      const duplicates = layout.filter(w => wardTitle(w).replace(/\s+/g, ' ').trim() === title);
      if (duplicates.length > 1) {
        const page = pageOf(c, pages, layout);
        title += ` · ${pages.find(p => p.id === page)?.title ?? 'Page'}`;
        const samePage = duplicates.filter(w => pageOf(w, pages, layout) === page);
        if (samePage.length > 1) title += ` · ${samePage.findIndex(w => w.i === c.i) + 1}`;
      }
      const m = st.mentions.find(m => m.ward === c.i) ?? { ward: c.i, title };
      const token = `@${m.title} `;
      if (ui.input.value.length - (ui.input.selectionStart - mentionStart) + token.length > ui.input.maxLength) return;
      ui.input.setRangeText(token, mentionStart, ui.input.selectionStart, 'end');
      st.mentions = [...selected.filter(x => x.ward !== m.ward), m];
      close();
      ui.input.focus();
      setDraft(st, ui.input.value);
      return;
    }
    ui.input.value = now ? `/${c.name}` : `/${c.name} `;
    close();
    if (now) run();
    else {
      ui.input.focus();
      ui.input.dispatchEvent(new Event('input'));
    }
  }

  function sync(): void {
    if (ui.input.selectionStart !== ui.input.selectionEnd) { close(); return; }
    const before = ui.input.value.slice(0, ui.input.selectionStart);
    const match = /(?:^|[\s(])@([^@\n]*)$/.exec(before);
    mentionStart = match ? before.length - match[1]!.length - 1 : -1;
    if (match) {
      const query = match[1]!.toLocaleLowerCase().trim();
      const pages = readPages(), layout = readLayout();
      items = layout.filter(w => w.i !== cur()?.w.i &&
        `${wardTitle(w)} ${CATALOG[w.type]?.title} ${w.i} ${pages.find(p => p.id === pageOf(w, pages, layout))?.title ?? ''}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => Number(pageOf(b, pages, layout) === currentPage()) - Number(pageOf(a, pages, layout) === currentPage()));
    } else items = completeCommand(ui.input.value) ?? [];
    if (!items.length) { close(); return; }
    active = 0;
    menu.classList.remove('hidden');
    ui.input.setAttribute('aria-expanded', 'true');
    paint();
  }

  // Registered before the composer's own Enter handler, so it can claim the key.
  ui.input.addEventListener('keydown', (e) => {
    if (!isOpen() || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      e.stopImmediatePropagation(); // the send handler must not also fire
      pick(e.key === 'Enter');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });
  ui.input.addEventListener('input', sync);
  ui.input.addEventListener('click', sync);
  ui.input.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) sync(); });
  ui.input.addEventListener('blur', close);
  // Escape on a <dialog> closes it through the `cancel` event, which a keydown
  // preventDefault does not reach — so the menu would take the whole dialog with it.
  ui.input.closest('dialog')?.addEventListener('cancel', (e) => {
    if (isOpen()) {
      e.preventDefault();
      close();
    }
  });
}

/** Wire the shared listeners onto a view's composer. `cur` resolves the state
 *  at event time — the dialog rebinds wards without re-adding listeners. */
function wireComposer(ui: Ui, cur: () => State | undefined): void {
  const file = ui.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  let sending = false;
  const go = async () => {
    const st = cur();
    if (!st || sending) return;
    sending = true;
    try {
      if (st.voiceState && st.voiceState.mode !== 'off' && ['listening', 'finishing'].includes(st.voiceState.phase)) {
        await st.voice?.finishAndSend();
      } else {
        await st.voice?.finishDraft();
        if (cur() === st && ui.root.isConnected) submit(st, ui);
      }
    } finally { sending = false; }
  };
  ui.microphone.addEventListener('click', () => {
    const st = cur();
    if (!st) return;
    if (st.voiceState && st.voiceState.mode !== 'off') void st.voice?.finishAndSend();
    else if (st.voiceState?.phase === 'speaking') void st.voice?.stop();
    else if (st.voiceState && !['idle', 'error'].includes(st.voiceState.phase)) void st.voice?.finishDraft();
    else void voiceFor(st).dictate();
  });
  ui.voiceStop.addEventListener('click', () => { const st = cur(); if (st) void st.voice?.stop(); });
  ui.readResponses.addEventListener('change', () => { const st = cur(); if (st) void voiceFor(st).setReadResponses(ui.readResponses.checked); });
  ui.conversationMode.addEventListener('change', () => {
    const st = cur();
    if (st) void voiceFor(st).setConversation(ui.conversationMode.value as 'off' | 'finish-send' | 'hands-free');
  });
  // FIRST, so its keydown listener sees Enter/Tab/arrows before the send below.
  wireCommandMenu(ui, go, cur);
  ui.send.addEventListener('click', go);
  ui.background.addEventListener('click', () => { const st = cur(); if (st) void background(st); });
  ui.tasksButton.addEventListener('click', () => { const st = cur(); if (st) openTasks(st); });
  ui.root.addEventListener('keydown', e => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && !e.isComposing) {
      const st = cur();
      if (st && (st.busy || st.remote)) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) void background(st); }
    }
  });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 &&
        (!matchMedia('(pointer: coarse)').matches || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      go();
    }
  });
  ui.input.addEventListener('input', () => {
    const st = cur();
    if (st) { st.voice?.draftEdited(); setDraft(st, ui.input.value); }
  });
  ui.input.addEventListener('paste', e => {
    const st = cur();
    if (st && e.clipboardData?.files.length) {
      e.preventDefault();
      void addFiles(st, e.clipboardData.files);
    }
  });
  ui.log.addEventListener('scroll', () => {
    ui.follow = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 64;
    ui.jump.hidden = ui.follow;
  }, { passive: true });
  ui.jump.onclick = () => {
    ui.follow = true;
    ui.log.scrollTop = ui.log.scrollHeight;
    ui.jump.hidden = true;
  };
  ui.root.querySelector('[data-ag-clear]')?.addEventListener('click', () => {
    const st = cur();
    if (st) void clearChat(st);
  });
  ui.stop.addEventListener('click', () => {
    const st = cur();
    if (st) void interrupt(st);
  });
  file.addEventListener('change', () => {
    const st = cur();
    if (st && file.files?.length) void addFiles(st, file.files);
    file.value = '';
  });
  ui.root.querySelector('[data-ag-attach]')?.addEventListener('click', () => file.click());
  ui.pendingBox.querySelector('[data-ag-confirm]')!.addEventListener('click', () => {
    const st = cur();
    if (st) decide(st, 'confirm');
  });
  ui.pendingBox.querySelector('[data-ag-decline]')!.addEventListener('click', () => {
    const st = cur();
    if (st) decide(st, 'decline');
  });
  // Dropping files on the composer works like picking them.
  ui.root.addEventListener('dragover', (e) => e.preventDefault());
  ui.root.addEventListener('drop', (e) => {
    e.preventDefault();
    const st = cur();
    if (st && e.dataTransfer?.files.length) void addFiles(st, e.dataTransfer.files);
  });
}

/** Compact and expanded chat share the same controls and behavior. */
function createUi(root: HTMLElement, host: HTMLElement, status: HTMLElement): Ui {
  const context = el('span', 'ag-context');
  context.hidden = true;
  status.after(context);
  const stage = el('div', 'ag-stage');
  const log = el('div', 'ag-log');
  log.dataset.agLog = '';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Conversation');
  // Status has its own live region; do not re-announce the transcript on every tool event.
  log.setAttribute('aria-live', 'off');
  log.tabIndex = 0;
  const jump = el('button', 'ag-jump');
  const down = el('span', 'ag-jump-icon'); down.append(icon('right'));
  jump.append(down, document.createTextNode(' Latest')); jump.setAttribute('aria-label', 'Latest');
  jump.type = 'button';
  jump.hidden = true;
  stage.append(log, jump);
  const footer = el('div', 'ag-footer');
  const pendingBox = el('div', 'ag-approval hidden');
  pendingBox.setAttribute('role', 'status');
  const pendingText = el('span', 'ag-approval-text');
  const pendingDetails = el('details', 'ag-approval-text');
  pendingDetails.hidden = true;
  const pendingPatch = el('pre', 'font-mono whitespace-pre-wrap');
  pendingDetails.append(el('summary', 'cursor-pointer', 'Review patch'), pendingPatch);
  const approve = el('button', 'btn-primary', 'Confirm');
  approve.type = 'button'; approve.dataset.agConfirm = '';
  const decline = el('button', 'btn', 'Cancel');
  decline.type = 'button'; decline.dataset.agDecline = '';
  pendingBox.append(pendingText, pendingDetails, approve, decline);
  const form = el('form', 'ag-composer');
  form.addEventListener('submit', e => e.preventDefault());
  const chips = el('div', 'ag-chips hidden');
  const input = el('textarea', 'ag-input');
  input.rows = 1;
  input.maxLength = 8000;
  input.dataset.agInput = '';
  input.setAttribute('aria-label', 'Message Rime');
  const controls = el('div', 'ag-compose-controls');
  const attach = el('button', 'ag-icon-button');
  attach.type = 'button'; attach.dataset.agAttach = '';
  attach.title = 'Attach files'; attach.setAttribute('aria-label', 'Attach files');
  attach.append(icon('attach'));
  const file = el('input', 'hidden'); file.type = 'file'; file.multiple = true;
  const hint = el('span', 'ag-hint', '@ wards · / commands');
  const tasksButton = el('button', 'ag-icon-button ag-tasks-button');
  tasksButton.type = 'button'; tasksButton.append(icon('tasks'));
  const background = el('button', 'ag-icon-button hidden');
  background.type = 'button'; background.title = 'Run in background · Ctrl+B'; background.setAttribute('aria-label', 'Run in background');
  background.append(icon('right'));
  const stop = el('button', 'ag-icon-button ag-stop hidden');
  stop.type = 'button'; stop.title = 'Stop response'; stop.setAttribute('aria-label', 'Stop response');
  stop.append(icon('stop'));
  const send = el('button', 'ag-send');
  send.type = 'button'; send.title = 'Send message'; send.setAttribute('aria-label', 'Send message');
  send.append(icon('send'));
  const microphone = el('button', 'ag-icon-button');
  microphone.type = 'button'; microphone.append(icon('microphone'));
  microphone.title = 'Dictate message'; microphone.setAttribute('aria-label', 'Dictate message');
  const voiceStop = el('button', 'ag-icon-button');
  voiceStop.type = 'button'; voiceStop.hidden = true; voiceStop.append(icon('volume-off'));
  voiceStop.title = 'Stop voice · agent work continues'; voiceStop.setAttribute('aria-label', 'Stop voice');
  controls.append(attach, file, tasksButton, microphone, hint, voiceStop, background, stop, send);
  form.append(chips, input, controls);
  const help = el('p', 'ag-composer-help', matchMedia('(pointer: coarse)').matches ? 'Tap send when you’re ready' : 'Enter to send · Shift + Enter for a new line');
  const voiceStatus = el('p', 'ag-voice-status');
  voiceStatus.hidden = true; voiceStatus.setAttribute('role', 'status');
  const voiceOptions = el('div', 'ag-voice-options');
  const readLabel = el('label');
  const readResponses = el('input'); readResponses.type = 'checkbox';
  readLabel.append(readResponses, document.createTextNode('Read responses'));
  const modeLabel = el('label');
  const conversationMode = el('select'); conversationMode.setAttribute('aria-label', 'Voice conversation mode');
  for (const [value, label] of [['off', 'Off'], ['finish-send', 'Finish & Send'], ['hands-free', 'Hands-free']]) {
    const option = el('option', undefined, label); option.value = value!; conversationMode.append(option);
  }
  modeLabel.append(document.createTextNode('Conversation'), conversationMode);
  voiceOptions.append(readLabel, modeLabel);
  footer.append(pendingBox, form, voiceOptions, voiceStatus, help);
  host.append(stage, footer);
  return { root, log, input, send, stop, background, tasksButton, microphone, voiceStop, voiceStatus, readResponses, conversationMode, chips, pendingBox, pendingText, pendingDetails, pendingPatch, status, context, jump, follow: true, rendered: [] };
}

// ------------------------------------------------------------ shared dialog

let dialogWard: string | null = null;
let dialogUi: Ui | null = null;
let agentDialog: HTMLDialogElement | null = null;

function ensureDialog(): HTMLDialogElement | null {
  if (agentDialog) return agentDialog;
  const dlg = document.getElementById('agent-dialog') as HTMLDialogElement | null;
  if (!dlg) return null;
  agentDialog = dlg;
  const q = <T extends HTMLElement>(sel: string) => dlg.querySelector<T>(sel)!;
  const ui = createUi(dlg, q('[data-ag-body]'), q('[data-ag-status]'));
  dialogUi = ui;
  const cur = () => (dialogWard ? states.get(dialogWard) : undefined);
  wireComposer(ui, cur);
  q('[data-ag-history]').addEventListener('click', () => { const st=cur();if(st)void openHistory(st.w); });
  q('[data-ag-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    const st = cur();
    dialogWard = null;
    expandedDesktopWard();
    if (st) {
      st.uis.delete(ui);
      hideVoiceCapture(st);
      void refetch(st); // the ward view catches up on whatever happened
    }
  });
  return dlg;
}

function openDialog(st: State): void {
  const dlg = ensureDialog();
  if (!dlg || !dialogUi) return;
  if (dialogWard && dialogWard !== st.w.i) {
    const previous = states.get(dialogWard);
    previous?.uis.delete(dialogUi);
    if (previous) hideVoiceCapture(previous);
  }
  // The dialog is a singleton: a draft typed for one ward must never be sent
  // into another ward's conversation.
  dialogUi.input.value = st.draft;
  dialogUi.rendered = [];
  dialogUi.log.replaceChildren();
  dialogUi.follow = true;
  dialogUi.input.style.height = '';
  dialogWard = st.w.i;
  expandedDesktopWard(st.w.i);
  st.uis.add(dialogUi);
  const title = document.querySelector(`[data-wd="${st.w.i}"] [data-wd-title]`)?.textContent ?? 'Rime';
  dlg.querySelector('[data-ag-title]')!.textContent = title;
  dlg.showModal();
  clearUnread(st.w.i); // they're reading it now
  paint(st);
  autoGrow(dialogUi.input);
  if (!matchMedia('(pointer: coarse)').matches) dialogUi.input.focus();
}

// ------------------------------------------------------- automation notices
//
// A headless turn (a logic rule firing, a wake the agent scheduled) lands in a
// ward nobody is necessarily looking at. The badge is the trace that waits;
// the toast is the interrupt — and the SERVER decides which runs earn one (a
// rule opts out with notify:'silent'), so the client only honors the flag.
// The badge still counts a silenced run: quiet isn't the same as invisible.

interface AgentPing {
  ward?: string;
  source?: TurnSource;
  summary?: string;
  toast?: boolean;
}

const unread = new Map<string, number>();
/** In-flight step cards from a remote (headless) turn, keyed per ward. */
const remoteRuns = new Map<string, Run>();
window.addEventListener('fd:agent-reconnect', () => {
  for (const st of states.values()) if (!st.busy && st.uis.size) void refetch(st);
});

function paintBadge(ward: string): void {
  const span = document.querySelector<HTMLElement>(`[data-wd="${ward}"] .wd-status`);
  if (span) { span.replaceChildren(); if (unread.get(ward)) span.append(icon('flow'), document.createTextNode(String(unread.get(ward)))); }
}

function clearUnread(ward: string): void {
  if (!unread.has(ward)) return;
  unread.delete(ward);
  paintBadge(ward);
}

/** Is this ward's conversation actually in front of the user right now? One
 *  rect read at event time answers it — cheaper than an observer that would
 *  have to be created, kept and torn down per ward for a once-a-run question. */
function logVisible(ward: string): boolean {
  if (document.hidden) return false;
  if (dialogWard === ward && agentDialog?.open) return true;
  const b = body(ward);
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function announce(st: State, p: AgentPing): void {
  const summary = (p.summary ?? '').replace(/\s+/g, ' ').trim();
  const said = summary.length > 70 ? `${summary.slice(0, 69)}…` : summary || 'a turn ran on its own';
  tapToast(`Agent: ${said}`, () => openDialog(st));
}

// ------------------------------------------------------------------ renderer

// A ward added in edit mode renders before Done saves the layout, and the
// server resolves the ward against the STORED layout. The save itself is the
// signal (edit.ts fires 'fd:layout-saved') — however long the user takes over
// Done. The timer is only a fallback for a save this tab didn't make.
const unsaved = new Map<string, WardInstance>();
const saveRetries = new Map<string, number>();

document.addEventListener('fd:layout-saved', () => {
  for (const [id, w] of [...unsaved]) {
    if (!body(id)) unsaved.delete(id); // ward went away — stop chasing it
    else void renderAgent(w);
  }
});

function historyButton(w:WardInstance) {
  const button=el('button','ag-icon-button');button.type='button';button.dataset.agHistory='';button.title='Chat history and sync';button.setAttribute('aria-label','Chat history');button.append(icon('history'));
  button.onclick=()=>void openHistory(w);
  return button;
}
async function openHistory(w:WardInstance) {
  const {d,form,actions,error,submit}=dialog('Rime history');submit.hidden=true;
  const close=actions.querySelector('button');if(close)close.textContent='Close';
  const content=el('div','ag-history');form.insertBefore(content,actions);
  d.addEventListener('close',()=>d.remove(),{once:true});
  const failure=(e:unknown)=>{error.hidden=false;error.textContent=e instanceof Error?e.message:String(e);};
  content.textContent='Loading your chats…';
  try{
    const {status,data}=await getJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}`);if(status!==200)throw Error(data?.error??'Could not load history.');
    content.replaceChildren();
    const state=data.sync;
    content.append(el('p','muted',state?.server?`${state.online?'Up to date':'Working offline'}${state.error?` · ${state.error}`:''}`:'Your conversations'));
    const list=el('div','ag-history-list');content.append(list);
    const open=async(key:string)=>{
      const {data:chat,status}=await getJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}&key=${encodeURIComponent(key)}`);if(status!==200||!chat)throw Error('Conversation unavailable.');
      list.replaceChildren(el('h3',undefined,chat.title));
      for(const m of chat.messages){const msg=el('div','ag-history-message');msg.append(el('strong',undefined,m.role==='user'?'You':'Rime'),markdown(m.text));list.append(msg);}
      submit.hidden=false;submit.textContent='Continue here';
      list.append(el('p','muted','Continues a copy here. The original chat and any work running there are preserved.'));
      form.onsubmit=async(e)=>{e.preventDefault();submit.disabled=true;try{const {ok,data}=await postJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}`,{ward:w.i,key});if(!ok)throw Error(data?.error??'Could not continue chat.');d.close();await renderAgent(w);}catch(e){failure(e);}finally{submit.disabled=false;}};
    };
    for(const chat of data.chats??[]){const b=el('button','btn ag-history-row');b.type='button';b.append(el('strong',undefined,chat.title),el('small','muted',chat.device));b.onclick=()=>void open(chat.key).catch(failure);list.append(b);}
    if(!data.chats?.length)list.append(el('p','muted','Your conversations will appear here.'));
    for(const saved of state?.conflicts??[]){
      const b=el('button','btn ag-history-row',`Recovered version · ${saved.key}`);b.type='button';list.append(b);
      b.onclick=()=>void(async()=>{
        const {data:copy,status}=await getJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}&conflict=${saved.id}`);if(status!==200)throw Error('Recovery version unavailable.');
        const value=JSON.parse(copy.payload);let text='Deleted locally';
        if(typeof value==='string'){try{text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)));}catch{text='Binary agent file — this version can be restored.';}}
        else if(value)text=JSON.stringify(value,null,2);
        list.replaceChildren(el('h3',undefined,copy.key),el('pre','ag-history-message',text));
        submit.hidden=!(copy.key.startsWith('work/')||copy.key==='instance/dashboard'||copy.key.startsWith('appearance/image/'));submit.textContent='Restore this version';
        form.onsubmit=async(e)=>{e.preventDefault();submit.disabled=true;try{const {ok,data}=await postJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}`,{conflict:saved.id});if(!ok)throw Error(data?.error??'Could not restore.');d.close();}catch(e){failure(e);}finally{submit.disabled=false;}};
      })().catch(failure);
    }
  }catch(e){failure(e);}
}

async function renderAgent(w: WardInstance): Promise<void> {
  ensureStream();
  const st = stateFor(w);
  const revision = st.revision;
  const refresh = ++st.refresh;
  const { status, data } = await getJson(`/api/agent/${encodeURIComponent(w.i)}`).catch(() => ({ status: 0, data: null }));
  if (st.refresh !== refresh) return;
  const b = body(w.i);
  if (!b) return;
  const mounted = [...st.uis].some(ui => b.contains(ui.root));
  if (mounted && (status !== 200 || !data)) return; // Keep the last usable view through a transient outage.
  if (status === 400) {
    note(w.i, 'Save the layout first.');
    unsaved.set(w.i, w);
    const tries = (saveRetries.get(w.i) ?? 0) + 1;
    saveRetries.set(w.i, tries);
    if (tries <= 6) setTimeout(() => body(w.i) && void renderAgent(w), 3000);
    return;
  }
  unsaved.delete(w.i);
  saveRetries.delete(w.i);
  if (status !== 200 || !data) {
    const unavailable = el('div', 'ag-empty');
    const retry = el('button', 'btn', 'Try again');
    retry.type = 'button';
    retry.onclick = () => { retry.disabled = true; void renderAgent(w); };
    unavailable.append(el('h3', undefined, 'Couldn’t load this conversation'), el('p', undefined, 'Check your connection and try again.'), retry);
    b.replaceChildren(unavailable);
    return;
  }
  st.sharedStatus=data.sync?.server?data.sync.online?'Rime':'Rime · working offline':undefined;
  st.configured = data.configured;
  st.context = data.context ?? undefined;
  if (!data.configured && !data.transcript?.length && !data.tasks?.length && !st.items.length && !st.busy && !st.remote) {
    const setup = el('div', 'ag-empty ag-setup');
    const mark = el('div', 'ag-empty-mark');
    mark.append(icon('sparkle'));
    const link = el('a', 'btn', 'Set up your agent');
    link.href = '/account#agent';
    setup.append(mark, el('h3', undefined, 'Meet your workspace agent'),
      el('p', undefined, data.sync?.server ? `Your Rime files and history are available locally. ${data.sync.error ?? 'The server is offline.'} Connect a local provider in Account to run Rime without the server.` : `Connect ${data.provider === 'codex' ? 'Codex' : 'OpenRouter'} in Account to start a conversation with Rime.`), link, historyButton(w));
    b.replaceChildren(setup);
    return;
  }

  // A rerender mid-stream must not clobber the live turn's log.
  st.tasks = data.tasks ?? st.tasks;
  if (!st.busy && st.revision === revision) {
    if (!st.remote || !data.busy) st.items = itemsFrom(data.transcript ?? []);
    st.pending = data.pending ?? null;
    st.remote = !!data.busy; // a turn already running when this client loaded
    if (st.remote && !st.items.some(it => it.k === 'thinking' || (it.k === 'step' && it.running))) st.items.push({ k: 'thinking' });
  }
  if (mounted) { paint(st); return; }

  // The ward chrome: log + pending bar + composer, body flex-managed.
  b.textContent = '';
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
  const wrap = el('div', 'ag-shell');
  const top = el('div', 'ag-toolbar');
  const statusLine = el('span', 'ag-status');
  statusLine.setAttribute('role', 'status');
  const fresh = el('button', 'ag-icon-button');
  fresh.type = 'button';
  fresh.dataset.agClear = '';
  fresh.title = 'New chat · archives the current conversation';
  fresh.setAttribute('aria-label', 'New chat');
  fresh.append(icon('plus'));
  const expand = el('button', 'ag-icon-button');
  expand.type = 'button';
  expand.title = 'Expand chat';
  expand.setAttribute('aria-label', 'Expand chat');
  expand.append(icon('resize'));
  top.append(statusLine, historyButton(w), fresh, expand);
  const content = el('div', 'ag-body');
  wrap.append(top, content);
  b.append(wrap);
  const ui = createUi(wrap, content, statusLine);
  st.uis.add(ui);
  ui.input.value = st.draft;
  wireComposer(ui, () => states.get(w.i));
  expand.addEventListener('click', () => openDialog(stateFor(w)));
  restoreExpandedWard(w.i, () => openDialog(stateFor(w)));
  // Touching the ward at all counts as having seen it.
  wrap.addEventListener('pointerdown', () => clearUnread(w.i));
  paint(st);
  paintBadge(w.i); // a grid rebuild blanks the header span; the count outlives it
  if (st.revision !== revision && !st.busy) void refetch(st);
}

function watchAgent(ward: string): void {
  // Headless runs (a logic rule, a scheduled wake) broadcast 'agent' over the
  // logic stream. The payload says who asked and whether it earns an interrupt.
  onAgentPing(ward, (p?: AgentPing) => {
    const live = states.get(ward);
    if (!live) return;
    const headless = !!p && !!p.source && p.source !== 'chat';
    // A silenced rule still owes the user a trace — quiet isn't invisible.
    if (headless && !logVisible(ward)) {
      unread.set(ward, (unread.get(ward) ?? 0) + 1);
      paintBadge(ward);
    }
    if (headless && p!.toast) announce(live, p!);
    // The turn is over: the stored transcript is the record now.
    remoteRuns.delete(ward);
    live.revision++;
    live.remote = false;
    if (!live.busy) void refetch(live, true);
  });

  // Every turn — chat, automation or wake — mirrors its stream frames as
  // 'agent-live'. This is what makes one thread look the same in every open
  // client at the same moment; the settle ping then reconciles against storage.
  onAgentLive(ward, (d) => {
    const live = states.get(ward);
    if (live && d?.event?.type === 'task') { updateTask(live, d.event.task); return; }
    if (!live || live.busy || !d) return; // this client's own stream owns the log
    let running = remoteRuns.get(ward);
    if (!running) { running = newRun(); remoteRuns.set(ward, running); }
    if (d.event?.type === 'end') {
      // The turn died without settling — no ping is coming, so release here.
      remoteRuns.delete(ward);
      live.revision++;
      live.remote = false;
      for (const it of live.items) if (it.k === 'step') it.running = false;
      live.items = live.items.filter((it) => it.k !== 'thinking');
      if (d.event.error) live.items.push({ k: 'note', err: true, text: d.event.error });
      paint(live);
      flushPendingLayout();
      return;
    }
    live.remote = true;
    const src: TurnSource = d.source === 'wake' || d.source === 'automation' || d.source === 'agent' ? d.source : 'chat';
    if (applyEvent(live, running, d.event, src)) paint(live);
  });
}

// ------------------------------------------------------------------- registry

RENDERERS.agent = { render: (w) => renderAgent(w), preserveBody: true, stop: id => states.get(id)?.voice?.dispose() }; // event-driven — no poll
