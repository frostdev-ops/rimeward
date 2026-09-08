import { expandedDesktopWard, restoreExpandedWard, readDesktopCheckpoint, saveDesktopState } from "./desktop-state.ts";
// The notepad ward (type `note`): a rich-text document — contenteditable and
// execCommand, the browser's own editor, no library — with an ink layer over it
// (pointer strokes on a canvas that scrolls with the page) and a footer. Both
// halves autosave per ward to /api/note/<ward>. In the ward it is a notepad;
// Expand moves the SAME element into #note-dialog (one document, one canvas,
// no second state) where the full toolbar and the wide page show. Reading
// handwriting and the ✨ commands are one-shot model calls the server makes
// with the ward's provider/model (lib/agent/oneshot.ts) — the ward only ever
// ships a PNG of the strokes, or a passage of text.
//
// ponytail: ink is stored in absolute page px — reflowing the text at another
// width leaves the strokes where they were. Store them relative to the line
// they were written on if that ever matters.

import { noteConfig, wardTitle, type NoteConfig, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body } from './wards.ts';
import { el, postJson } from './dom.ts';
import { icon } from './icon.ts';

/** [x, y] in page CSS px (the scroll content's box), pressure 0..1. */
type Pt = [number, number, number];
interface Stroke {
  c: string;
  w: number;
  p: Pt[];
}
type Tool = 'text' | 'pen' | 'eraser';

interface State {
  w: WardInstance;
  cfg: NoteConfig;
  root: HTMLElement;
  page: HTMLElement;
  doc: HTMLElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  err: HTMLElement;
  count: HTMLElement;
  btn: Record<string, HTMLButtonElement>;
  color: HTMLInputElement;
  width: HTMLInputElement;
  ai: HTMLElement | null;
  /** The last selection made inside the document — the ✨ bar steals focus. */
  sel: Range | null;
  strokes: Stroke[];
  cur: Stroke | null;
  /** Drawn since the last transcription — what "live" reads next. */
  fresh: Set<Stroke>;
  tool: Tool;
  penSeen: boolean;
  docTimer: number;
  inkTimer: number;
  liveTimer: number;
  docDirty: boolean;
  inkDirty: boolean;
  busy: boolean;
  ro: ResizeObserver;
}

const states = new Map<string, State>();
const SAVE_MS = 800;
const LIVE_MS = 1600;
const ERASE_R = 10;
const KEEPALIVE_MAX = 60_000; // fetch keepalive bodies cap at 64 KB

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- build

function button(tools: HTMLElement, id: string, title: string, fn: () => void, adv = false): HTMLButtonElement {
  const b = el('button', adv ? 'np-adv' : undefined);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(id));
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's selection
  b.addEventListener('click', fn);
  tools.append(b);
  return b;
}

