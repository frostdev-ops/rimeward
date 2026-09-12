import { readSse } from '../../lib/agent/stream.ts';
import type { LiveTurn } from '../../lib/agent/live-turn.ts';
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
import type { UserQuestion, PendingQuestion, UserAnswer } from '../../lib/agent/questions.ts';
import type { TranscriptMsg } from '../../lib/agent/conversations.ts';
import { AGENT_EFFORTS, CATALOG, pageOf, wardTitle, type AgentEffort, type AgentProviderId, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body, note, readLayout } from './wards.ts';
import { el, getJson, postJson, tapToast, toast } from './dom.ts';
import { icon } from './icon.ts';
import { popupFrame, popupLayer, popupViewport } from './popup-layer.ts';
import { currentPage, readPages } from './pages.ts';
import { activeMentions, mentionPattern, tagMentionMessage, plainMentionText, MAX_WARD_MENTIONS, type WardMention } from '../../lib/agent/mentions.ts';
import { dialog } from './workspace-dialogs.ts';
import '../../styles/conversation.css';
import { ensureStream, flushPendingLayout, onAgentLive, onAgentPing, reloadHolds, type AgentLive } from './logic.ts';

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
function animateDetails(detail: HTMLDetailsElement) {
  let animation: Animation | undefined, closing = false;
  detail.querySelector('summary')!.addEventListener('click', event => {
    if (reducedMotion()) return;
    event.preventDefault();
    const body = detail.querySelector<HTMLElement>('.ag-step-details')!;
    const open = !detail.open || closing, from = detail.open ? body.getBoundingClientRect().height : 0;
    animation?.cancel(); closing = !open; detail.open = true;
    animation = body.animate([{ height: `${from}px`, opacity: open ? 0 : 1 }, { height: `${open ? body.scrollHeight : 0}px`, opacity: open ? 1 : 0 }], { duration: 200, easing: 'ease-out' });
    const current = animation;
    void current.finished.then(() => { if (animation === current) { detail.open = open; closing = false; animation = undefined; } }).catch(() => {});
  });
}