function build(w: WardInstance): State {
  const root = el('div', 'np');
  const tools = el('div', 'np-tools');
  const page = el('div', 'np-page');
  const doc = el('div', 'np-doc');
  doc.contentEditable = 'true';
  doc.spellcheck = true;
  doc.setAttribute('role', 'textbox');
  doc.setAttribute('aria-multiline', 'true');
  doc.dataset.placeholder = 'Write, or pick up the pen…';
  const canvas = el('canvas', 'np-ink');
  canvas.setAttribute('aria-hidden', 'true');
  page.append(doc, canvas);
  const foot = el('div', 'np-foot');
  const status = el('span', 'np-status');
  const err = el('span', 'np-err');
  const count = el('span', 'np-count');
  foot.append(status, err, count);
  root.append(tools, page, foot);

  const color = el('input', 'np-adv');
  color.type = 'color';
  color.title = 'Ink colour';
  const width = el('input', 'np-adv');
  width.type = 'range';
  width.min = '1';
  width.max = '12';
  width.step = '0.5';
  width.value = '2.5';
  width.title = 'Pen width';

  const st: State = {
    w, cfg: noteConfig(w), root, page, doc, canvas, status, err, count, btn: {}, color, width, ai: null, sel: null,
    strokes: [], cur: null, fresh: new Set(), tool: 'text', penSeen: false,
    docTimer: 0, inkTimer: 0, liveTimer: 0, docDirty: false, inkDirty: false, busy: false,
    ro: new ResizeObserver(() => fit(st)),
  };
  const b = st.btn;
  const sep = (adv = false) => tools.append(el('span', adv ? 'np-sep np-adv' : 'np-sep'));

  // Text formatting — the expanded editor only; a ward has no room for it.
  b.heading = button(tools, 'heading', 'Heading (cycles H1 → H2 → H3 → text)', () => cycleHeading(st), true);
  b.bold = button(tools, 'bold', 'Bold (⌘B)', () => cmd(st, 'bold'), true);
  b.italic = button(tools, 'italic', 'Italic (⌘I)', () => cmd(st, 'italic'), true);
  b.underline = button(tools, 'underline', 'Underline (⌘U)', () => cmd(st, 'underline'), true);
  b.strike = button(tools, 'strike', 'Strikethrough', () => cmd(st, 'strikeThrough'), true);
  sep(true);
  b.list = button(tools, 'list', 'Bullet list', () => cmd(st, 'insertUnorderedList'), true);
  b.listOl = button(tools, 'list-ol', 'Numbered list', () => cmd(st, 'insertOrderedList'), true);
  b.quote = button(tools, 'quote', 'Quote', () => toggleBlock(st, 'blockquote'), true);
  b.code = button(tools, 'code', 'Code block', () => toggleBlock(st, 'pre'), true);
  b.outdent = button(tools, 'outdent', 'Outdent', () => cmd(st, 'outdent'), true);
  b.indent = button(tools, 'indent', 'Indent', () => cmd(st, 'indent'), true);
  b.link = button(tools, 'link', 'Link (⌘K)', () => link(st), true);
  b.clear = button(tools, 'clear-format', 'Clear formatting', () => { cmd(st, 'removeFormat'); cmd(st, 'formatBlock', 'p'); }, true);
  sep(true);
  b.undo = button(tools, 'undo', 'Undo', () => cmd(st, 'undo'), true);
  b.redo = button(tools, 'redo', 'Redo', () => cmd(st, 'redo'), true);
  sep(true);
  // Ink.
  b.pen = button(tools, 'brush', 'Pen', () => setTool(st, st.tool === 'pen' ? 'text' : 'pen'));
  b.eraser = button(tools, 'eraser', 'Eraser (whole strokes)', () => setTool(st, st.tool === 'eraser' ? 'text' : 'eraser'), true);
  tools.append(color, width);
  b.clearInk = button(tools, 'trash', 'Clear all ink', () => clearInk(st), true);
  b.transcribe = button(tools, 'wand', 'Transcribe the handwriting into text', () => void transcribe(st, st.strokes));
  sep();
  b.ai = button(tools, 'sparkle', 'Ask Rime — rewrite, fix, summarize, continue…', () => toggleAi(st));
  tools.append(el('span', 'np-grow'));
  b.download = button(tools, 'download', 'Download as HTML', () => download(st), true);
  b.print = button(tools, 'print', 'Print', () => print(st), true);
  b.expand = button(tools, 'resize', 'Expand into the editor', () => openDialog(st));

  doc.addEventListener('input', () => markDoc(st));
  doc.addEventListener('blur', () => void flushDoc(st));
  // Plain text in — formatting comes from the toolbar, never from a paste.
  doc.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) document.execCommand('insertText', false, text);
  });
  doc.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      link(st);
    } else if (e.key === 'Tab' && (e.target as HTMLElement).closest?.('li')) {
      e.preventDefault();
      cmd(st, e.shiftKey ? 'outdent' : 'indent');
    }
  });
  canvas.addEventListener('pointerdown', (e) => down(st, e));
  canvas.addEventListener('pointermove', (e) => move(st, e));
  canvas.addEventListener('pointerup', (e) => up(st, e));
  canvas.addEventListener('pointercancel', (e) => up(st, e));
  st.ro.observe(doc);
  st.ro.observe(page);
  return st;
}

/** Re-read the ward's knobs (config changed, or first paint). */
function apply(st: State): void {
  st.cfg = noteConfig(st.w);
  st.root.dataset.paper = st.cfg.paper;
  const ink = st.cfg.ink;
  for (const k of ['pen', 'eraser', 'clearInk']) st.btn[k]!.hidden = !ink;
  st.color.hidden = !ink;
  st.width.hidden = !ink;
  st.btn.transcribe!.hidden = !ink || st.cfg.transcribe === 'off';
  if (!ink) setTool(st, 'text');
  // The pen defaults to the text colour of THIS card — its theme, not the page's.
  if (!st.color.dataset.set) {
    const rgb = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(st.doc).color);
    st.color.value = rgb ? '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#3b82f6';
    st.color.dataset.set = '1';
  }
}

function mount(st: State, b: HTMLElement): void {
  b.textContent = '';
  b.classList.remove('overflow-y-auto');
  b.classList.add('flex');
  b.append(st.root);
  restoreExpandedWard(st.w.i, () => openDialog(st));
  fit(st);
}

// ------------------------------------------------------------- document

function cmd(st: State, name: string, value?: string): void {
  st.doc.focus();
  document.execCommand(name, false, value);
  markDoc(st);
}

function cycleHeading(st: State): void {
  const cur = String(document.queryCommandValue('formatBlock')).toLowerCase();
  cmd(st, 'formatBlock', cur === 'h1' ? 'h2' : cur === 'h2' ? 'h3' : cur === 'h3' ? 'p' : 'h1');
}

function toggleBlock(st: State, tag: string): void {
  const cur = String(document.queryCommandValue('formatBlock')).toLowerCase();
  cmd(st, 'formatBlock', cur === tag ? 'p' : tag);
}

function link(st: State): void {
  const url = window.prompt('Link to', 'https://');
  if (!url || url === 'https://') return;
  if (window.getSelection()?.isCollapsed) cmd(st, 'insertHTML', `<a href="${esc(url)}">${esc(url)}</a>`);
  else cmd(st, 'createLink', url);
}

/** Paragraphs on blank lines, <br> on single ones — text from the model or the pen. */
function paragraphs(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const para of text.split(/\n{2,}/)) {
    const p = el('p');
    para.split('\n').forEach((line, i) => {
      if (i) p.append(el('br'));
      p.append(line);
    });
    frag.append(p);
  }
  return frag;
}

/** Inline text with <br> for newlines — what replaces a selection. */
function inline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  text.split('\n').forEach((line, i) => {
    if (i) frag.append(el('br'));
    frag.append(line);
  });
  return frag;
}

/** Insert paragraphs at the page-y where they were written: before the first
 *  block below it, else at the end. */
function insertAt(st: State, text: string, y: number): void {
  const rect = st.page.getBoundingClientRect();
  let before: Element | null = null;
  for (const child of st.doc.children) {
    if (child.getBoundingClientRect().top - rect.top + st.page.scrollTop > y) {
      before = child;
      break;
    }
  }
  st.doc.insertBefore(paragraphs(text), before);
  markDoc(st);
}

function updateCount(st: State): void {
  const n = st.doc.innerText.trim().split(/\s+/).filter(Boolean).length;
  st.count.textContent = n ? `${n} word${n === 1 ? '' : 's'}` : '';
}

// ------------------------------------------------------------------ save

const fmtTime = (iso: string) => new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function setStatus(st: State, text: string): void {
  st.status.textContent = text;
  st.err.textContent = '';
}
function fail(st: State, text: string): void {
  st.err.textContent = text;
  st.err.title = text;
}

const pendingWrites = new Set<Promise<unknown>>();
async function put(st: State, patch: { html?: string; ink?: string }, unload = false): Promise<boolean> {
  setStatus(st, 'Saving…');
  const saving = postJson(`/api/note/${st.w.i}`, patch, 'PUT', unload && JSON.stringify(patch).length < KEEPALIVE_MAX ? { keepalive: true } : {});
  pendingWrites.add(saving);
  const res = await saving.finally(() => pendingWrites.delete(saving));
  if (!res.ok) {
    fail(st, res.status === 0 ? 'Save failed — offline?' : (res.data?.error ?? 'Save failed'));
    return false;
  }
  setStatus(st, `Saved ${fmtTime((res.data as { updated: string }).updated)}`);
  return true;
}