function stepCard(step: Step, running = false, ward = ''): HTMLElement {
  const row = el('details', 'ag-activity ag-step');
  row.dataset.running = String(running); row.dataset.error = String(!!step.error);
  row.open = !!step.error;
  const head = el('summary');
  const mark = el('span', running ? 'ag-working-mark' : 'ag-activity-mark');
  mark.append(icon(running ? 'rime' : step.error ? 'warning' : 'check'));
  head.title = step.tool;
  head.append(mark, el('span', 'ag-step-reason', step.reason || humanise(step.tool)));
  if (!running && step.ms !== undefined) head.append(el('span', 'ag-step-time', fmtMs(step.ms)));
  row.append(head);
  const body = el('div', 'ag-step-details');
  if (typeof step.args?.device === 'string') body.append(el('small', 'muted', `Computer: ${step.args.device}`));
  if (step.result && typeof step.result === 'object' && 'background' in step.result && step.result.background)
    body.append(el('small', 'muted', 'Background task'));
  const args = { ...(step.args ?? {}) }; delete args.reason;
  const text = `${step.tool}(${Object.keys(args).length ? JSON.stringify(args, null, 1) : ''})` +
    (step.result !== undefined ? `\n\n${typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 1)}` : running ? '\n\nRunning…' : '');
  body.append(el('pre', 'ag-step-output', text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated for display)` : text));
  if (step.error) body.prepend(el('p', 'ag-step-error', step.error));
  if (['computer_screenshot', 'computer_app_state', 'computer_app_input', 'render_document_page'].includes(step.tool) && step.result && typeof step.result === 'object' &&
      'image_sha256' in step.result && typeof step.result.image_sha256 === 'string' && /^[a-f0-9]{64}$/.test(step.result.image_sha256)) {
    const image = el('img', 'ag-step-image'); image.alt = step.tool === 'render_document_page' ? 'Rime PDF page' : 'Rime computer screenshot'; image.loading = 'lazy';
    image.src = `/api/agent/files?sha=${step.result.image_sha256}&_ward=${encodeURIComponent(ward)}`; body.append(image);
  }
  row.append(body);
  animateDetails(row);
  return row;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// -------------------------------------------------------------------- state

interface Pending {
  confirmId: string;
  summary: string;
  patch?: string;
  question?: UserQuestion;
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
  | { k: 'msg'; role: 'user' | 'assistant'; text: string; src?: TurnSource; id?: string; streaming?: boolean; incomplete?: boolean }
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
  /** The footer's provider / model / effort pickers (paintPicker fills them). */
  picker: { root: HTMLElement; provider: HTMLSelectElement; model: HTMLSelectElement; effort: HTMLSelectElement };
  chips: HTMLElement;
  pendingBox: HTMLElement;
  pendingText: HTMLElement;
  pendingDetails: HTMLDetailsElement;
  pendingPatch: HTMLElement;
  questionBox: HTMLElement;
  questionId?: string;
  status: HTMLElement;
  /** How full the thread is, next to the status line. */
  context: HTMLElement;
  jump: HTMLButtonElement;
  follow: boolean;
  restored?: boolean;
  rendered: { key?: string; signature: string; node: HTMLElement }[];
  scroll?: ReturnType<typeof followLog>;
  visibility?: IntersectionObserver;
  live?: boolean;
}

type LogUi = Pick<Ui, 'root' | 'log' | 'input' | 'rendered' | 'jump' | 'follow' | 'live' | 'restored' | 'scroll'>;

interface State {
  task?: string;
  reloadLive?: () => void;
  conversation?: number;
  run?: string;
  frame?: number;
  w: WardInstance;
  items: Item[];
  pending: Pending | null;
  question?: PendingQuestion | null;
  questionDrafts?: Map<string, UserAnswer>;
  questionSubmitting?: boolean;
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
  childDrafts?: Map<string, { text: string; questionId?: number }>;
  mentions: WardMention[];
  clearing: boolean;
  tasks: AgentTask[];
  sharedStatus?: string;
  configured?: boolean;
  context?: ContextUsage;
  /** What the footer pickers offer, loaded per ward config (see loadCatalog). */
  catalog?: Catalog;
  /** A picker choice is being saved. */
  switching?: boolean;
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

// ------------------------------------------------------------ model pickers
//
// The footer's Provider / Model / Effort selects. What they show is the ward's
// EFFECTIVE route — /api/agent/models?ward= resolves the inherited defaults the
// same way a turn does — and a pick is stored on the ward through the ordinary
// layout save, so every tab and the ⚙ dialog see it. A provider (or endpoint)
// change retires the thread, exactly as the ⚙ dialog's does; the confirm says so.

interface Catalog {
  /** The ward + config the load was for; a mismatch reloads. */
  key: string;
  loading: boolean;
  error?: string;
  source?: string;
  /** The account's default provider. */
  default?: AgentProviderId;
  current?: { provider: AgentProviderId; endpoint?: string; model: string; effort: AgentEffort };
  providers: { provider: AgentProviderId; name: string; configured: boolean; default?: string }[];
  endpoints: string[];
  models: { id: string; name?: string; efforts?: string[] }[];
}

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
/** The ⚙ dialog's short provider names; the footer has no room for the long ones. */
const PROVIDER_SHORT: Record<string, string> = { codex: 'Codex', openrouter: 'OpenRouter', openai: 'OpenAI API' };
const routeOf = (provider: string, endpoint?: string) => (provider === 'compat' ? `compat:${endpoint ?? ''}` : provider);
const catalogKey = (st: State) => {
  const c = (st.w.config ?? {}) as Record<string, unknown>;
  return JSON.stringify([st.w.i, c.provider, c.endpoint, c.model, c.effort]);
};

async function loadCatalog(st: State): Promise<void> {
  const key = catalogKey(st);
  if (st.catalog?.key === key) return;
  const cat: Catalog = { key, loading: true, current: st.catalog?.current, providers: st.catalog?.providers ?? [], endpoints: st.catalog?.endpoints ?? [], models: [] };
  st.catalog = cat;
  paint(st);
  const { status, data } = await getJson(`/api/agent/models?ward=${encodeURIComponent(st.w.i)}`).catch(() => ({ status: 0, data: null }));
  if (st.catalog !== cat) return; // a newer config superseded this load
  cat.loading = false;
  if (data && typeof data === 'object') {
    cat.current = data.current ?? undefined;
    cat.default = data.default;
    cat.providers = Array.isArray(data.providers) ? data.providers : [];
    cat.endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
    cat.models = Array.isArray(data.models) ? data.models : [];
    cat.source = data.source;
    if (typeof data.error === 'string') cat.error = data.error;
  }
  if (!cat.current) cat.error ??= status ? `Model settings unavailable (${status})` : 'Model settings unavailable';
  if (cat.error && !cat.models.length) cat.key = ''; // try again on the next repaint data
  paint(st);
}

/** Rebuild a select's options only when the list changed; a paint mid-turn must
 *  not churn a 300-row OpenRouter list (SearchSelect re-syncs on every mutation). */
function setOptions(select: HTMLSelectElement, rows: { value: string; label: string; disabled?: boolean }[]): void {
  const same = select.options.length === rows.length && rows.every((r, i) => { const o = select.options[i]!; return o.value === r.value && o.textContent === r.label && o.disabled === !!r.disabled; });
  if (same) return;
  select.replaceChildren(...rows.map((r) => { const o = new Option(r.label, r.value); o.disabled = !!r.disabled; return o; }));
}

function paintPicker(st: State, ui: Ui): void {
  const c = st.catalog;
  const p = ui.picker;
  const cur = c?.current;
  p.root.hidden = !c || (!c.loading && !cur);
  if (!c) return;
  const cfg = (st.w.config ?? {}) as Record<string, unknown>;
  const working = st.busy || st.remote || st.clearing || !!st.switching || c.loading;
  // The ward's footer is one row wide at most — the "· default" marker rides the label titles there.
  const compact = ui.root.classList.contains('ag-shell');
  const mark = (isDefault: boolean) => (isDefault && !compact ? ' · default' : '');
  // Provider: every provider the account knows, each endpoint its own row; a
  // provider that is not connected is listed but not pickable.
  const route = cur ? routeOf(cur.provider, cur.endpoint) : '';
  const providers: { value: string; label: string; disabled?: boolean }[] = c.providers.flatMap((pr) => pr.provider === 'compat'
    ? c.endpoints.map((e) => ({ value: routeOf('compat', e), label: `Endpoint · ${e}` }))
    : [{ value: pr.provider, label: `${PROVIDER_SHORT[pr.provider] ?? pr.name}${mark(pr.provider === c.default)}${pr.configured ? '' : ' · not connected'}`, disabled: !pr.configured }]);
  if (route && !providers.some((r) => r.value === route)) providers.unshift({ value: route, label: cur!.endpoint ?? cur!.provider });
  if (!providers.length) providers.push({ value: '', label: '…', disabled: true });
  setOptions(p.provider, providers);
  p.provider.disabled = working; // before the value write: SearchSelect mirrors disabled onto its trigger there
  p.provider.value = route;
  p.provider.parentElement!.title = cur ? (cfg.provider && cfg.provider !== 'default' ? 'Provider · set on this ward' : 'Provider · the account default') : '';
  // Model: the catalog's list for the current route, the current id kept even
  // when the list does not carry it (a stale or fallback list is never authoritative).
  const fallback = c.providers.find((pr) => pr.provider === cur?.provider)?.default;
  const models: { value: string; label: string; disabled?: boolean }[] = c.models.map((m) => ({ value: m.id, label: `${m.name && m.name !== m.id ? `${m.name} · ` : ''}${m.id}${mark(m.id === fallback)}` }));
  if (cur?.model && !models.some((m) => m.value === cur.model)) models.unshift({ value: cur.model, label: cur.model });
  if (!cur?.model) models.unshift({ value: '', label: c.loading ? '…' : 'Choose a model…', disabled: true });
  setOptions(p.model, models);
  p.model.disabled = working || models.length < 2;
  p.model.value = cur?.model ?? '';
  p.model.parentElement!.title = c.error ? `Model · ${c.error}` : cfg.model ? 'Model · set on this ward' : `Model · the provider default${c.source === 'fallback' ? ' · list is the built-in fallback' : ''}`;
  // Effort: what the model advertises (codex lists them), else every level; the
  // current value stays listed so the control never lies about it.
  const known = c.models.find((m) => m.id === cur?.model);
  const levels = [...(known?.efforts?.length ? known.efforts : AGENT_EFFORTS)];
  if (cur?.effort && !levels.includes(cur.effort)) levels.unshift(cur.effort);
  setOptions(p.effort, levels.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e })));
  p.effort.disabled = working || !cur;
  p.effort.value = cur?.effort ?? '';
  p.effort.parentElement!.title = cfg.effort ? 'Reasoning effort · set on this ward' : 'Reasoning effort · the default';
}

function confirmSwitch(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { d, form, actions, submit } = dialog('Switch provider?');
    submit.textContent = 'Switch';
    actions.before(el('p', 'muted', `Rime runs on ${name} from your next message. That starts a new chat here — the current one is archived, like New chat does.`));
    let ok = false;
    form.onsubmit = (e) => { e.preventDefault(); ok = true; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(ok); }, { once: true });
  });
}

/** Store a pick on the ward. The route is pinned with it — a model or an effort
 *  only means something on the provider it was chosen for — and the ordinary
 *  layout save carries it, so the push repaints every tab and the ⚙ dialog agrees. */
async function saveSelection(st: State, patch: { provider?: AgentProviderId; endpoint?: string; model?: string | null; effort?: AgentEffort }): Promise<void> {
  if (st.switching || st.busy || st.remote || st.clearing) return;
  const cur = st.catalog?.current;
  if (!cur) return;
  if (document.querySelector('.wd-grid.editing')) { toast('Finish editing the layout first.', undefined, true); paint(st); return; }
  const layout = readLayout();
  const w = layout.find((x) => x.i === st.w.i);
  if (!w) { toast('Save the layout first.', undefined, true); paint(st); return; }
  const config: Record<string, unknown> = { ...(w.config ?? {}) };
  config.provider = patch.provider ?? cur.provider;
  if (config.provider === 'compat') config.endpoint = patch.endpoint ?? cur.endpoint;
  else delete config.endpoint;
  if ('model' in patch) { if (patch.model) config.model = patch.model; else delete config.model; }
  if (patch.effort) config.effort = patch.effort;
  w.config = config;
  st.switching = true;
  paint(st);
  const { ok, data } = await postJson('/api/dashboard', { layout }, 'PUT');
  st.switching = false;
  if (!ok) { toast(typeof data?.error === 'string' ? `Could not save: ${data.error}` : 'Could not save the model choice.', undefined, true); paint(st); return; }
  // Repaint now rather than waiting for the layout push: the GET behind it is
  // what retires the thread on a provider change and reloads the transcript.
  await renderAgent(w);
}

async function pickRoute(st: State, value: string): Promise<void> {
  const cur = st.catalog?.current;
  if (!cur || !value || value === routeOf(cur.provider, cur.endpoint)) { paint(st); return; }
  const compat = value.startsWith('compat:');
  const provider = (compat ? 'compat' : value) as AgentProviderId;
  const endpoint = compat ? value.slice(7) : undefined;
  const name = endpoint ? `endpoint "${endpoint}"` : PROVIDER_SHORT[provider] ?? st.catalog!.providers.find((p) => p.provider === provider)?.name ?? provider;
  // An empty thread has nothing to archive — switch without asking.
  if (st.items.length && !(await confirmSwitch(name))) { paint(st); return; }
  await saveSelection(st, { provider, endpoint, model: null });
}

function hideVoiceCapture(st: State) {
  if (![...st.uis].some(ui => ui.root.isConnected && ui.root.getClientRects().length > 0)) void st.voice?.viewHidden();
}
window.addEventListener('fd:page', () => { for (const st of states.values()) hideVoiceCapture(st); });
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('ag-page-hidden', document.hidden);
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
  button.dataset.copyText = text;
  button.onclick = async event => {
    const button = event.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(button.dataset.copyText ?? '');
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

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function arrive(node: HTMLElement) {
  if (!reducedMotion() && !document.hidden && node.getClientRects().length)
    node.animate([{ opacity: 0, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: 180, easing: 'ease-out' });
}

/** Patch safe, renderer-created DOM; preserve details, focus and existing text nodes. */
function patchDom(old: Node, fresh: Node, reveal = false): void {
  if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) { old.parentNode?.replaceChild(fresh, old); return; }
  if (old instanceof Text) {
    const value = fresh.textContent ?? '';
    if (value.startsWith(old.data)) old.appendData(value.slice(old.data.length));
    else if (old.data !== value) old.data = value;
    return;
  }
  if (!(old instanceof Element) || !(fresh instanceof Element)) return;
  const wasError = old.getAttribute('data-error') === 'true';
  for (const attr of [...old.attributes]) if (attr.name !== 'open' && !fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name);
  for (const attr of [...fresh.attributes]) if (attr.name !== 'open' && old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
  if (old instanceof HTMLDetailsElement && fresh instanceof HTMLDetailsElement && fresh.open && !wasError) old.open = true;
  if (old instanceof HTMLElement && fresh instanceof HTMLElement && fresh.onclick) old.onclick = fresh.onclick;
  // Streaming plain text grows without replacing the preceding selection.
  if (fresh.childNodes.length === 1 && fresh.firstChild instanceof Text &&
      [...old.childNodes].every(n => n instanceof Text || n instanceof HTMLElement && n.dataset.reveal === 'true')) {
    const text = fresh.textContent ?? '', previous = old.textContent ?? '';
    if (text === previous) return;
    if (text.startsWith(previous)) {
      const next = document.createTextNode(text.slice(previous.length));
      if (reveal && !reducedMotion() && !document.hidden) {
        const span = el('span'); span.dataset.reveal = 'true'; span.append(next); old.append(span);
        const animation = span.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 180 });
        void animation.finished.then(() => { span.replaceWith(...span.childNodes); old.normalize(); }).catch(() => {});
      } else old.append(next);
      return;
    }
  }
  const children = [...fresh.childNodes];
  children.forEach((node, i) => {
    const current = old.childNodes[i];
    if (current) patchDom(current, node, reveal);
    else { old.append(node); if (reveal && node instanceof HTMLElement) arrive(node); }
  });
  while (old.childNodes.length > children.length) old.lastChild!.remove();
}

const proseParts = new WeakMap<HTMLElement, { source: string; node: HTMLElement }[]>();
function paintProse(prose: HTMLElement, text: string, reveal: boolean) {
  // Blank lines close a block, except inside a fenced code block. Only changed
  // chunks are parsed; a long completed answer never rebuilds on a tool tick.
  const parts: string[] = []; let start = 0, offset = 0, fenced = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    offset += line.length + 1;
    if (!fenced && !line.trim()) { parts.push(text.slice(start, Math.min(offset, text.length))); start = offset; }
  }
  if (start < text.length) parts.push(text.slice(start));
  const previous = proseParts.get(prose) ?? [];
  const next = parts.map((source, i) => {
    const old = previous[i];
    if (old?.source === source) return old;
    const fresh = el('div', 'ag-prose-part'); fresh.append(markdown(source));
    if (old) { patchDom(old.node, fresh, reveal); return { source, node: old.node }; }
    prose.append(fresh); if (reveal) arrive(fresh);
    return { source, node: fresh };
  });
  previous.slice(parts.length).forEach(part => part.node.remove()); proseParts.set(prose, next);
}

function bubble(role: 'user' | 'assistant', text: string): HTMLElement {
  const wrap = el('article', `ag-message ag-${role}`);
  wrap.setAttribute('aria-label', role === 'user' ? 'You' : 'Assistant');
  const inner = el('div', 'ag-prose');
  if (role === 'user') appendMentionText(text, inner); else paintProse(inner, text, false);
  const actions = el('div', 'ag-message-actions'); actions.append(copyButton(plainMentionText(text), 'Copy message'));
  wrap.append(inner, actions); return wrap;
}

function updateBubble(node: HTMLElement, item: Extract<Item, { k: 'msg' }>, st: State, reveal: boolean) {
  const message = node.matches('.ag-message') ? node : node.querySelector<HTMLElement>('.ag-message')!;
  if (item.role === 'assistant') paintProse(message.querySelector<HTMLElement>('.ag-prose')!, item.text, reveal);
  message.dataset.streaming = String(!!item.streaming);
  message.dataset.incomplete = String(!!item.incomplete);
  message.querySelector<HTMLButtonElement>('.ag-copy')!.dataset.copyText = plainMentionText(item.text);
  const actions = message.querySelector<HTMLElement>('.ag-message-actions')!;
  let read = actions.querySelector<HTMLButtonElement>('[data-read]');
  if (item.role === 'assistant' && !read) {
    read = el('button', 'ag-copy'); read.type = 'button'; read.dataset.read = '';
    read.title = 'Read this message aloud'; read.setAttribute('aria-label', 'Read this message aloud');
    read.append(icon('volume'), el('span', undefined, 'Read aloud')); actions.append(read);
  }
  if (read) { read.disabled = !!item.streaming; read.onclick = () => { void voiceFor(st).speak(item.text); }; }
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

function emptyState(st: State, ui: Pick<Ui, 'input'>): HTMLElement {
  const wrap = el('div', 'ag-empty');
  const mark = el('div', 'ag-empty-mark');
  mark.append(icon('rime'));
  wrap.append(mark, el('h3', undefined, 'What would you like to work on?'));
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

function reconcileLog(log: HTMLElement, previous: Ui['rendered'], entries: { key?: string; signature: string; create: () => HTMLElement; update?: (node: HTMLElement) => void }[], animate = false): Ui['rendered'] {
  const byKey = new Map(previous.map((entry, i) => [entry.key ?? String(i), entry]));
  const rendered = entries.map((entry, i) => {
    const key = entry.key ?? String(i), old = byKey.get(key); byKey.delete(key);
    if (old) {
      if (old.signature !== entry.signature) {
        if (entry.update) entry.update(old.node); else patchDom(old.node, entry.create(), animate);
        old.signature = entry.signature;
      }
      if (log.children[i] !== old.node) log.insertBefore(old.node, log.children[i] ?? null);
      return old;
    }
    const node = entry.create(); log.insertBefore(node, log.children[i] ?? null);
    if (animate) arrive(node);
    return { key, signature: entry.signature, node };
  });
  for (const old of byKey.values()) old.node.remove();
  return rendered;
}

const WORKING_WORDS = ['Contemplating…', 'Gathering the threads…', 'Weaving a plan…', 'Consulting the runes…'];
/** The cycling words, or the server's label ("Still thinking · 35s"). Swapped whole on a
 *  label change — patching span by span would `arrive()` every word at once. */
function workingText(label?: string): HTMLElement {
  const words = el('span', label ? 'ag-working-label' : 'ag-working-words');
  words.setAttribute('aria-hidden', 'true');
  if (label) words.textContent = label;
  else WORKING_WORDS.forEach((word, i) => { const phrase = el('span', undefined, word); phrase.style.setProperty('--ag-word-delay', `${i ? (i - 4) * 6 : 0}s`); words.append(phrase); });
  return words;
}
function thinking(label?: string): HTMLElement {
  const node = el('div', 'ag-thinking'), mark = el('span', 'ag-working-mark'); mark.append(icon('rime'));
  node.append(mark, workingText(label)); return node;
}

/** One scroll writer for compact, expanded and child logs. */
function followLog(log: HTMLElement, jump: HTMLElement, view: { follow: boolean }) {
  let frame = 0, written = log.scrollTop, writing = false, touchY = 0;
  const near = () => log.scrollHeight - log.scrollTop - log.clientHeight < 64;
  const cancel = () => { cancelAnimationFrame(frame); frame = 0; };
  const show = () => { jump.hidden = !!log.querySelector('.ag-empty') || view.follow || log.scrollHeight - log.clientHeight < 48; };
  // A wheel or drag that cannot scroll anything is not the reader leaving the bottom.
  const stop = () => { if (log.scrollHeight - log.clientHeight < 2) return; view.follow = false; cancel(); show(); };
  const tick = () => {
    frame = 0;
    if (!view.follow || document.hidden || !log.isConnected || !log.getClientRects().length) return;
    const target = Math.max(0, log.scrollHeight - log.clientHeight), distance = target - log.scrollTop;
    written = log.scrollTop + (Math.abs(distance) < 1 ? distance : distance * .3);
    const before = log.scrollTop;
    log.scrollTop = written; written = log.scrollTop; writing ||= before !== written;
    if (Math.abs(target - written) > 1) frame = requestAnimationFrame(tick);
    show();
  };
  const update = (instant = false) => {
    show();
    if (log.querySelector('.ag-empty')) { cancel(); log.scrollTop = 0; written = 0; writing = false; return; }
    if (!view.follow) return;
    if (instant || reducedMotion()) { cancel(); const before = log.scrollTop; log.scrollTop = log.scrollHeight; written = log.scrollTop; writing ||= before !== written; }
    else if (!frame) frame = requestAnimationFrame(tick);
  };
  log.addEventListener('wheel', e => { if (e.deltaY < 0) stop(); }, { passive: true });
  log.addEventListener('touchstart', e => { touchY = e.touches[0]?.clientY ?? 0; }, { passive: true });
  log.addEventListener('touchmove', e => { const y = e.touches[0]?.clientY ?? touchY; if (y > touchY) stop(); touchY = y; }, { passive: true });
  log.addEventListener('keydown', e => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) stop(); });
  log.addEventListener('scroll', () => {
    const top = log.scrollTop;
    if (!writing || Math.abs(top - written) > 1) { view.follow = near(); if (!view.follow) cancel(); }
    writing = false; show();
  }, { passive: true });
  jump.onclick = () => { view.follow = true; update(); }; // eased like the follow itself; reduced motion snaps
  // A box change (the composer growing, a ward resize, the page coming on stage) re-anchors
  // the bottom before paint: eased, it read as the transcript bouncing on every wrapped line.
  const resize = new ResizeObserver(() => update(true)); resize.observe(log);
  const wake = () => { if (!document.hidden) update(true); }; // a tick that bailed while hidden never re-armed
  document.addEventListener('visibilitychange', wake);
  log.addEventListener('load', () => update(), true);
  log.addEventListener('toggle', () => update(), true);
  return { update, dispose() { cancel(); resize.disconnect(); document.removeEventListener('visibilitychange', wake); } };
}

function buildLog(st: State, ui: LogUi): void {
  const log = ui.log;
  const entries: { key: string; signature: string; create: () => HTMLElement; update?: (node: HTMLElement) => void }[] = [];
  if (!st.items.length) entries.push({ key: 'empty', signature: 'empty', create: () => st.task ? el('p', 'ag-child-empty', st.remote ? 'The child agent is starting…' : 'No conversation was recorded for this run.') : emptyState(st, ui) });
  let prev: TurnSource = 'chat';
  for (let i = 0; i < st.items.length; i++) {
    const it = st.items[i]!;
    if (it.k === 'thinking' && (st.pending || currentQuestion(st)?.wait || st.items.some(x => x.k === 'msg' && x.streaming))) continue;
    const src = it.k === 'msg' || it.k === 'step' ? it.src ?? 'chat' : 'chat';
    const label = src !== 'chat' && src !== prev ? SRC_LABEL[src] : '';
    const group: StepItem[] = [];
    if (it.k === 'step') {
      group.push(it);
      while (st.items[i + 1]?.k === 'step' && (st.items[i + 1] as StepItem).src === it.src) group.push(st.items[++i] as StepItem);
    }
    const key = it.k === 'msg' ? `msg:${it.id ?? `${i}:${it.role}`}` : it.k === 'step' ? `steps:${it.step.id ?? i}` : it.k === 'thinking' ? 'thinking' : `note:${i}`;
    entries.push({ key, signature: JSON.stringify([label, group.length ? group : it]),
      ...(it.k === 'msg' && it.role === 'assistant' ? { update: (node: HTMLElement) => updateBubble(node, it, st, ui.live === true) } : {}),
      ...(it.k === 'thinking' ? { update: (node: HTMLElement) => node.querySelector('.ag-working-words, .ag-working-label')?.replaceWith(workingText(it.label)) } : {}),
      create: () => {
        let node: HTMLElement;
        if (it.k === 'msg') { node = bubble(it.role, it.text); updateBubble(node, it, st, false); }
        else if (it.k === 'step') {
          node = el('div', 'ag-timeline');
          for (const [index, item] of group.entries()) {
            if (item.batch && item.batch !== group[index - 1]?.batch) {
              const count = group.filter(x => x.batch === item.batch).length;
              const label = el('div', 'ag-batch-label', `${count} parallel actions`); label.hidden = count < 2; node.append(label);
            }
            node.append(stepCard(item.step, item.running, st.w.i));
          }
        } else if (it.k === 'thinking') node = thinking(it.label);
        else {
          node = el('div', `ag-notice${it.err ? ' ag-error' : ''}`);
          if (it.icon || it.err) node.append(icon(it.icon ?? 'warning'), document.createTextNode(' '));
          node.append(document.createTextNode(it.text));
        }
        if (label) {
          const rail = el('div', 'ag-source'), source = el('span', 'ag-source-label');
          source.append(icon(src === 'wake' ? 'timer' : src === 'agent' ? 'rime' : 'flow'), document.createTextNode(' ' + label));
          rail.append(source, node); return rail;
        }
        return node;
      },
    });
    prev = src;
  }
  const top = log.scrollTop;
  ui.rendered = reconcileLog(log, ui.rendered, entries, ui.live === true);
  if (!ui.follow) log.scrollTop = top;
  if (!ui.restored && entries.length) {
    ui.restored = true;
    const saved = st.task ? null : readDesktopCheckpoint<{ follow: boolean; top: number; details: number[] }>(`agent-view:${st.w.i}:${st.w.device ?? ''}`);
    if (saved && Number.isFinite(saved.top)) {
      ui.follow = saved.follow === true;
      log.querySelectorAll('details').forEach((detail, index) => { detail.open = saved.details?.includes(index) ?? false; });
      if (!ui.follow) log.scrollTop = saved.top;
    }
    ui.scroll?.update(true);
  } else ui.scroll?.update();
}

function paintStream(st: State) {
  if (st.frame) return;
  st.frame = requestAnimationFrame(() => { st.frame = undefined; for (const ui of st.uis) if (ui.root.isConnected) buildLog(st, ui); });
}

function restoreSurface(st: State, data: { conversation?: number; transcript?: TranscriptMsg[]; live?: LiveTurn }) {
  // Only this run's in-flight items may outlive the snapshot: another tab's New
  // chat swaps the conversation, and its old messages must not be carried over.
  const old = st.items, sameRun = !!data.live && (!st.run || st.run === data.live.id) && (!st.conversation || st.conversation === data.conversation);
  st.conversation = data.conversation; st.run = data.live?.id;
  st.items = itemsFrom(data.live?.transcript ?? data.transcript ?? []);
  const matched = new Set<Item>();
  for (const item of st.items) if (item.k === 'msg') {
    // A stored reply may carry a tail the stream never had (a confirm prompt, a failure note).
    const previous = old.find(x => !matched.has(x) && x.k === 'msg' && x.role === item.role && (x.text === item.text || item.role === 'assistant' && item.text.startsWith(x.text)));
    if (previous?.k === 'msg') { item.id = previous.id; matched.add(previous); }
  }
  const run = newRun();
  if (data.live) {
    if (!st.task) remoteRuns.set(st.w.i, run);
    for (const event of data.live.events) applyEvent(st, run, event, undefined, true);
  }
  if (sameRun) {
    for (const item of old) {
      if (item.k === 'msg' && item.id) {
        const current = st.items.find(x => x.k === 'msg' && x.id === item.id);
        if (current?.k === 'msg' && item.text.startsWith(current.text) && (item.text.length > current.text.length || !item.streaming)) Object.assign(current, item);
        else if (!current) st.items.push(item);
      } else if (item.k === 'step' && item.step.id) {
        const current = st.items.find(x => x.k === 'step' && x.step.id === item.step.id);
        if (current?.k === 'step' && current.running && !item.running) Object.assign(current, item);
        else if (!current) st.items.push(item);
      }
    }
  }
  for (const ui of st.uis) ui.live = false;
  return run;
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
    chip.title = `${w ? mentionSummary(w.type) : 'Ward unavailable'} · Click to remove`;
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
    rm.title = 'Remove';
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

/** Draft checkpoints are independent of frame-batched streamed text. */
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
const currentQuestion = (st: State): PendingQuestion | null => st.pending?.question ? { ...st.pending.question, id: st.pending.confirmId } : st.question ?? null;

function paintQuestion(st: State, ui: Ui): void {
  const question = currentQuestion(st), box = ui.questionBox;
  box.hidden = !question;
  if (!question) { ui.questionId = undefined; box.replaceChildren(); return; }
  const drafts = st.questionDrafts ??= new Map<string, UserAnswer>();
  const checkpoint = `agent-question:${st.w.i}:${question.id}`;
  if (!drafts.has(question.id)) drafts.set(question.id, readDesktopState<UserAnswer>(checkpoint) ?? (question.input === 'multiple' ? [] : ''));
  const save = (value: UserAnswer) => { drafts.set(question.id, value); saveDesktopState(checkpoint, value); paint(st); };
  const answer = async (value: UserAnswer | null) => {
    if (st.questionSubmitting || currentQuestion(st)?.id !== question.id) return;
    st.questionSubmitting = true; paint(st);
    const payload = { action: 'answer-question', questionId: question.id, answer: value };
    try {
      if (question.wait) await post(st, payload, {});
      else {
        const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, payload);
        if (status !== 200 || !data?.answered) throw Error(data?.error ?? 'Could not send your answer.');
        st.question = null;
      }
      if (currentQuestion(st)?.id !== question.id) { drafts.delete(question.id); saveDesktopState(checkpoint, undefined); }
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not send your answer.', undefined, true); }
    finally { st.questionSubmitting = false; paint(st); if (!currentQuestion(st) && ui.input.isConnected) ui.input.focus(); }
  };
  if (ui.questionId !== question.id) {
    ui.questionId = question.id; box.replaceChildren();
    const heading = el('div', 'ag-question-heading'); heading.append(icon('rime'), el('span', undefined, question.wait ? 'Rime is waiting for your answer' : 'A question from Rime'));
    const group = el('fieldset', 'ag-question-fields'), legend = el('legend', 'ag-question-title', question.question);
    group.append(legend);
    if (question.input === 'text') {
      const input = el('textarea', 'input ag-question-text'); input.rows = 3; input.maxLength = 8000;
      input.setAttribute('aria-label', question.question); input.placeholder = 'Your answer…';
      input.oninput = () => save(input.value); group.append(input);
    } else {
      group.append(el('p', 'ag-question-hint', question.input === 'single' ? 'Choose one' : 'Choose one or more'));
      const groupName = `question-${crypto.randomUUID()}`;
      for (const option of question.options) {
        const label = el('label', 'ag-question-option'), input = el('input');
        input.type = question.input === 'single' ? 'radio' : 'checkbox'; input.name = groupName; input.value = option;
        input.onchange = () => save(question.input === 'single' ? option : [...group.querySelectorAll<HTMLInputElement>('input:checked')].map(x => x.value));
        label.append(input, el('span', undefined, option)); group.append(label);
      }
    }
    const actions = el('div', 'ag-question-actions');
    const skip = el('button', 'btn', 'Skip'); skip.type = 'button'; skip.title = 'Continue without answering'; skip.onclick = () => { void answer(null); };
    const submit = el('button', 'btn-primary', question.wait ? 'Answer & continue' : 'Send answer'); submit.type = 'button'; submit.dataset.questionSubmit = '';
    submit.setAttribute('aria-label', question.wait ? 'Answer and continue' : 'Send answer');
    submit.prepend(icon('right')); submit.onclick = () => { void answer(drafts.get(question.id) ?? ''); };
    actions.append(skip, submit); box.append(heading, group, actions);
  }
  const value = drafts.get(question.id);
  for (const input of box.querySelectorAll<HTMLInputElement>('input')) {
    input.checked = Array.isArray(value) ? value.includes(input.value) : value === input.value;
    input.disabled = !!st.questionSubmitting;
  }
  const text = box.querySelector<HTMLTextAreaElement>('textarea');
  if (text) { if (text.value !== value) text.value = typeof value === 'string' ? value : ''; text.disabled = !!st.questionSubmitting; }
  const valid = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && !!value.trim() && value.length <= 8000;
  for (const button of box.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !!st.questionSubmitting || (button.hasAttribute('data-question-submit') && !valid);
  box.setAttribute('aria-busy', String(!!st.questionSubmitting));
}

function paint(st: State): void {
  if (st.busy || st.remote) reloadHolds.add(st.w.i);
  else reloadHolds.delete(st.w.i);
  try { saveDraft(st); } catch { /* Retain the in-memory draft until recovery can be saved. */ }
  for (const ui of [...st.uis]) if (!ui.root.isConnected) { ui.scroll?.dispose(); ui.visibility?.disconnect(); st.uis.delete(ui); }
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
    ui.send.disabled = !!st.pending?.question || st.configured === false || st.uploading > 0 || st.clearing || (!st.draft.trim() && !st.attachments.length);
    const working = st.busy || st.remote;
    const paused = !!st.pending || !!currentQuestion(st)?.wait;
    ui.root.dataset.paused = String(paused);
    const status = st.pending?.question ? 'Waiting for your answer' : st.pending ? 'Approval needed' : st.clearing ? 'Starting a new chat…' : working ? 'Working' : st.sharedStatus || 'Rimeward agent';
    if (ui.status.textContent !== status) ui.status.textContent = status;
    paintContext(ui.context, st.context);
    ui.root.dataset.working = String(working);
    ui.input.disabled = !!st.pending?.question;
    ui.input.placeholder = st.pending?.question ? 'Answer the question above to continue…' : st.configured === false ? 'Reconnect or configure a local provider in Account…' : working ? 'Add a follow-up…' : 'Message Rime…';
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-attach]').forEach(b => { b.disabled = st.configured === false; });
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-clear]').forEach(b => { b.disabled = working || st.clearing || st.uploading > 0; });
    ui.root.querySelectorAll<HTMLButtonElement>('[data-ag-history]').forEach(b => { b.disabled = working || st.clearing || st.uploading > 0; });
    ui.stop.classList.toggle('hidden', !st.busy && !st.remote); // server-side stop — any client, any turn
    ui.background.classList.toggle('hidden', !st.busy && !st.remote && !st.tasks.some(t => t.state === 'running' && !t.background));
    const running = st.tasks.filter(t => t.state === 'running' || t.state === 'stopping').length;
    ui.tasksButton.setAttribute('aria-label', `Tasks${running ? ` (${running} running)` : ''}`);
    ui.tasksButton.title = `Tasks${running ? ` · ${running} running` : ''}`;
    ui.tasksButton.dataset.count = running ? String(running) : '';
    ui.pendingBox.classList.toggle('hidden', !st.pending || !!st.pending.question);
    ui.pendingBox.classList.toggle('flex', !!st.pending && !st.pending.question);
    ui.pendingText.textContent = st.pending?.summary ?? '';
    ui.pendingDetails.hidden = !st.pending?.patch;
    if (ui.pendingPatch.textContent !== (st.pending?.patch ?? '')) ui.pendingPatch.textContent = st.pending?.patch ?? '';
    paintChips(st, ui.chips);
    paintQuestion(st, ui);
    paintPicker(st, ui);
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
  if (st.busy || st.refresh !== refresh || st.revision !== revision && !data.live) return;
  st.configured = data.configured;
  st.context = data.context ?? undefined;
  st.tasks = data.tasks ?? [];
  restoreSurface(st, data);
  st.pending = data.pending ?? null;
  st.question = data.question ?? null;
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
  for (const it of st.items) {
    if (it.k === 'step') it.running = false;
    if (it.k === 'msg' && it.streaming) { it.streaming = false; it.incomplete = true; }
  }
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
function applyEvent(st: State, run: Run, e: any, src?: TurnSource, replay = false): boolean {
  st.revision++;
  for (const ui of st.uis) ui.live = true;
  switch (e.type) {
    case 'user':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'msg', role: 'user', text: e.text, src });
      return true;
    case 'text_delta': {
      if (typeof e.id !== 'string' || typeof e.delta !== 'string' || !Number.isInteger(e.offset) || e.offset < 0) return true;
      dropThinking(st);
      let item = st.items.find((x): x is Extract<Item, { k: 'msg' }> => x.k === 'msg' && x.id === e.id);
      if (!item) {
        if (e.offset !== 0) { if (st.reloadLive) st.reloadLive(); else if (!st.busy) void refetch(st); return true; }
        item = { k: 'msg', id: e.id, role: 'assistant', text: '', streaming: true, src }; st.items.push(item);
      }
      if (!item.streaming) return true;
      if (e.offset > item.text.length) { if (st.reloadLive) st.reloadLive(); else if (!st.busy) void refetch(st); return true; }
      const skip = item.text.length - e.offset;
      if (skip < e.delta.length) item.text += e.delta.slice(skip);
      return true;
    }
    case 'thinking':
      if (st.items.some(x => x.k === 'msg' && x.streaming)) return true;
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
        const item = typeof e.id === 'string' ? st.items.find(x => x.k === 'msg' && x.id === e.id) : undefined;
        if (item?.k === 'msg') Object.assign(item, { text: e.text, streaming: false, incomplete: !!e.incomplete });
        else st.items.push({ k: 'msg', role: 'assistant', text: e.text, src, id: e.id, incomplete: !!e.incomplete });
        const speechKey = typeof e.id === 'string' ? e.id : e.text;
        if (!e.incomplete && !run.spoken.has(speechKey)) {
          run.spoken.add(speechKey);
          if (!replay) st.voice?.read(e.text, typeof e.id === 'string' ? e.id : `${run.seq}:${run.spoken.size}`);
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
      const it = run.steps.get(String(e.step?.id)) ?? st.items.find((x): x is StepItem => x.k === 'step' && x.step.id === e.step?.id);
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
    case 'question':
      st.question = e.question ?? null;
      return true;
    case 'usage':
      if (typeof e.tokens === 'number' && typeof e.model === 'string') st.context = e;
      return true;
    case 'reply':
      // 'reply' is the final text ('says' are mid-turn interjections);
      // done's reply field repeats it and is ignored by the caller.
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) {
        const item = typeof e.id === 'string' ? st.items.find(x => x.k === 'msg' && x.id === e.id) : undefined;
        if (item?.k === 'msg') Object.assign(item, { text: e.text, streaming: false, incomplete: !!e.incomplete });
        else st.items.push({ k: 'msg', role: 'assistant', text: e.text, src, id: e.id, incomplete: !!e.incomplete });
        const speechKey = typeof e.id === 'string' ? e.id : e.text;
        if (!e.incomplete && !run.spoken.has(speechKey)) {
          run.spoken.add(speechKey);
          if (!replay) st.voice?.read(e.text, typeof e.id === 'string' ? e.id : `${run.seq}:${run.spoken.size}`);
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
  for (const ui of st.uis) ui.live = true; // the message just pushed transitions in like the reply will
  paint(st);
  const restore: Restore = { text: typeof payload.message === 'string' ? payload.message : '', ...back };
  const running = newRun();
  let accepted = false;
  let completed = false;
  const reconnect = () => {
    st.busy = false;
    st.remote = true;
    remoteRuns.set(st.w.i, running);
    st.items.push({ k: 'note', text: 'Connection lost. Reconnecting…' });
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
    if (e.type === 'text_delta') paintStream(st); else paint(st);
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
          st.question = null;
          st.attachments = [];
        } else {
          st.items.push({ k: 'note', text: String(data.text ?? '') });
        }
        paint(st);
        return;
      }
      if (!res.ok || data?.error) {
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
    // One bad frame must not end the stream (it did not before streaming either).
    await readSse(res.body!, payload => { if (payload !== '[DONE]') try { dispatch(JSON.parse(payload)); } catch {} });
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
  if (st.configured === false || st.pending?.question) return;
  const text = ui.input.value.trim();
  if (text.length > 8000) { toast('Messages are limited to 8,000 characters.'); return; }
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
      toast('Attachments send once this turn finishes.');
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
  toast(data.forked || data.tasks?.length ? 'Running in the background.' : 'Nothing is running.');
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
  const history = el('input'); history.type = 'checkbox';
  history.setAttribute('role', 'switch');
  const historyLabel = el('label', 'ag-task-history switch'); historyLabel.append(history, icon('history'), document.createTextNode('Show completed logs'));
  historyLabel.title = 'Newest 100 completed logs, kept for up to 30 days';
  actions.before(historyLabel, list);
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
      const { status, data } = await getJson(`${endpoint}&history=${history.checked}`);
      if (!d.open) return;
      if (status !== 200) { if (!list.childElementCount) list.append(el('p', undefined, data?.error ?? 'Tasks unavailable.')); return; }
      st.tasks = data.tasks ?? []; paint(st);
      const next = JSON.stringify(st.tasks);
      if (next !== signature) {
        signature = next;
        list.replaceChildren();
        if (!st.tasks.length) list.append(el('p', undefined, 'No tasks yet. Ctrl+B moves a running turn to the background.'));
        for (const task of st.tasks) {
          const row = el('article', 'ag-task-row');
          const detail = el('div', 'ag-task-description');
          const status = el('span', 'ag-task-status');
          status.dataset.task = task.id;
          detail.append(el('strong', undefined, task.reason), status);
          if (task.error) detail.append(el('span', 'text-err', task.error));
          const rowActions = el('div', 'ag-task-actions');
          if (task.tool === 'spawn_agent') {
            const open = el('button', 'btn', 'Open conversation'); open.type = 'button'; open.title = 'Open the child agent’s conversation';
            open.dataset.agChild = task.id;
            open.onclick = () => openChildSession(st, task, d);
            rowActions.append(open);
          }
          for (const final of task.tool === 'monitor' ? [true] : [false, true]) {
            const button = el('button', 'btn', task.tool === 'monitor' ? 'Filters and matches' : final ? 'Result' : 'Output'); button.type = 'button';
            button.title = task.tool === 'monitor' ? 'What this monitor watches for, and what it matched' : final ? 'The final result' : 'Live output';
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
            const detach = el('button', 'btn', 'Background'); detach.type = 'button'; detach.title = 'Keep running in the background';
            detach.onclick = async () => {
              detach.disabled = true;
              const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'background', task: task.id });
              if (status !== 200) { toast(data?.error ?? 'Could not background task.'); detach.disabled = false; }
              else { for (const task of data.tasks ?? []) updateTask(st, task); void refresh(); }
            };
            rowActions.append(detach);
          }
          if (task.cancellable) {
            if (task.tool === 'monitor') {
              const pause = el('button','btn',task.state === 'paused' ? 'Resume' : 'Pause'); pause.type = 'button'; pause.title = task.state === 'paused' ? 'Resume this monitor' : 'Pause this monitor';
              pause.onclick = async () => {
                pause.disabled = true;
                const { status,data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`,{ action:'monitor',task:task.id,operation:task.state === 'paused' ? 'resume' : 'pause' });
                if (status !== 200) toast(data?.error ?? 'Could not update monitor.');
                void refresh();
              };
              rowActions.append(pause);
            }
            const stop = el('button', 'btn', task.tool === 'monitor' ? 'Delete monitor' : 'Stop'); stop.type = 'button'; stop.title = task.tool === 'monitor' ? 'Delete this monitor' : 'Stop this task';
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
  history.onchange = () => { signature = ''; void refresh(); };
  const timer = setInterval(() => { void refresh(); }, 2000);
  d.addEventListener('close', () => { clearInterval(timer); d.remove(); }, { once: true });
  void refresh();
}