function markDoc(st: State): void {
  // Text typed into an empty document lands as a bare text node; give it the
  // paragraph every later line gets (the command re-fires input, once).
  if (st.doc.firstChild?.nodeType === Node.TEXT_NODE && document.activeElement === st.doc) document.execCommand('formatBlock', false, 'p');
  st.docDirty = true;
  setStatus(st, 'Editing…');
  updateCount(st);
  clearTimeout(st.docTimer);
  st.docTimer = window.setTimeout(() => void flushDoc(st), SAVE_MS);
}
async function flushDoc(st: State, unload = false): Promise<void> {
  clearTimeout(st.docTimer);
  if (!st.docDirty) return;
  st.docDirty = false;
  if (!(await put(st, { html: st.doc.innerHTML }, unload))) st.docDirty = true;
}
function markInk(st: State): void {
  st.inkDirty = true;
  clearTimeout(st.inkTimer);
  st.inkTimer = window.setTimeout(() => void flushInk(st), SAVE_MS);
}
async function flushInk(st: State, unload = false): Promise<void> {
  clearTimeout(st.inkTimer);
  if (!st.inkDirty) return;
  st.inkDirty = false;
  // One decimal is a tenth of a CSS pixel — invisible, and half the bytes.
  const ink = JSON.stringify(st.strokes.map((s) => ({ ...s, p: s.p.map((q) => q.map((n) => Math.round(n * 10) / 10)) })));
  if (!(await put(st, { ink }, unload))) st.inkDirty = true;
}

async function load(st: State): Promise<void> {
  const res = await fetch(`/api/note/${st.w.i}`, { headers: { accept: 'application/json' } }).catch(() => null);
  const d = res?.ok ? ((await res.json().catch(() => null)) as { html: string; ink: string; updated: string | null } | null) : null;
  if (!d) {
    fail(st, 'Could not load the note.');
    return;
  }
  st.doc.innerHTML = d.html; // sanitized server-side — the only HTML this ward ever trusts
  try {
    const raw = JSON.parse(d.ink) as unknown;
    st.strokes = Array.isArray(raw) ? raw.filter((s): s is Stroke => !!s && typeof s === 'object' && Array.isArray((s as Stroke).p)) : [];
  } catch {
    st.strokes = [];
  }
  updateCount(st);
  setStatus(st, d.updated ? `Saved ${fmtTime(d.updated)}` : '');
  fit(st);
  const saved = readDesktopCheckpoint<{ tool: Tool; color: string; width: string; top: number; left: number }>(`note:${st.w.i}`);
  if (saved) {
    if (['text', 'pen', 'eraser'].includes(saved.tool)) setTool(st, saved.tool);
    if (/^#[0-9a-f]{6}$/i.test(saved.color)) st.color.value = saved.color;
    if (Number(saved.width) >= 1 && Number(saved.width) <= 12) st.width.value = saved.width;
    requestAnimationFrame(() => st.page.scrollTo(saved.left, saved.top));
  }
}

// ------------------------------------------------------------------- ink

function setTool(st: State, tool: Tool): void {
  st.tool = tool;
  st.root.dataset.tool = tool;
  st.btn.pen!.setAttribute('aria-pressed', String(tool === 'pen'));
  st.btn.eraser!.setAttribute('aria-pressed', String(tool === 'eraser'));
  if (tool !== 'text') st.doc.blur();
}

/** The canvas covers the whole scroll content — the text, plus whatever ink
 *  runs below it (the page grows to hold it). Backing store at device pixels. */
function fit(st: State): void {
  const { page, doc, canvas } = st;
  if (!page.isConnected) return;
  let maxY = 0;
  for (const s of st.strokes) for (const p of s.p) if (p[1] > maxY) maxY = p[1];
  const w = page.clientWidth;
  const h = Math.max(page.clientHeight, doc.offsetTop + doc.offsetHeight, Math.ceil(maxY) + 48);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  redraw(st);
}

function segment(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, s: Stroke): void {
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.w * (0.35 + 1.3 * b[2]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.p.length === 1) {
    const p = s.p[0]!;
    ctx.fillStyle = s.c;
    ctx.beginPath();
    ctx.arc(p[0], p[1], (s.w * (0.35 + 1.3 * p[2])) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < s.p.length; i++) segment(ctx, s.p[i - 1]!, s.p[i]!, s);
}
function ctxOf(st: State): CanvasRenderingContext2D {
  const ctx = st.canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}
function redraw(st: State): void {
  const ctx = ctxOf(st);
  ctx.clearRect(0, 0, st.canvas.width, st.canvas.height);
  for (const s of st.strokes) drawStroke(ctx, s);
}

function pt(st: State, e: PointerEvent): Pt {
  const r = st.page.getBoundingClientRect();
  const pressure = e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5;
  return [e.clientX - r.left + st.page.scrollLeft, e.clientY - r.top + st.page.scrollTop, pressure];
}
/** A finger while a pen is in use is a palm. */
const palm = (st: State, e: PointerEvent) => e.pointerType === 'touch' && st.penSeen;

function down(st: State, e: PointerEvent): void {
  if (st.tool === 'text' || palm(st, e)) return;
  if (e.pointerType === 'pen') st.penSeen = true;
  e.preventDefault();
  st.canvas.setPointerCapture(e.pointerId);
  const p = pt(st, e);
  if (st.tool === 'eraser') {
    erase(st, p);
    return;
  }
  st.cur = { c: st.color.value, w: Number(st.width.value) || 2.5, p: [p] };
  st.strokes.push(st.cur);
  drawStroke(ctxOf(st), st.cur);
}
function move(st: State, e: PointerEvent): void {
  if (st.tool === 'text' || palm(st, e)) return;
  if (st.tool === 'eraser') {
    if (e.buttons) erase(st, pt(st, e));
    return;
  }
  if (!st.cur) return;
  const ctx = ctxOf(st);
  const evs = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    const p = pt(st, ev);
    segment(ctx, st.cur.p[st.cur.p.length - 1]!, p, st.cur);
    st.cur.p.push(p);
  }
}
function up(st: State, e: PointerEvent): void {
  if (st.canvas.hasPointerCapture(e.pointerId)) st.canvas.releasePointerCapture(e.pointerId);
  const s = st.cur;
  st.cur = null;
  if (!s) return;
  st.fresh.add(s);
  markInk(st);
  fit(st);
  if (st.cfg.transcribe === 'live') scheduleLive(st);
}
function erase(st: State, at: Pt): void {
  const before = st.strokes.length;
  st.strokes = st.strokes.filter((s) => !s.p.some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) <= ERASE_R + s.w));
  if (st.strokes.length === before) return;
  for (const s of st.fresh) if (!st.strokes.includes(s)) st.fresh.delete(s);
  redraw(st);
  markInk(st);
}
function clearInk(st: State): void {
  if (!st.strokes.length || !window.confirm('Clear all the ink on this note?')) return;
  st.strokes = [];
  st.fresh.clear();
  redraw(st);
  markInk(st);
}

// ----------------------------------------------------------- handwriting

function scheduleLive(st: State): void {
  clearTimeout(st.liveTimer);
  st.liveTimer = window.setTimeout(() => void transcribe(st, [...st.fresh]), LIVE_MS);
}

function bbox(set: Stroke[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of set)
    for (const p of s.p) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** The strokes alone, black on white, cropped and scaled to what a vision
 *  model reads best: small writing is enlarged, a whole page capped at 1024. */
function inkImage(set: Stroke[], b: { x: number; y: number; w: number; h: number }): string {
  const pad = 24;
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  const scale = Math.min(2, Math.max(0.5, 1024 / Math.max(w, h)));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - b.x, pad - b.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of set) drawStroke(ctx, { ...s, c: '#000' });
  return c.toDataURL('image/png');
}

function setBusy(st: State, busy: boolean): void {
  st.busy = busy;
  st.btn.transcribe!.disabled = busy;
  st.btn.ai!.disabled = busy;
}