const childLive = new Map<string, (event: AgentLive) => void>();

function openChildSession(st: State, task: AgentTask, tasksDialog: HTMLDialogElement): void {
  const { d, form, actions, submit, error } = dialog('Child agent');
  d.classList.remove('dev-project-dialog');
  d.classList.add('ag-dialog', 'ag-child-dialog');
  form.className = 'ag-child-form';
  const heading = form.querySelector('h2')!;
  heading.textContent = task.reason; heading.title = task.reason;
  const back = actions.querySelector('button')!;
  back.className = 'ag-icon-button'; back.replaceChildren(icon('close'));
  back.title = 'Back to tasks'; back.setAttribute('aria-label', 'Back to tasks');
  const header = el('header', 'ag-dialog-header');
  const identity = el('div', 'ag-dialog-identity');
  const avatar = el('span', 'ag-avatar'); avatar.append(icon('rime'));
  const labels = el('div');
  const statusLine = el('p', 'ag-status', 'Connecting…'); statusLine.setAttribute('role', 'status');
  labels.append(heading, statusLine); identity.append(avatar, labels); header.append(identity, back);
  const stage = el('div', 'ag-stage');
  const log = el('div', 'ag-log'); log.setAttribute('aria-label', 'Child agent conversation'); log.tabIndex = 0;
  const assignment = el('p', 'ag-child-assignment', task.reason);
  const transcriptBox = el('div', 'ag-child-transcript');
  const progress = el('details', 'ag-activity');
  const progressTitle = el('summary', undefined, 'Live activity'); progressTitle.title = 'Raw tool output from this run';
  const output = el('pre', 'ag-task-output'); progress.append(progressTitle, output);
  const questionBox = el('div', 'ag-approval'); questionBox.hidden = true; questionBox.setAttribute('role', 'status');
  const questionText = el('p', 'ag-approval-text');
  questionBox.append(el('strong', undefined, 'Waiting for an answer'), questionText);
  const delivery = el('details', 'ag-activity'); delivery.hidden = true;
  const deliveryTitle = el('summary', undefined, 'Message delivery');
  const receipts = el('div', 'ag-child-receipts'); receipts.setAttribute('aria-label', 'Message delivery');
  delivery.append(deliveryTitle, receipts);
  log.append(assignment, transcriptBox, progress, questionBox, delivery);
  const jump = el('button', 'ag-jump', 'Jump to latest'); jump.type = 'button'; jump.hidden = true; jump.title = 'Scroll to the latest message';
  stage.append(log, jump);
  const footer = el('div', 'ag-footer');
  const composer = el('div', 'ag-composer');
  const input = el('textarea', 'ag-input'); input.rows = 1; input.maxLength = 8000; input.required = true;
  input.placeholder = 'Message this child agent…'; input.setAttribute('aria-label', 'Message child agent');
  const drafts = st.childDrafts ??= new Map();
  const draftKey = `${st.w.device ?? ''}:${task.id}`;
  const checkpoint = `agent-child:${st.w.i}:${draftKey}`;
  const savedDraft = drafts.get(draftKey) ?? readDesktopState<{ text: string; questionId?: number }>(checkpoint);
  input.value = savedDraft?.text ?? '';
  let draftQuestionId = savedDraft?.questionId;
  if (input.value) drafts.set(draftKey, { text: input.value, questionId: draftQuestionId });
  const saveDraft = (value = input.value) => {
    const draft = value ? { text: value, questionId: draftQuestionId } : undefined;
    if (draft) drafts.set(draftKey, draft); else drafts.delete(draftKey);
    try { saveDesktopState(checkpoint, draft); }
    catch { failure('Draft kept for this session only.'); }
  };
  const controls = el('div', 'ag-compose-controls');
  const hint = el('span', 'ag-hint', 'Direct to this child'); hint.title = 'Messages go to this child agent only';
  const stop = el('button', 'ag-icon-button ag-stop'); stop.type = 'button'; stop.hidden = true; stop.append(icon('stop'));
  stop.title = 'Stop this run'; stop.setAttribute('aria-label', 'Stop this run');
  submit.className = 'ag-send'; submit.replaceChildren(icon('send'));
  submit.title = 'Send message'; submit.setAttribute('aria-label', 'Send message');
  controls.append(hint, stop, submit); composer.append(input, controls);
  const help = el('p', 'ag-composer-help', 'Messages are read at the next step.');
  help.id = `${heading.id}-help`; input.setAttribute('aria-describedby', help.id);
  const connection = el('p', 'ag-child-connection'); connection.hidden = true; connection.setAttribute('role', 'status');
  error.setAttribute('role', 'alert'); error.classList.add('ag-child-error');
  footer.append(connection, error, composer, help); form.replaceChildren(header, stage, footer);
  const endpoint = `/api/agent/${encodeURIComponent(st.w.i)}`;
  let fetching = false, sending = false, stopping = false, connected = false, canMessage = false;
  let receiptNodes: Ui['rendered'] = [];
  const childState: State = { ...st, task: task.id, items: [], pending: null, question: null, busy: false, remote: true, voice: undefined, uis: new Set(), frame: undefined, revision: 0 };
  const childUi: LogUi = { root: d, log: transcriptBox, input, rendered: [], jump, follow: true, restored: false, live: false };
  let childRun = newRun(), childFrame = 0;
  childUi.scroll = followLog(log, jump, childUi);
  let question: { id: number; text: string; maxLength: number } | null = null;
  const failure = (e: unknown) => { error.hidden = false; error.textContent = e instanceof Error ? e.message : String(e); };
  const controlsState = () => {
    submit.disabled = sending || !connected || !canMessage || !input.value.trim() || input.value.length > input.maxLength || draftQuestionId !== question?.id;
    stop.disabled = stopping || !connected;
  };
  const scroll = () => childUi.scroll!.update();
  const refresh = async () => {
    if (!d.open || fetching || document.hidden) return;
    fetching = true;
    const revision = childState.revision;
    try {
      const response = await fetch(`${endpoint}?tasks=1&task=${encodeURIComponent(task.id)}&session=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      const status = response.status, data = await response.json();
      if (!d.open) return;
      if (status !== 200 || !data) throw Error(data?.error ?? 'Reconnecting…');
      connected = true; connection.hidden = true;
      canMessage = data.canMessage; question = data.question ?? null;
      const running = ['running', 'stopping'].includes(data.task.state);
      statusLine.textContent = `${question ? 'Waiting for an answer' : humanise(data.task.state)} · ${data.task.model ?? 'Child agent'}`;
      statusLine.title = [data.task.provider, data.task.endpoint, data.task.model].filter(Boolean).join(' · ');
      stop.hidden = !data.task.cancellable;
      input.readOnly = !running;
      input.maxLength = question?.maxLength ?? 8000;
      input.placeholder = running ? question ? 'Answer this child agent…' : 'Message this child agent…' : 'This child run has ended';
      help.textContent = running ? question ? `Answers the question above · ${input.maxLength.toLocaleString()} characters max` :
        matchMedia('(pointer: coarse)').matches ? 'Tap send · messages are read at the next step' : 'Enter to send · Shift + Enter for a new line' :
        'This run has ended.';
      if (running && input.value && draftQuestionId !== question?.id) help.textContent = 'The question changed. Review your draft before sending.';
      if (childState.revision === revision) {
        childRun = restoreSurface(childState, data);
        childUi.live = false; childState.remote = running;
        if (running && !childState.items.some(x => x.k === 'thinking' || x.k === 'msg' && x.streaming || x.k === 'step' && x.running))
          childState.items.push({ k: 'thinking' });
        buildLog(childState, childUi);
      }
      d.dataset.paused = String(!!question || !running);
      progressTitle.textContent = running ? 'Live activity' : 'Run activity';
      const activity = `${data.truncated ? '[Earlier activity is no longer retained]\n' : ''}${data.output || 'No activity recorded yet.'}`;
      if (output.textContent !== activity) output.textContent = activity;
      questionBox.hidden = !question; questionText.textContent = question?.text ?? '';
      const messages = data.messages as { id: number; text: string; status: string; result: string }[];
      receiptNodes = reconcileLog(receipts, receiptNodes, messages.map(m => ({ signature: JSON.stringify(m), create: () => {
        const row = el('div', 'ag-child-receipt');
        const failed = m.status === 'failed' || m.status === 'cancelled';
        row.append(el('p', undefined, m.text), el('small', failed ? 'text-err' : 'muted',
          m.status === 'done' ? 'Read by child' : failed ? `Not delivered · ${m.result || m.status}` : 'Waiting for the next step'));
        return row;
      }})));
      const unread = messages.filter(m => m.status !== 'done').length;
      delivery.hidden = !messages.length;
      deliveryTitle.textContent = `Message delivery${unread ? ` · ${unread} unread` : ''}`;
      if (messages.some(m => m.status === 'failed' || m.status === 'cancelled')) delivery.open = true;
      if (data.task.error) { connection.hidden = false; connection.textContent = data.task.error; }
      scroll();
    } catch (e) {
      if (d.open) { connected = false; connection.hidden = false; connection.textContent = e instanceof Error ? e.message : 'Connection lost. Retrying…'; }
    } finally { fetching = false; controlsState(); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.disabled) return;
    const message = input.value;
    const questionId = draftQuestionId;
    sending = true; error.hidden = true; controlsState();
    try {
      const { status, data } = await postJson(endpoint, { action: 'message-child', task: task.id, message, questionId });
      if (status !== 200 || !data) throw Error(status === 0 ? 'Delivery could not be confirmed. Check Message delivery before sending again; your draft is safe.' : data?.error ?? 'Could not send message.');
      if (data.message?.status === 'failed') throw Error(data.message.result);
      if (input.value === message) {
        if (drafts.get(draftKey)?.text === message && drafts.get(draftKey)?.questionId === questionId) saveDraft('');
        input.value = ''; autoGrow(input);
      }
      delivery.open = true; childUi.follow = true;
      await refresh();
    } catch (e) { failure(e); void refresh(); }
    finally { sending = false; controlsState(); }
  };
  stop.onclick = async () => {
    stopping = true; error.hidden = true; controlsState();
    try {
      const { status, data } = await postJson(endpoint, { action: 'cancel-task', task: task.id });
      if (status !== 200 || !data?.task) throw Error(data?.error ?? 'Could not stop child agent.');
      updateTask(st, data.task); await refresh();
    } catch (e) { failure(e); }
    finally { stopping = false; controlsState(); }
  };
  input.addEventListener('input', () => { draftQuestionId = question?.id; saveDraft(); autoGrow(input); controlsState(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault(); form.requestSubmit();
    }
  });
  controlsState(); autoGrow(input);
  progress.open = false;
  childState.reloadLive = () => { void refresh(); };
  const onLive = (event: AgentLive) => {
    if (!d.open || event.conversation && childState.conversation && event.conversation !== childState.conversation) return;
    childUi.live = true;
    if (event.run) childState.run = event.run;
    if (event.event.type === 'end') { endTurn(childState); childState.remote = false; buildLog(childState, childUi); void refresh(); return; }
    if (applyEvent(childState, childRun, event.event, 'agent')) {
      if (event.event.type === 'text_delta') {
        if (!childFrame) childFrame = requestAnimationFrame(() => { childFrame = 0; buildLog(childState, childUi); });
      } else buildLog(childState, childUi);
    }
  };
  childLive.set(task.id, onLive);
  const timer = setInterval(() => { void refresh(); }, 2000);
  d.addEventListener('close', () => {
    saveDraft(); clearInterval(timer); cancelAnimationFrame(childFrame); childUi.scroll?.dispose(); childState.voice?.dispose();
    if (childLive.get(task.id) === onLive) childLive.delete(task.id);
    d.remove();
    [...tasksDialog.querySelectorAll<HTMLButtonElement>('[data-ag-child]')].find(button => button.dataset.agChild === task.id)?.focus();
  }, { once: true });
  back.focus();
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
  st.question = null;
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
  // Measuring at height:auto collapses the composer for one layout, and that layout clamps the
  // log's scroll offset above it — the transcript jumped on every keystroke and, past 64px,
  // the follow disengaged. The composer keeps its size until the new height is known.
  const box = input.parentElement;
  if (box) box.style.minHeight = `${box.offsetHeight}px`;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  if (box) box.style.minHeight = '';
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
  // The menu is hosted in the popup layer, not under the composer: the footer scrolls
  // (overflow:auto), so a child popping above it was clipped away. Inside the open dialog
  // the layer sits in its top layer and focus scope; on the page it is body-hosted.
  const menu = el('div', 'fd-cmd');
  menu.setAttribute('role', 'listbox');
  menu.id = 'ag-commands-' + crypto.randomUUID();
  ui.input.setAttribute('aria-controls', menu.id);
  ui.input.setAttribute('aria-autocomplete', 'list');
  ui.input.setAttribute('aria-expanded', 'false');

  let layer: HTMLElement | null = null;
  let items: (CommandSpec | WardInstance)[] = [];
  let mentionStart = -1;
  let active = 0;
  const isOpen = () => !!layer;
  // While open the menu follows the composer: it grows with the draft and chips, the page
  // scrolls, the on-screen keyboard resizes the viewport.
  const followed = [window, window.visualViewport] as (EventTarget | null)[];
  const watch = new ResizeObserver(() => place());

  function open(): void {
    if (layer) return;
    layer = popupLayer((ui.input.closest('dialog[open]') ?? document.body) as HTMLElement);
    layer.append(menu);
    for (const target of followed) for (const type of ['scroll', 'resize']) target?.addEventListener(type, place, { capture: true, passive: true });
    watch.observe(anchor);
  }

  function close(): void {
    if (layer) {
      for (const target of followed) for (const type of ['scroll', 'resize']) target?.removeEventListener(type, place, { capture: true });
      watch.disconnect();
      layer.remove(); layer = null;
    }
    ui.input.setAttribute('aria-expanded', 'false');
    ui.input.removeAttribute('aria-activedescendant');
  }

  /** Above the composer, spanning it; below when the page is scrolled so far that there is
   *  clearly more room under it. Never off the visible viewport. */
  function place(): void {
    if (!layer) return;
    if (!anchor.isConnected) { close(); return; }
    const r = anchor.getBoundingClientRect(), frame = popupFrame(layer), viewport = popupViewport();
    const above = r.top - viewport.top - 14, below = viewport.bottom - r.bottom - 14;
    const up = above >= Math.min(208, below);
    menu.style.left = `${(r.left - frame.x) / frame.scale}px`;
    menu.style.width = `${r.width / frame.scale}px`;
    menu.style.maxHeight = `${Math.max(48, Math.min(208, up ? above : below)) / frame.scale}px`;
    const top = up ? r.top - 6 - menu.offsetHeight * frame.scale : r.bottom + 6;
    menu.style.top = `${(top - frame.y) / frame.scale}px`;
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
      // pointerdown, not click: the textarea must not lose focus before we act.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        active = i;
        pick(true);
      });
      menu.append(row);
    });
    ui.input.setAttribute('aria-activedescendant', `${menu.id}-${active}`);
    open();
    place();
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
    menu.scrollTop = 0; // a fresh list starts at its top; arrow moves keep the list where it is
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
  ui.picker.provider.addEventListener('change', () => { const st = cur(); if (st) void pickRoute(st, ui.picker.provider.value); });
  ui.picker.model.addEventListener('change', () => {
    const st = cur();
    if (!st) return;
    const model = ui.picker.model.value;
    if (model && model !== st.catalog?.current?.model) void saveSelection(st, { model });
    else paint(st);
  });
  ui.picker.effort.addEventListener('change', () => {
    const st = cur();
    if (!st) return;
    const effort = ui.picker.effort.value as AgentEffort;
    if ((AGENT_EFFORTS as readonly string[]).includes(effort) && effort !== st.catalog?.current?.effort) void saveSelection(st, { effort });
    else paint(st);
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
  ui.scroll = followLog(ui.log, ui.jump, ui);
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
  const visibility = new IntersectionObserver(entries => { root.dataset.visible = String(entries.some(entry => entry.isIntersecting)); });
  visibility.observe(root);
  log.dataset.agLog = '';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Conversation');
  // Status has its own live region; do not re-announce the transcript on every tool event.
  log.setAttribute('aria-live', 'off');
  log.tabIndex = 0;
  const jump = el('button', 'ag-jump');
  const down = el('span', 'ag-jump-icon'); down.append(icon('right'));
  jump.append(down, document.createTextNode(' Latest')); jump.setAttribute('aria-label', 'Latest'); jump.title = 'Scroll to the latest message';
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
  approve.type = 'button'; approve.dataset.agConfirm = ''; approve.title = 'Run this action';
  const decline = el('button', 'btn', 'Cancel');
  decline.type = 'button'; decline.dataset.agDecline = ''; decline.title = 'Skip this action';
  pendingBox.append(pendingText, pendingDetails, approve, decline);
  const questionBox = el('section', 'ag-question'); questionBox.hidden = true;
  questionBox.setAttribute('aria-label', 'Question from Rime');
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
  const hint = el('span', 'ag-hint', '@ wards · / commands'); hint.title = 'Type @ to mention a ward, / for a command';
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
  voiceStop.title = 'Stop reading aloud'; voiceStop.setAttribute('aria-label', 'Stop voice');
  controls.append(attach, file, tasksButton, microphone, hint, voiceStop, background, stop, send);
  form.append(chips, input, controls);
  const help = el('p', 'ag-composer-help', matchMedia('(pointer: coarse)').matches ? 'Tap send when you’re ready' : 'Enter to send · Shift + Enter for a new line');
  const voiceStatus = el('p', 'ag-voice-status');
  voiceStatus.hidden = true; voiceStatus.setAttribute('role', 'status');
  const voiceOptions = el('div', 'ag-voice-options');
  const readLabel = el('label', 'switch');
  const readResponses = el('input'); readResponses.type = 'checkbox'; readResponses.setAttribute('role', 'switch');
  readLabel.append(readResponses, document.createTextNode('Read responses')); readLabel.title = 'Read each reply aloud';
  const modeLabel = el('label');
  const conversationMode = el('select'); conversationMode.setAttribute('aria-label', 'Voice conversation mode');
  for (const [value, label] of [['off', 'Off'], ['finish-send', 'Finish & Send'], ['hands-free', 'Hands-free']]) {
    const option = el('option', undefined, label); option.value = value!; conversationMode.append(option);
  }
  modeLabel.append(document.createTextNode('Conversation'), conversationMode); modeLabel.title = 'Voice conversation mode';
  // Provider / Model / Effort: what the next message runs on (paintPicker fills them).
  const pickerRoot = el('div', 'ag-model-picker');
  pickerRoot.setAttribute('role', 'group'); pickerRoot.setAttribute('aria-label', 'Model settings');
  pickerRoot.hidden = true;
  const pick = (text: string, name: string) => {
    const label = el('label');
    const select = el('select'); select.setAttribute('aria-label', name);
    label.append(el('span', 'ag-picker-word', text), select);
    pickerRoot.append(label);
    return select;
  };
  const picker = { root: pickerRoot, provider: pick('Provider', 'Provider'), model: pick('Model', 'Model'), effort: pick('Effort', 'Reasoning effort') };
  voiceOptions.append(readLabel, pickerRoot, modeLabel);
  footer.append(questionBox, pendingBox, form, voiceOptions, voiceStatus, help);
  host.append(stage, footer);
  return { root, visibility, log, input, send, stop, background, tasksButton, microphone, voiceStop, voiceStatus, readResponses, conversationMode, picker, chips, pendingBox, pendingText, pendingDetails, pendingPatch, questionBox, status, context, jump, follow: true, rendered: [] };
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
  dialogUi.restored = false;
  dialogUi.live = false;
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
      list.append(el('p','muted','Opens a copy here. The original stays intact.'));
      form.onsubmit=async(e)=>{e.preventDefault();submit.disabled=true;try{const {ok,data}=await postJson(`/api/agent/history?_ward=${encodeURIComponent(w.i)}`,{ward:w.i,key});if(!ok)throw Error(data?.error??'Could not continue chat.');d.close();await renderAgent(w);}catch(e){failure(e);}finally{submit.disabled=false;}};
    };
    for(const chat of data.chats??[]){const b=el('button','btn ag-history-row');b.type='button';b.title='Open this conversation';b.append(el('strong',undefined,chat.title),el('small','muted',chat.device));b.onclick=()=>void open(chat.key).catch(failure);list.append(b);}
    if(!data.chats?.length)list.append(el('p','muted','Your conversations will appear here.'));
    for(const saved of state?.conflicts??[]){
      const b=el('button','btn ag-history-row',`Recovered version · ${saved.key}`);b.type='button';b.title='Open the recovered version';list.append(b);
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
    mark.append(icon('rime'));
    const link = el('a', 'btn', 'Set up your agent');
    link.href = '/account#agent';
    setup.append(mark, el('h3', undefined, 'Meet your workspace agent'),
      el('p', undefined, data.sync?.server ? `${data.sync.error ?? 'The server is offline.'} Local files and history remain available. Connect a local provider in Account to keep working.` : `Connect ${data.provider === 'codex' ? 'Codex' : 'OpenRouter'} in Account to start.`), link, historyButton(w));
    b.replaceChildren(setup);
    return;
  }

  // A rerender mid-stream must not clobber the live turn's log.
  st.tasks = data.tasks ?? st.tasks;
  if (!st.busy && st.revision === revision) {
    restoreSurface(st, data);
    st.pending = data.pending ?? null;
    st.question = data.question ?? null;
    st.remote = !!data.busy; // a turn already running when this client loaded
    if (st.remote && !st.items.some(it => it.k === 'thinking' || (it.k === 'step' && it.running))) st.items.push({ k: 'thinking' });
  }
  void loadCatalog(st); // the footer pickers follow the ward's config; a no-op when it is unchanged
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
  fresh.title = 'New chat (archives this one)';
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
    if (d?.task) { childLive.get(d.task)?.(d); return; }
    const live = states.get(ward);
    if (d?.conversation && live?.conversation && d.conversation !== live.conversation) return;
    if (live && d?.event?.type === 'task') { updateTask(live, d.event.task); return; }
    if (!live || live.busy || !d) return; // this client's own stream owns the log
    let running = remoteRuns.get(ward);
    if (!running) { running = newRun(); remoteRuns.set(ward, running); }
    if (d.event?.type === 'end') {
      // The turn died without settling — no ping is coming, so release here.
      remoteRuns.delete(ward);
      live.revision++;
      live.remote = false;
      endTurn(live);
      if (d.event.error) live.items.push({ k: 'note', err: true, text: d.event.error });
      paint(live);
      flushPendingLayout();
      return;
    }
    live.remote = true;
    if (d.run) live.run = d.run;
    const src: TurnSource = d.source === 'wake' || d.source === 'automation' || d.source === 'agent' ? d.source : 'chat';
    if (applyEvent(live, running, d.event, src)) { if (d.event.type === 'text_delta') paintStream(live); else paint(live); }
  });
}

// ------------------------------------------------------------------- registry

RENDERERS.agent = { render: (w) => renderAgent(w), preserveBody: true, stop: id => states.get(id)?.voice?.dispose() }; // event-driven — no poll