async function transcribe(st: State, strokes: Stroke[]): Promise<void> {
  const set = strokes.filter((s) => st.strokes.includes(s));
  if (!set.length || st.busy) {
    if (set.length && st.cfg.transcribe === 'live') scheduleLive(st); // busy: try again after
    return;
  }
  const b = bbox(set);
  setBusy(st, true);
  setStatus(st, 'Reading the handwriting…');
  const res = await postJson(`/api/note/${st.w.i}`, { action: 'transcribe', image: inkImage(set, b) });
  const d = res.data as { text?: string; error?: string } | null;
  setBusy(st, false);
  if (!res.ok) {
    fail(st, d?.error ?? 'Could not read the handwriting.');
    return;
  }
  for (const s of set) st.fresh.delete(s);
  const text = String(d?.text ?? '').trim();
  if (!text) {
    setStatus(st, 'No writing found in the ink.');
    return;
  }
  insertAt(st, text, b.y);
  if (!st.cfg.keepInk) {
    st.strokes = st.strokes.filter((s) => !set.includes(s));
    redraw(st);
    markInk(st);
  }
  if (st.fresh.size && st.cfg.transcribe === 'live') scheduleLive(st);
}

// -------------------------------------------------------------- ✨ Rime

const MODES: [string, string][] = [
  ['fix', 'Fix grammar'],
  ['shorten', 'Shorten'],
  ['expand', 'Expand'],
  ['summarize', 'Summarize'],
  ['continue', 'Continue writing'],
  ['outline', 'Outline'],
  ['custom', 'Custom…'],
];
/** Modes whose result replaces the passage; the rest add to it. */
const REPLACES = new Set(['fix', 'shorten', 'expand']);

function toggleAi(st: State): void {
  if (st.ai) {
    st.ai.remove();
    st.ai = null;
    return;
  }
  const bar = el('div', 'np-ai');
  const mode = el('select', 'input');
  for (const [v, l] of MODES) {
    const o = el('option', undefined, l);
    o.value = v;
    mode.append(o);
  }
  const prompt = el('input', 'input np-ai-prompt');
  prompt.type = 'text';
  prompt.maxLength = 1000;
  prompt.placeholder = 'Or tell Rime what to do…';
  const run = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'Run');
  run.type = 'button';
  run.addEventListener('mousedown', (e) => e.preventDefault());
  bar.append(mode, prompt, run, el('span', 'w-full text-[10px] text-ink-faint', 'Works on the selection — or the whole note when nothing is selected.'));
  const go = () => {
    const custom = prompt.value.trim();
    void runAi(st, custom ? 'custom' : mode.value, custom);
  };
  run.addEventListener('click', go);
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  mode.addEventListener('change', () => {
    if (mode.value === 'custom') prompt.focus();
  });
  st.root.append(bar);
  st.ai = bar;
}

const blockOf = (node: Node, doc: HTMLElement): Element | null => {
  let n: Node | null = node;
  while (n && n.parentNode !== doc) n = n.parentNode;
  return n instanceof Element ? n : null;
};

async function runAi(st: State, mode: string, prompt: string): Promise<void> {
  if (st.busy) return;
  const range = st.sel && !st.sel.collapsed && st.doc.contains(st.sel.commonAncestorContainer) ? st.sel.cloneRange() : null;
  const text = range ? range.toString() : st.doc.innerText;
  if (!text.trim()) {
    fail(st, 'Nothing to work on yet.');
    return;
  }
  setBusy(st, true);
  setStatus(st, 'Rime is thinking…');
  const res = await postJson(`/api/note/${st.w.i}`, { action: 'ai', mode, prompt, text });
  const d = res.data as { text?: string; error?: string } | null;
  setBusy(st, false);
  if (!res.ok) {
    fail(st, d?.error ?? 'Rime could not do that.');
    return;
  }
  const out = String(d?.text ?? '').trim();
  if (!out) {
    setStatus(st, 'Rime had nothing to add.');
    return;
  }
  if (range && (REPLACES.has(mode) || mode === 'custom')) {
    range.deleteContents();
    range.insertNode(inline(out));
  } else if (range) {
    const block = blockOf(range.endContainer, st.doc);
    if (block) block.after(paragraphs(out));
    else st.doc.append(paragraphs(out));
  } else if (REPLACES.has(mode)) {
    st.doc.textContent = '';
    st.doc.append(paragraphs(out));
  } else st.doc.append(paragraphs(out));
  st.sel = null;
  markDoc(st);
  setStatus(st, 'Done — ⌘Z undoes it.');
}

// ------------------------------------------------------------- export

function exportHtml(st: State): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(wardTitle(st.w))}</title><style>body{max-width:60rem;margin:2rem auto;padding:0 1rem;font:16px/1.7 system-ui,sans-serif}blockquote{border-left:3px solid #999;margin:0;padding-left:.75em;color:#555}pre{background:#f3f3f3;padding:.5em .65em;white-space:pre-wrap}</style>${st.doc.innerHTML}`;
}
function download(st: State): void {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([exportHtml(st)], { type: 'text/html' }));
  a.download = `${wardTitle(st.w).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'note'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
function print(st: State): void {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(exportHtml(st));
  w.document.close();
  w.focus();
  w.print();
}

// -------------------------------------------------------- shared dialog

let dlg: HTMLDialogElement | null = null;
let shown: State | null = null;

function dialog(): HTMLDialogElement | null {
  if (dlg) return dlg;
  const d = document.getElementById('note-dialog') as HTMLDialogElement | null;
  if (!d) return null;
  dlg = d;
  d.querySelector('[data-nd-close]')?.addEventListener('click', () => d.close());
  d.addEventListener('close', () => {
    const st = shown;
    shown = null;
    expandedDesktopWard();
    if (!st) return;
    delete st.root.dataset.full;
    st.btn.expand!.hidden = false;
    const b = body(st.w.i);
    if (b && states.get(st.w.i) === st) mount(st, b);
  });
  return d;
}

function openDialog(st: State): void {
  const d = dialog();
  if (!d) return;
  if (shown) d.close();
  shown = st;
  expandedDesktopWard(st.w.i);
  d.querySelector('[data-nd-title]')!.textContent = wardTitle(st.w);
  st.root.dataset.full = '';
  st.btn.expand!.hidden = true; // the dialog's ✕ is the way back
  d.querySelector('[data-nd-host]')!.append(st.root);
  const b = body(st.w.i);
  if (b) {
    b.textContent = '';
    b.append(el('p', 'wd-note text-xs text-ink-faint', 'Open in the editor…'));
  }
  d.showModal();
  fit(st);
}

// -------------------------------------------------------------- registry

document.execCommand('defaultParagraphSeparator', false, 'p');

// The ✨ bar takes focus, so the selection it should work on is the last one
// made inside a document — tracked here, once, for every notepad on the page.
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  for (const st of states.values()) if (st.doc.contains(range.commonAncestorContainer)) st.sel = range.cloneRange();
});
// The agent's write_note landed (logic.ts relays the stream event): pull the
// new document unless the user is mid-edit — their keystrokes win.
window.addEventListener('fd:note', (e) => {
  const st = states.get(String((e as CustomEvent<{ ward?: string }>).detail?.ward ?? ''));
  if (st && !st.docDirty) void load(st);
});
window.addEventListener('fd:before-workspace-navigation', event => {
  (event as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil((async () => {
    await Promise.all(pendingWrites);
    for (const st of states.values()) {
      if (st.busy) throw Error('Wait for the note operation to finish before relaunching.');
      await Promise.all([flushDoc(st), flushInk(st)]);
      if (st.docDirty || st.inkDirty) throw Error('The note could not be saved. Try again before relaunching.');
      saveDesktopState(`note:${st.w.i}`, { tool: st.tool, color: st.color.value, width: st.width.value, top: st.page.scrollTop, left: st.page.scrollLeft });
    }
  })());
});
window.addEventListener('pagehide', () => {
  for (const st of states.values()) {
    void flushDoc(st, true);
    void flushInk(st, true);
  }
});

RENDERERS.note = {
  render(w) {
    const b = body(w.i);
    if (!b) return;
    let st = states.get(w.i);
    if (!st) {
      st = build(w);
      states.set(w.i, st);
      apply(st);
      mount(st, b);
      void load(st);
      return;
    }
    st.w = w;
    apply(st);
    if (shown === st) return; // it is in the dialog; the body already says so
    mount(st, b);
  },
  stop(id) {
    const st = states.get(id);
    if (!st) return;
    void flushDoc(st);
    void flushInk(st);
    st.ro.disconnect();
    clearTimeout(st.liveTimer);
    states.delete(id);
    if (shown === st) dlg?.close();
  },
};
