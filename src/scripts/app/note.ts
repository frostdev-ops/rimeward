import { expandedDesktopWard, restoreExpandedWard, readDesktopCheckpoint, saveDesktopState } from "./desktop-state.ts";
// The note editor: a rich-text document — contenteditable and execCommand,
// the browser's own editor, no library — with an ink layer over it (pointer
// strokes on a canvas that scrolls with the page) and a footer. Both halves
// autosave to /api/note/<id>. The editor is bound to a TARGET (a document id,
// its API address, the knobs it draws with), not to a ward: the notepad ward
// (type `note`) gives it one target for life and Expand moves the SAME element
// into #note-dialog (one document, one canvas, no second state) where the full
// toolbar shows; the notebook (notebook.ts) owns one editor and points it at
// whichever note is selected — `open()` flushes what is pending first and
// refuses to switch while a save fails, and every late answer (a load, a
// transcription, a ✨ result) checks it still belongs to the target it was
// asked for. Every save carries the rev it started from; a 409 (another
// surface saved in between) stops autosave on that document until the user
// picks Reload or Keep mine — nothing is overwritten silently.
// Reading handwriting and the ✨ commands are one-shot model calls the server
// makes with the target's provider/model (lib/agent/oneshot.ts) — the editor
// only ever ships a PNG of the strokes, or a passage of text.
//
// ponytail: ink is stored in absolute page px — reflowing the text at another
// width leaves the strokes where they were. Store them relative to the line
// they were written on if that ever matters.

import { noteConfig, wardTitle, type NoteConfig, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body } from './wards.ts';
import { el, newId, postJson, toast } from './dom.ts';
import { shareReadOnly } from './share-view.ts';
import type { DocumentEditor } from './note-editor.ts';
import { icon, relabel } from './icon.ts';
import { askText, confirmAction } from './workspace-dialogs.ts';
import { pageDocument, readPageDocument, type NotebookPageType } from '../../lib/notebook-pages.ts';
import { sanitizeHtml, plainText, textToHtml } from '../../lib/note-text.ts';
import { saveDocumentBlob, printDocument } from './document-export.ts';
import { menuItem, openMenu } from './menu.ts';
import { popupLayer, popupFrame, popupViewport } from './popup-layer.ts';
import { createNotebookPage } from './notebook-page-editors.ts';
import type { NotebookPageEngine } from './notebook-page-engine.ts';
import { attachWordEditor } from './note-word.ts';
import { attachProofreading } from './note-proofreading.ts';
import { exportDocx } from './note-docx.ts';
import { importNotebookFile, pickNotebookFiles } from './notebook-import.ts';
import TurndownService from 'turndown';
import { marked } from 'marked';

/** [x, y] in page CSS px (the scroll content's box), pressure 0..1. */
type Pt = [number, number, number];
interface Stroke {
  /** Set by the collaborative editor so a stroke can be erased by name wherever it is drawn. */
  id?: string;
  c: string;
  w: number;
  p: Pt[];
}
/** The collaborative (ProseMirror + Yjs) document editor, opted into per browser while
 *  the ribbon and review tools are ported to it: `localStorage['fd-note-editor'] = 'pm'`. */
const PM = (() => { try { return localStorage.getItem('fd-note-editor') === 'pm'; } catch { return false; } })();
type Tool = 'text' | 'pen' | 'eraser';

/** What an editor edits: one document, addressed and drawn one way. */
export interface EditorTarget {
  /** The document id. */
  id: string;
  /** `/api/note/<id>` plus whatever query routes it (a notebook note carries `?ward=<notebook ward>`). */
  api: string;
  title: string;
  cfg: NoteConfig;
}

interface State {
  /** The ward this editor answers for in the flush handlers (mention, relaunch). */
  owner: string;
  pageEngine: NotebookPageEngine | null;
  pageType: NotebookPageType | null;
  replacePage: boolean;
  engineHost: HTMLElement;
  format: HTMLSelectElement;
  word: ReturnType<typeof attachWordEditor> | null;
  proof: ReturnType<typeof attachProofreading> | null;
  /** The collaborative editor over this document, when PM is on and the room took us. */
  editor: DocumentEditor | null;
  /** The ribbon over it (note-word-pm.ts). */
  ribbon: { destroy(): void } | null;
  /** The room refused this document once: the plain editor for the rest of this open. */
  pmFailed: boolean;
  /** The collaborative editor's modules are on their way (they load on first use). */
  connecting: boolean;
  target: EditorTarget | null;
  /** The stored revision of the open document; every save hands it back. */
  rev: number;
  etag?: string;
  loaded: boolean;
  loadGen: number;
  /** Bumped on every open(): a late answer for an older generation is dropped. */
  gen: number;
  /** Saves run one after another so each carries the rev the last one returned. */
  chain: Promise<unknown>;
  /** open() calls run one after another: two rapid selections never interleave their flushes. */
  opening: Promise<unknown>;
  /** Bumped per edit; a flush clears the dirty flag only when nothing was typed/drawn since it was queued. */
  docSeq: number;
  inkSeq: number;
  /** The save in flight for that seq, if any — a second flush for the same content joins it instead of saving twice. */
  docFlight: { seq: number; p: Promise<boolean> } | null;
  inkFlight: { seq: number; p: Promise<boolean> } | null;
  /** A 409 is waiting on the user: autosave holds until Reload or Keep mine. */
  conflict: boolean;
  /** A save is in flight — its own broadcast echo must not reload the document under the caret. */
  saving: number;
  root: HTMLElement;
  page: HTMLElement;
  doc: HTMLElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  err: HTMLElement;
  count: HTMLElement;
  exportStatus: HTMLElement;
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
  /** Whoever hosts the editor hears about edits (the notebook's outline). */
  onInput: (() => void) | null;
}

const states = new Map<string, State>();
const SAVE_MS = 800;
const LIVE_MS = 1600;
const ERASE_R = 10;
const KEEPALIVE_MAX = 60_000; // fetch keepalive bodies cap at 64 KB

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bind requests to the document, including while Configure has not saved the layout yet. */
const wardTarget = (w: WardInstance): EditorTarget => {
  const id = typeof w.config?.note === 'string' && w.config.note ? w.config.note : w.i;
  return { id, api: `/api/note/${id}?ward=${w.i}`, title: wardTitle(w), cfg: noteConfig(w) };
};

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

function build(owner: string, expandable: boolean): State {
  const root = el('div', 'np');
  const tools = el('div', 'np-tools');
  const page = el('div', 'np-page');
  const doc = el('div', 'np-doc');
  doc.contentEditable = 'true';
  doc.spellcheck = true;
  doc.setAttribute('role', 'textbox');
  doc.setAttribute('aria-multiline', 'true');
  doc.setAttribute('aria-label', 'Note text');
  doc.dataset.placeholder = 'Write, or pick up the pen…';
  const canvas = el('canvas', 'np-ink');
  canvas.setAttribute('aria-hidden', 'true');
  page.append(doc, canvas);
  const foot = el('div', 'np-foot');
  const status = el('span', 'np-status');
  status.setAttribute('role', 'status');
  const err = el('span', 'np-err');
  err.setAttribute('role', 'alert');
  const count = el('span', 'np-count');
  const exportStatus = el('span', 'np-export-status'); exportStatus.setAttribute('role', 'status');
  foot.append(status, err, exportStatus, count);
  const engineHost = el('div', 'np-engine-host');
  engineHost.hidden = true;
  const format = el('select', 'input np-format');
  format.setAttribute('aria-label', 'Document format');
  format.dataset.pageControl = '';
  format.append(new Option('Document', 'document'), new Option('Markdown', 'markdown'));
  tools.prepend(format);
  root.append(tools, page, engineHost, foot);

  const color = el('input', 'np-adv');
  color.type = 'color';
  color.title = 'Ink colour';
  color.setAttribute('aria-label', 'Ink colour');
  const width = el('input', 'np-adv');
  width.type = 'range';
  width.min = '1';
  width.max = '12';
  width.step = '0.5';
  width.value = '2.5';
  width.title = 'Pen width';
  width.setAttribute('aria-label', 'Pen width');

  const st: State = {
    owner, pageEngine: null, pageType: null, replacePage: false, engineHost, format, word: null, proof: null, editor: null, ribbon: null, pmFailed: false, connecting: false, target: null, rev: 0, loaded: false, loadGen: 0, gen: 0, chain: Promise.resolve(), opening: Promise.resolve(), docSeq: 0, inkSeq: 0, docFlight: null, inkFlight: null, conflict: false, saving: 0,
    root, page, doc, canvas, status, err, count, exportStatus, btn: {}, color, width, ai: null, sel: null,
    strokes: [], cur: null, fresh: new Set(), tool: 'text', penSeen: false,
    docTimer: 0, inkTimer: 0, liveTimer: 0, docDirty: false, inkDirty: false, busy: false,
    ro: new ResizeObserver(() => fit(st)),
    onInput: null,
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
  b.download = button(tools, 'download', 'Export document', () => exportMenu(st), true);
  b.download.classList.add('np-export-button');
  b.download.append(el('span', undefined, 'Export'));
  b.download.dataset.pageControl = '';
  b.download.setAttribute('aria-haspopup', 'menu');
  b.print = button(tools, 'print', 'Print', () => print(st), true);
  b.expand = button(tools, 'resize', 'Expand into the editor', () => openDialog(st));
  b.expand.hidden = !expandable;
  b.expand.dataset.pageControl = '';
  format.onchange = () => void changeFormat(st, format.value);

  doc.addEventListener('input', () => {
    markDoc(st);
    linkPicker(st);
  });
  doc.addEventListener('blur', () => void flushDoc(st));
  // A note link opens that note (the notebook answers fd:open-note); the browser never follows an <a> inside contenteditable anyway.
  doc.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[data-note]') as HTMLElement | null;
    if (!a?.dataset.note) return;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('fd:open-note', { detail: { note: a.dataset.note, from: st.owner } }));
  });
  doc.addEventListener('keydown', (e) => {
    if (pickerKeys(st, e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      link(st);
    } else if (!st.editor && e.key === 'Tab' && (e.target as HTMLElement).closest?.('li')) {
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
  attachLegacyTools(st, tools);
  const importButton = button(tools, 'folder', 'Import file', () => {
    if (!st.target || !st.loaded) { toast('Wait for the document to finish loading before importing.', undefined, true); return; }
    pickNotebookFiles(async files => {
      const selected = files[0]; if (!selected || !st.target || !st.loaded || importButton.disabled) return;
      const gen = st.gen, loadGen = st.loadGen, docSeq = st.docSeq, inkSeq = st.inkSeq;
      const unchanged = () => st.gen === gen && st.loadGen === loadGen && st.docSeq === docSeq && st.inkSeq === inkSeq;
      importButton.disabled = true;
      try {
        const imported = await importNotebookFile(selected);
        if (!unchanged()) { toast('The document changed while opening the file. Import again to continue.', undefined, true); return; }
        const hasContent = st.pageEngine || st.doc.textContent?.trim() || st.doc.querySelector('img,table') || st.strokes.length;
        if (hasContent && !await confirmAction('Replace this document’s content with the imported file? Existing ink is kept.')) return;
        if (!unchanged()) { toast('The document changed. Import again to continue.', undefined, true); return; }
        if (!(await replaceDocument(st, imported.html))) return;
        toast(imported.warnings.length ? `Imported ${imported.title}. ${imported.warnings.join(' ')}` : `Imported ${imported.title}.`);
      } finally { importButton.disabled = !st.target || !st.loaded; }
    }, false);
  }, true);
  importButton.dataset.noteOpenFile = '';
  importButton.dataset.pageControl = '';
  importButton.append(el('span', undefined, 'Import file'));
  return st;
}

/** The ribbon and the grammar tools drive the plain contenteditable; the collaborative
 *  editor owns its DOM, so they are detached while it runs and back when it is not. */
function attachLegacyTools(st: State, tools = st.root.querySelector<HTMLElement>('.np-tools')!): void {
  if (st.word || st.editor) return;
  st.word = attachWordEditor({ doc: st.doc, tools, changed: () => markDoc(st), title: () => st.target?.title ?? 'Document', identity: () => `${st.gen}:${st.loadGen}` });
  st.proof = attachProofreading({ doc: st.doc, tools, api: () => st.loaded && !st.pageEngine && !st.editor ? st.target?.api ?? null : null, onChange: () => markDoc(st), replace: (range, text) => st.word!.replace(range, text) });
}

// ProseMirror + Yjs ride their own chunk, fetched the first time a collaborative document opens.
type Collab = { createDocumentEditor: typeof import('./note-editor.ts').createDocumentEditor; attachWordRibbon: typeof import('./note-word-pm.ts').attachWordRibbon; attachProofreadingPm: typeof import('./note-proofreading-pm.ts').attachProofreadingPm };
let collab: Promise<Collab> | undefined;
const loadCollab = (): Promise<Collab> => (collab ??= Promise.all([import('./note-editor.ts'), import('./note-word-pm.ts'), import('./note-proofreading-pm.ts')]).then(([a, b, c]) => ({ createDocumentEditor: a.createDocumentEditor, attachWordRibbon: b.attachWordRibbon, attachProofreadingPm: c.attachProofreadingPm })));

/** Bind the collaborative editor to the open document: the room's copy is the truth from here. */
function connectEditor(st: State): void {
  const t = st.target;
  if (st.editor || st.connecting || !t) return;
  st.connecting = true;
  const gen = st.gen;
  loadCollab().then((mod) => {
    st.connecting = false;
    if (st.gen !== gen || st.editor || st.target !== t || st.pmFailed || st.pageEngine || !st.loaded) return;
    st.word?.destroy(); st.word = null;
    st.proof?.destroy(); st.proof = null;
    st.root.dataset.pm = '';
    const ward = new URL(t.api, location.origin).searchParams.get('ward') ?? '';
    const editor = mod.createDocumentEditor({
      mount: st.doc, docId: t.id, ward, readOnly: shareReadOnly,
      onChange: () => { if (st.editor !== editor) return; updateCount(st); st.onInput?.(); },
      onStatus: (status) => { if (st.editor !== editor) return; setStatus(st, status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline — reconnecting…'); },
      onFail: () => { if (st.editor !== editor) return; st.pmFailed = true; disconnectEditor(st); void load(st, true); },
      onPersist: (status) => { if (st.editor !== editor) return; if (status.persist === 'error') fail(st, `Not saved: ${status.message ?? 'the server refused the change'}`); else { st.err.textContent = ''; setStatus(st, 'Live'); } },
    });
    st.editor = editor;
    const tools = st.root.querySelector<HTMLElement>('.np-tools')!;
    st.ribbon = mod.attachWordRibbon({ editor, tools, changed: () => markDoc(st), title: () => st.target?.title ?? 'Document' });
    st.proof = mod.attachProofreadingPm({ editor, tools, api: () => (st.loaded && st.editor === editor ? st.target?.api ?? null : null), onChange: () => markDoc(st) });
    // Ink is a shared list too: whatever anyone draws lands here.
    editor.ink.observe(() => {
      if (st.editor !== editor) return;
      const fresh = new Set([...st.fresh].map((s) => s.id));
      st.strokes = editor.ink.toJSON() as Stroke[];
      if (st.cur) st.strokes.push(st.cur);
      st.fresh = new Set(st.strokes.filter((s) => s.id && fresh.has(s.id)));
      st.inkDirty = false;
      fit(st);
    });
    apply(st);
  }, () => { st.connecting = false; st.pmFailed = true; if (st.gen === gen && st.target === t) void load(st, true); });
}
function disconnectEditor(st: State): void {
  const e = st.editor;
  if (!e) return;
  st.editor = null;
  st.ribbon?.destroy(); st.ribbon = null;
  st.proof?.destroy(); st.proof = null;
  delete st.root.dataset.pm;
  e.destroy();
  attachLegacyTools(st);
}

function serializeDocument(st: State): string {
  if (st.pageEngine && st.pageType) return pageDocument(st.pageType, st.pageEngine.serialize(), st.pageEngine.text());
  return st.editor ? st.editor.html() : st.doc.innerHTML;
}
function showDocument(st: State, html: string): void {
  const data = readPageDocument(html);
  let engine: NotebookPageEngine | null = null;
  if (data) {
    if (data.type !== 'markdown' && data.state !== null && (typeof data.state !== 'object' || (data.state as { version?: unknown }).version !== 1)) throw Error('This page uses an unsupported format version.');
    engine = createNotebookPage(data.type, { api: () => st.loaded ? st.target?.api ?? null : null, onChange: () => {
      if (!engine || st.pageEngine !== engine) return;
      st.doc.textContent = engine.text(); markDoc(st);
    } });
    try { engine.load(data.state); } catch (error) { engine.destroy(); throw error; }
  }
  st.pageEngine?.destroy(); st.pageEngine = engine; st.pageType = data?.type ?? null;
  if (data) disconnectEditor(st);
  st.engineHost.replaceChildren(); st.engineHost.hidden = !data; st.page.hidden = !!data;
  st.proof?.refresh();
  st.exportStatus.textContent = '';
  st.format.replaceChildren(new Option('Document', 'document'), new Option('Markdown', 'markdown'));
  if (data && engine) {
    st.root.dataset.pageType = data.type;
    if (data.type !== 'markdown') st.format.append(new Option(data.type === 'notion' ? 'Linked Notion database' : data.type[0]!.toUpperCase() + data.type.slice(1), data.type));
    st.format.value = data.type;
    st.engineHost.append(engine.element); st.doc.textContent = engine.text();
  } else {
    delete st.root.dataset.pageType;
    st.format.value = 'document';
    // Only a LOADED document joins the room (its own load says it is prose, not a structured
    // page); the room's copy replaces `html`. The empty document shown while opening stays plain.
    if (PM && !st.pmFailed && st.target && st.loaded) connectEditor(st);
    else { st.doc.innerHTML = html; st.word?.refresh(); }
  }
  apply(st);
}

/** Put a whole new document in place — an import, a format conversion. Through the
 *  shared document when it stays free text; through the store when a page type changes. */
async function replaceDocument(st: State, html: string): Promise<boolean> {
  if (st.editor && !readPageDocument(html)) { st.editor.setHtml(html); return true; }
  if (st.editor || (PM && !st.pmFailed && !readPageDocument(html) && st.pageEngine)) {
    const ok = await put(st, { html, replacePage: true }, false, true);
    if (ok) await load(st, true);
    return ok;
  }
  showDocument(st, html); st.replacePage = true; markDoc(st);
  return flushDoc(st);
}
function documentMarkdown(html: string): string {
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.addRule('strike', { filter: node => ['S', 'STRIKE', 'DEL'].includes(node.nodeName), replacement: content => `~~${content}~~` });
  converter.addRule('task', { filter: node => node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox', replacement: (_, node) => (node as HTMLInputElement).checked ? '[x] ' : '[ ] ' });
  converter.addRule('table', { filter: 'table', replacement: (_, node) => {
    const rows = [...(node as HTMLTableElement).rows].map(row => [...row.cells].map(cell => (cell.textContent ?? '').trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
    return `\n\n${line(rows[0]!)}\n${line(Array(width).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
  } });
  return converter.turndown(html);
}
async function changeFormat(st: State, value: string): Promise<void> {
  if (!st.target || !st.loaded || value === (st.pageType ?? 'document')) return;
  if (st.pageType && st.pageType !== 'markdown') { st.format.value = st.pageType; return; }
  if (!await confirmAction(`Switch to ${value === 'markdown' ? 'Markdown' : 'Document'}? The content is kept, but formatting that the other format cannot represent may change.`)) { st.format.value = st.pageType ?? 'document'; return; }
  if (value === 'markdown') {
    const source = documentMarkdown(st.editor ? st.editor.html() : st.doc.innerHTML);
    await replaceDocument(st, pageDocument('markdown', { source }));
  } else if (st.pageType === 'markdown') {
    const source = (st.pageEngine!.serialize() as { source: string }).source;
    await replaceDocument(st, sanitizeHtml(marked.parse(source, { async: false, gfm: true })));
  }
  st.pageEngine?.focus();
}

/** Re-read the target's knobs (config changed, or first paint). */
function apply(st: State): void {
  const cfg = st.target?.cfg ?? noteConfig({ i: '', type: 'note', size: '2x2' });
  st.root.dataset.paper = cfg.paper;
  const ink = cfg.ink;
  for (const k of ['pen', 'eraser', 'clearInk']) st.btn[k]!.hidden = !ink;
  st.color.hidden = !ink;
  st.width.hidden = !ink;
  st.btn.transcribe!.hidden = !ink || cfg.transcribe === 'off';
  if (!ink || shareReadOnly) setTool(st, 'text');
  // A share's viewer reads: no caret, no pen, no toolbar (frost.css [data-readonly]).
  st.root.toggleAttribute('data-readonly', shareReadOnly);
  if (st.editor) st.editor.setEditable(!!st.target && st.loaded && !shareReadOnly);
  else st.doc.contentEditable = st.target && st.loaded && !st.pageEngine && !shareReadOnly ? 'true' : 'false';
  st.format.disabled = !st.target || !st.loaded;
  st.root.toggleAttribute('data-empty', !st.target);
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
  restoreExpandedWard(st.owner, () => openDialog(st));
  fit(st);
}

// ------------------------------------------------------------- document

function cmd(st: State, name: string, value?: string): void {
  if (st.editor) { st.editor.cmd(name, value); markDoc(st); return; }
  if (st.word && (name === 'undo' || name === 'redo')) { st.word.history(name); return; }
  st.doc.focus();
  document.execCommand(name, false, value);
  markDoc(st);
}

const currentBlock = (st: State): string => (st.editor ? st.editor.blockType() : String(document.queryCommandValue('formatBlock')).toLowerCase());

function cycleHeading(st: State): void {
  const cur = currentBlock(st);
  cmd(st, 'formatBlock', cur === 'h1' ? 'h2' : cur === 'h2' ? 'h3' : cur === 'h3' ? 'p' : 'h1');
}

function toggleBlock(st: State, tag: string): void {
  const cur = currentBlock(st);
  cmd(st, 'formatBlock', cur === tag ? 'p' : tag);
}

async function link(st: State): Promise<void> {
  const url = await askText('Link to', 'https://');
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
  if (st.editor) { st.editor.insertParagraphsAt(text, y); markDoc(st); return; }
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
  const n = (st.editor ? st.editor.text() : st.doc.innerText).trim().split(/\s+/).filter(Boolean).length;
  st.count.textContent = n ? `${n} word${n === 1 ? '' : 's'}` : '';
}

// ------------------------------------------------------------------ save

const fmtTime = (iso: string) => new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function setStatus(st: State, text: string): void {
  st.status.textContent = text;
  if (!st.conflict) st.err.textContent = '';
}
function fail(st: State, text: string): void {
  st.err.textContent = text;
  st.err.title = text;
}

/** Another surface saved this document first. Autosave holds; the user picks:
 *  Reload (their unsaved edits go — the other version is the one kept) or
 *  Keep mine (this editor's version overwrites, knowingly). */
function conflict(st: State, other: { updated: string | null } | undefined): void {
  st.conflict = true;
  st.err.textContent = '';
  st.err.title = '';
  st.err.append(`Changed elsewhere${other?.updated ? ` at ${fmtTime(other.updated)}` : ''} — `);
  const reload = el('button', 'np-fix', 'Reload');
  reload.type = 'button';
  reload.title = 'Take the other version; your unsaved edits here are discarded';
  const keep = el('button', 'np-fix', 'Keep mine');
  keep.type = 'button';
  keep.title = 'Save this version over the other one';
  reload.addEventListener('click', () => {
    void load(st, true).then((ok) => {
      if (!ok && st.conflict) {
        conflict(st, other);
        toast('Could not reload the note. Your draft is still here.', undefined, true);
      }
    });
  });
  keep.addEventListener('click', () => {
    st.conflict = false;
    st.err.textContent = '';
    st.docDirty = st.inkDirty = true;
    void flushDoc(st, false, true).then(() => flushInk(st, false, true));
  });
  st.err.append(reload, ' · ', keep);
  st.status.textContent = 'Not saved';
}

const pendingWrites = new Set<Promise<unknown>>();
/** One save, after the previous one finished (so it carries the rev that one
 *  returned). The DOCUMENT is bound when the save is queued — a patch made of
 *  A's content can only ever be sent to A's address, whatever the editor shows
 *  by the time its turn comes; only the rev is read at send time. */
function put(st: State, patch: { html?: string; ink?: string; replacePage?: boolean }, unload = false, force = false): Promise<boolean> {
  const t = st.target;
  const gen = st.gen;
  if (!t) return Promise.resolve(false);
  const run = async (): Promise<boolean> => {
    if (st.conflict && !force && st.gen === gen) return false;
    if (st.gen === gen) setStatus(st, 'Saving…');
    const body = { ...patch, rev: st.rev, etag: st.etag, ...(force ? { force: true } : {}) };
    const saving = postJson(t.api, body, 'PUT', unload && JSON.stringify(body).length < KEEPALIVE_MAX ? { keepalive: true } : {});
    pendingWrites.add(saving);
    st.saving++;
    const res = await saving.finally(() => {
      pendingWrites.delete(saving);
      st.saving--;
    });
    if (st.gen !== gen) return res.ok; // the editor moved on (pagehide flushes only — open() drains first); it landed on its own document
    if (res.status === 409) {
      conflict(st, (res.data as { doc?: { updated: string | null } } | null)?.doc);
      return false;
    }
    if (!res.ok) {
      fail(st, res.status === 0 ? 'Save failed — offline?' : (res.data?.error ?? 'Save failed'));
      return false;
    }
    const d = res.data as { updated: string; rev: number; etag?: string };
    st.rev = d.rev;
    st.etag = d.etag;
    setStatus(st, `Saved ${fmtTime(d.updated)}`);
    return true;
  };
  const p = st.chain.then(run, run);
  st.chain = p.catch(() => {});
  return p;
}

function markDoc(st: State): void {
  if (!st.target || !st.loaded) return;
  if (st.editor) { updateCount(st); st.onInput?.(); linkPicker(st); return; }
  // Text typed into an empty document lands as a bare text node; give it the
  // paragraph every later line gets (the command re-fires input, once).
  if (st.doc.firstChild?.nodeType === Node.TEXT_NODE && document.activeElement === st.doc) document.execCommand('formatBlock', false, 'p');
  if (!st.pageEngine) st.word?.record();
  st.docDirty = true;
  st.docSeq++;
  setStatus(st, 'Editing…');
  updateCount(st);
  st.onInput?.();
  clearTimeout(st.docTimer);
  st.docTimer = window.setTimeout(() => void flushDoc(st), SAVE_MS);
}
/** Save the text if it is dirty. The flag clears only when the save succeeded
 *  AND nothing was typed since it was queued; a failure leaves it set. True =
 *  this flush's save landed. After the editor moved to another document the
 *  flags belong to that one and are left alone. */
function flushDoc(st: State, unload = false, force = false): Promise<boolean> {
  clearTimeout(st.docTimer);
  // The room saves; edits made out of sync wait in the shared document for it — a save of our own
  // over the row would clobber what collaborators wrote meanwhile. Not flushed = keep this note open.
  if (st.editor) return Promise.resolve(st.editor.connected || !st.editor.pendingLocal);
  if (!st.docDirty) return Promise.resolve(true);
  if (st.docFlight && st.docFlight.seq === st.docSeq && !force) return st.docFlight.p;
  const gen = st.gen;
  const seq = st.docSeq;
  const p = put(st, { html: serializeDocument(st), ...(st.replacePage ? { replacePage: true } : {}) }, unload, force).then((ok) => {
    if (ok && st.gen === gen && st.docSeq === seq) { st.docDirty = false; st.replacePage = false; }
    return ok;
  });
  const flight = { seq, p };
  st.docFlight = flight;
  void p.finally(() => { if (st.docFlight === flight) st.docFlight = null; });
  return p;
}
function markInk(st: State): void {
  st.inkDirty = true;
  st.inkSeq++;
  clearTimeout(st.inkTimer);
  st.inkTimer = window.setTimeout(() => void flushInk(st), SAVE_MS);
}
function flushInk(st: State, unload = false, force = false): Promise<boolean> {
  clearTimeout(st.inkTimer);
  if (st.editor || !st.inkDirty) return Promise.resolve(true);
  if (st.inkFlight && st.inkFlight.seq === st.inkSeq && !force) return st.inkFlight.p;
  const gen = st.gen;
  const seq = st.inkSeq;
  // One decimal is a tenth of a CSS pixel — invisible, and half the bytes.
  const ink = JSON.stringify(st.strokes.map((s) => ({ ...s, p: s.p.map((q) => q.map((n) => Math.round(n * 10) / 10)) })));
  const p = put(st, { ink }, unload, force).then((ok) => {
    if (ok && st.gen === gen && st.inkSeq === seq) st.inkDirty = false;
    return ok;
  });
  const flight = { seq, p };
  st.inkFlight = flight;
  void p.finally(() => { if (st.inkFlight === flight) st.inkFlight = null; });
  return p;
}
/** Everything pending on the open document — the two halves, then whatever a
 *  timer had already queued — until nothing is left unsaved. False the moment
 *  a save fails (the flags stay set, so nothing is lost silently). */
async function flushAll(st: State): Promise<boolean> {
  const gen = st.gen;
  if (st.pageEngine?.flush && !(await st.pageEngine.flush())) return false;
  if (st.gen !== gen) return false;
  for (let round = 0; round < 4; round++) {
    const [doc, ink] = await Promise.all([flushDoc(st), flushInk(st)]);
    if (!doc || !ink) return false;
    await st.chain; // saves queued earlier by a timer finish too
    if (st.gen !== gen) return true;
    if (!st.docDirty && !st.inkDirty && !st.pageEngine?.dirty?.()) return true;
  }
  return !st.docDirty && !st.inkDirty && !st.pageEngine?.dirty?.();
}

/** Fetch the open document. False when it could not be loaded (the editor shows why) or the editor moved on meanwhile. */
async function load(st: State, discard = false): Promise<boolean> {
  const t = st.target;
  if (!t) return false;
  const gen = st.gen;
  const requestGen = ++st.loadGen;
  const docSeq = st.docSeq, inkSeq = st.inkSeq;
  setStatus(st, 'Loading…');
  const res = await fetch(t.api, { headers: { accept: 'application/json' } }).catch(() => null);
  const d = res?.ok ? ((await res.json().catch(() => null)) as { html: string; ink: string; updated: string | null; rev?: number; etag?: string } | null) : null;
  if (st.gen !== gen || st.loadGen !== requestGen || st.docSeq !== docSeq || st.inkSeq !== inkSeq || (!discard && (st.docDirty || st.inkDirty || st.pageEngine?.dirty?.()))) return false;
  if (!d) {
    fail(st, res?.status === 404 ? 'This note is gone.' : 'Could not load the note.');
    st.status.textContent = '';
    return false;
  }
  st.rev = d.rev ?? 0;
  // The same content the editor holds (its own save echoed back by the stream
  // or the sync): take the rev, leave the DOM — a rewrite drops the caret.
  if (st.loaded && !discard && st.etag && d.etag === st.etag) {
    setStatus(st, d.updated ? `Saved ${fmtTime(d.updated)}` : '');
    return true;
  }
  st.etag = d.etag;
  st.loaded = true;
  if (discard) st.docDirty = st.inkDirty = st.conflict = false;
  apply(st);
  try { showDocument(st, d.html); } catch (error) {
    st.loaded = false; apply(st); fail(st, `Could not open this page: ${(error as Error).message}`); st.status.textContent = ''; return false;
  }
  st.replacePage = false;
  try {
    const raw = JSON.parse(d.ink) as unknown;
    st.strokes = Array.isArray(raw) ? raw.filter((s): s is Stroke => !!s && typeof s === 'object' && Array.isArray((s as Stroke).p)) : [];
  } catch {
    st.strokes = [];
  }
  st.fresh.clear();
  updateCount(st);
  st.onInput?.();
  setStatus(st, d.updated ? `Saved ${fmtTime(d.updated)}` : '');
  fit(st);
  const saved = readDesktopCheckpoint<{ tool: Tool; color: string; width: string; top: number; left: number }>(`note:${st.owner}`);
  if (saved) {
    if (['text', 'pen', 'eraser'].includes(saved.tool)) setTool(st, saved.tool);
    if (/^#[0-9a-f]{6}$/i.test(saved.color)) st.color.value = saved.color;
    if (Number(saved.width) >= 1 && Number(saved.width) <= 12) st.width.value = saved.width;
    requestAnimationFrame(() => st.page.scrollTo(saved.left, saved.top));
  }
  return true;
}

/** Point the editor at a document (or at nothing). What is pending on the
 *  current one is saved first; if that fails the editor stays where it is and
 *  returns false — the caller keeps its selection. Calls run one after another
 *  (two rapid selections cannot interleave their flushes). */
function open(st: State, target: EditorTarget | null): Promise<boolean> {
  const p = st.opening.then(() => openNow(st, target));
  st.opening = p.catch(() => {});
  return p;
}
async function openNow(st: State, target: EditorTarget | null): Promise<boolean> {
  if (st.target && st.target.id !== target?.id) {
    if (st.conflict || !(await flushAll(st))) {
      if (!st.conflict) fail(st, 'Unsaved changes — save them (or Reload) before leaving this note.');
      return false;
    }
  }
  const same = st.target?.id === target?.id && !!target;
  st.target = target;
  if (same) {
    apply(st);
    return st.loaded || load(st);
  }
  st.gen++;
  st.rev = 0;
  st.etag = undefined;
  st.loaded = false;
  st.pmFailed = false;
  disconnectEditor(st);
  if (picker?.st === st) closePicker();
  st.conflict = false;
  st.docDirty = st.inkDirty = false;
  st.replacePage = false;
  st.docSeq = st.inkSeq = 0;
  st.docFlight = st.inkFlight = null;
  clearTimeout(st.docTimer);
  clearTimeout(st.inkTimer);
  clearTimeout(st.liveTimer);
  showDocument(st, '');
  st.strokes = [];
  st.cur = null;
  st.fresh.clear();
  st.sel = null;
  st.ai?.remove();
  st.ai = null;
  st.err.textContent = '';
  st.count.textContent = '';
  apply(st);
  redraw(st);
  if (!target) {
    st.status.textContent = '';
    return true;
  }
  return load(st); // false = shown, but not loaded: the caller must not treat it as selected
}

// ------------------------------------------------------------ note links

// Typing [[ opens a picker over the caret listing the user's notes (every
// notebook, /api/notes); picking one replaces "[[query" with a note link —
// <a data-note="id">Title</a>, what the sanitizer keeps and what backlinks
// are counted from. One picker at a time, page-wide; hosted like the context
// menu (inside the open modal dialog, coordinates corrected by a probe).
interface Picker {
  st: State;
  el: HTMLElement;
  layer: HTMLElement;
  node: Text;
  /** Where "[[" starts in `node`, and the caret offset the query runs to. */
  start: number;
  items: { id: string; title: string; notebook: string | null }[];
  at: number;
  q: string;
  timer: number;
  gen: number;
}
let picker: Picker | null = null;
document.addEventListener('close', () => closePicker(), true);
function closePicker(): void {
  clearTimeout(picker?.timer);
  picker?.layer.remove();
  picker = null;
}
function caretText(): { node: Text; offset: number } | null {
  const sel = document.getSelection();
  if (!sel?.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return r.startContainer.nodeType === Node.TEXT_NODE ? { node: r.startContainer as Text, offset: r.startOffset } : null;
}
function linkPicker(st: State): void {
  const c = st.target ? caretText() : null;
  const m = c ? /\[\[([^\[\]]{0,60})$/.exec(c.node.data.slice(0, c.offset)) : null;
  if (!c || !m || !st.doc.contains(c.node)) {
    if (picker?.st === st) closePicker();
    return;
  }
  const q = m[1]!;
  if (!picker || picker.st !== st || picker.node !== c.node) {
    closePicker();
    const box = el('div', 'np-pick');
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'Link a note');
    const layer = popupLayer((st.doc.closest('dialog[open]:modal') ?? document.body) as HTMLElement); layer.append(box);
    picker = { st, el: box, layer, node: c.node, start: c.offset - m[0].length, items: [], at: 0, q, timer: 0, gen: 0 };
  }
  const p = picker;
  p.q = q;
  p.gen++;
  p.start = c.offset - m[0].length;
  clearTimeout(p.timer);
  p.timer = window.setTimeout(async () => {
    const gen = ++p.gen;
    const res = await fetch(`/api/notes?q=${encodeURIComponent(q)}&limit=8`, { headers: { accept: 'application/json' } }).catch(() => null);
    const d = res?.ok ? ((await res.json().catch(() => null)) as { notes: Picker['items'] } | null) : null;
    if (picker !== p || p.gen !== gen) return;
    p.items = (d?.notes ?? []).filter((n) => n.id !== st.target?.id);
    p.at = 0;
    renderPicker(p);
  }, 120);
  renderPicker(p);
}
function renderPicker(p: Picker): void {
  const { el: box } = p;
  box.textContent = '';
  if (!p.items.length) box.append(el('div', 'np-pick-hint', p.q ? `No note matches “${p.q}”.` : 'Type a note title…'));
  p.items.forEach((n, i) => {
    const b = el('button', 'np-pick-b');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === p.at));
    b.append(el('span', 'truncate', n.title));
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the document
    b.addEventListener('click', () => pickNote(p, n));
    box.append(b);
  });
  const sel = document.getSelection();
  const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : p.st.doc.getBoundingClientRect();
  const frame = popupFrame(p.layer), viewport = popupViewport();
  box.style.minWidth = '0';
  box.style.maxWidth = `${Math.max(1, viewport.width - 16) / frame.scale}px`;
  box.style.maxHeight = `${Math.max(1, Math.min(224, viewport.height - 16)) / frame.scale}px`;
  const width = box.offsetWidth * frame.scale, height = box.offsetHeight * frame.scale;
  const top = r.bottom + height + 12 > viewport.bottom ? r.top - height - 4 : r.bottom + 4;
  box.style.left = `${(Math.max(viewport.left + 8, Math.min(r.left, viewport.right - width - 8)) - frame.x) / frame.scale}px`;
  box.style.top = `${(Math.max(viewport.top + 8, Math.min(top, viewport.bottom - height - 8)) - frame.y) / frame.scale}px`;

}
function pickNote(p: Picker, n: { id: string; title: string }): void {
  const { st, node, start } = p;
  closePicker();
  if (!node.isConnected || !st.target) return;
  const end = Math.min(node.data.length, start + 2 + p.q.length);
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
  if (st.editor) { st.editor.replaceDomRange(node, start, end, n.id, n.title); markDoc(st); return; }
  st.doc.focus();
  document.execCommand('insertHTML', false, `<a data-note="${n.id}">${esc(n.title)}</a>&nbsp;`);
  markDoc(st);
}
/** Arrow keys / Enter / Escape while the picker is up. True = handled. */
function pickerKeys(st: State, e: KeyboardEvent): boolean {
  const p = picker;
  if (!p || p.st !== st) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    closePicker();
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!p.items.length) return false;
    e.preventDefault();
    p.at = (p.at + (e.key === 'ArrowDown' ? 1 : p.items.length - 1)) % p.items.length;
    renderPicker(p);
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && p.items[p.at]) {
    e.preventDefault();
    pickNote(p, p.items[p.at]!);
    return true;
  }
  return false;
}
document.addEventListener('selectionchange', () => {
  // The caret left the [[ run (a click elsewhere, arrow keys): the picker goes.
  if (!picker) return;
  const c = caretText();
  if (!c || c.node !== picker.node || c.offset < picker.start + 2) closePicker();
});
document.addEventListener('click', (e) => {
  if (picker && !picker.el.contains(e.target as Node) && !picker.st.doc.contains(e.target as Node)) closePicker();
});

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
  if (st.tool === 'text' || palm(st, e) || !st.target) return;
  if (e.pointerType === 'pen') st.penSeen = true;
  e.preventDefault();
  st.canvas.setPointerCapture(e.pointerId);
  const p = pt(st, e);
  if (st.tool === 'eraser') {
    erase(st, p);
    return;
  }
  st.cur = { id: newId('s'), c: st.color.value, w: Number(st.width.value) || 2.5, p: [p] };
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
  if (st.editor) st.editor.ink.push([{ ...s, p: s.p.map((q) => q.map((n) => Math.round(n * 10) / 10) as Pt) }]);
  else markInk(st);
  fit(st);
  if (st.target?.cfg.transcribe === 'live') scheduleLive(st);
}
function erase(st: State, at: Pt): void {
  const gone = st.strokes.filter((s) => s.p.some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) <= ERASE_R + s.w));
  if (!gone.length) return;
  if (st.editor) { st.editor.removeStrokes(new Set(gone.map((s) => s.id ?? ''))); return; } // the shared list observer redraws
  st.strokes = st.strokes.filter((s) => !gone.includes(s));
  for (const s of st.fresh) if (!st.strokes.includes(s)) st.fresh.delete(s);
  redraw(st);
  markInk(st);
}
function clearInk(st: State): void {
  if (!st.strokes.length || !window.confirm('Clear all the ink on this note?')) return;
  st.fresh.clear();
  if (st.editor) { st.editor.ink.delete(0, st.editor.ink.length); return; }
  st.strokes = [];
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
  const t = st.target;
  if (!t) return;
  // By id where there is one: the shared list's observer replaces the stroke objects on every remote change.
  const same = (a: Stroke, b: Stroke) => a === b || (!!a.id && a.id === b.id);
  const set = strokes.filter((s) => st.strokes.some((x) => same(x, s)));
  if (!set.length || st.busy) {
    if (set.length && t.cfg.transcribe === 'live') scheduleLive(st); // busy: try again after
    return;
  }
  const b = bbox(set);
  const gen = st.gen;
  setBusy(st, true);
  setStatus(st, 'Reading the handwriting…');
  const res = await postJson(t.api, { action: 'transcribe', image: inkImage(set, b) });
  const d = res.data as { text?: string; error?: string } | null;
  setBusy(st, false);
  if (st.gen !== gen) return; // a different note is open now: its text is not this one's
  if (!res.ok) {
    fail(st, d?.error ?? 'Could not read the handwriting.');
    return;
  }
  for (const f of [...st.fresh]) if (set.some((s) => same(s, f))) st.fresh.delete(f);
  const text = String(d?.text ?? '').trim();
  if (!text) {
    setStatus(st, 'No writing found in the ink.');
    return;
  }
  insertAt(st, text, b.y);
  if (!t.cfg.keepInk) {
    if (st.editor) st.editor.removeStrokes(new Set(set.map((s) => s.id ?? '')));
    else { st.strokes = st.strokes.filter((s) => !set.includes(s)); redraw(st); markInk(st); }
  }
  if (st.fresh.size && t.cfg.transcribe === 'live') scheduleLive(st);
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
  if (!st.target) return;
  const bar = el('div', 'np-ai');
  const mode = el('select', 'input');
  mode.setAttribute('aria-label', 'What Rime should do');
  for (const [v, l] of MODES) {
    const o = el('option', undefined, l);
    o.value = v;
    mode.append(o);
  }
  const prompt = el('input', 'input np-ai-prompt');
  prompt.type = 'text';
  prompt.maxLength = 1000;
  prompt.placeholder = 'Or tell Rime what to do…';
  prompt.setAttribute('aria-label', 'Custom instruction');
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
  const t = st.target;
  if (st.busy || !t) return;
  const range = !st.editor && st.sel && !st.sel.collapsed && st.doc.contains(st.sel.commonAncestorContainer) ? st.sel.cloneRange() : null;
  const selected = st.editor ? st.editor.hasSelection() : !!range;
  const text = st.editor ? (selected ? st.editor.selectionText() : st.editor.text()) : range ? range.toString() : st.doc.innerText;
  if (!text.trim()) {
    fail(st, 'Nothing to work on yet.');
    return;
  }
  const gen = st.gen;
  // Where the passage IS when the answer lands, not where the caret went meanwhile (a collaborator's edits included).
  const at = st.editor?.anchor();
  setBusy(st, true);
  setStatus(st, 'Rime is thinking…');
  const res = await postJson(t.api, { action: 'ai', mode, prompt, text });
  const d = res.data as { text?: string; error?: string } | null;
  setBusy(st, false);
  if (st.gen !== gen) return; // a different note is open now
  if (!res.ok) {
    fail(st, d?.error ?? 'Rime could not do that.');
    return;
  }
  const out = String(d?.text ?? '').trim();
  if (!out) {
    setStatus(st, 'Rime had nothing to add.');
    return;
  }
  if (st.editor) {
    const r = at?.() ?? null;
    if (selected && (REPLACES.has(mode) || mode === 'custom')) { if (r) st.editor.insertText(out, r); else st.editor.appendParagraphs(out); }
    else if (selected) st.editor.appendParagraphs(out, r?.to);
    else if (REPLACES.has(mode)) st.editor.setHtml(textToHtml(out));
    else st.editor.appendParagraphs(out);
  } else if (range && (REPLACES.has(mode) || mode === 'custom')) {
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

function exportContent(st: State): string {
  // The document, never the live view (collaborators' cursors and highlights are decorations, not content).
  return st.pageType === 'markdown' ? sanitizeHtml(marked.parse((st.pageEngine!.serialize() as { source: string }).source, { async: false, gfm: true })) : serializeDocument(st);
}
function exportHtml(st: State): string {
  const title = st.target?.title ?? 'Note';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{max-width:60rem;margin:2rem auto;padding:0 1rem;font:16px/1.7 Calibri,Carlito,'Segoe UI',Arial,sans-serif}blockquote{border-left:3px solid #999;margin:0;padding-left:.75em;color:#555}pre{background:#f3f3f3;padding:.5em .65em;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #999;padding:6px}img{max-width:100%}[data-word-page]{break-after:page}[data-word-page]:last-child{break-after:auto}</style></head><body>${exportContent(st)}</body></html>`;
}
function exportMenu(st: State): void {
  if (!st.target || !st.loaded) { st.exportStatus.textContent = 'Load a document before exporting.'; return; }
  const rect = st.btn.download!.getBoundingClientRect();
  openMenu(rect.left, rect.bottom, menu => {
    const choices = st.pageType && st.pageType !== 'markdown' ? (st.pageType === 'notion' ? [['json', 'Notion link (.json)']] : [['json', 'Page JSON'], ['txt', 'Plain text (.txt)']]) : [['docx', 'Word (.docx)'], ['pdf', 'PDF / Print…'], ['md', 'Markdown (.md)'], ['html', 'Web page (.html)'], ['txt', 'Plain text (.txt)']];
    for (const [format, label] of choices) menu.append(menuItem('download', label!, () => void exportDocument(st, format!)));
  });
}
async function exportDocument(st: State, format: string): Promise<void> {
  if (!st.target || !st.loaded || st.btn.download!.disabled) return;
  const gen = st.gen, title = st.target.title || 'Document', html = exportContent(st);
  const name = `${title.replace(/[\/\\]/g, '-').slice(0, 150)}.${format}`;
  if (format === 'pdf') { print(st); return; }
  st.btn.download!.disabled = true; st.btn.download!.setAttribute('aria-busy', 'true');
  st.exportStatus.textContent = `Preparing ${format.toUpperCase()}…`;
  try {
    let blob: Blob;
    if (format === 'docx') blob = await exportDocx(html, title);
    else if (format === 'html') blob = new Blob([exportHtml(st)], { type: 'text/html;charset=utf-8' });
    else if (format === 'md') blob = new Blob([st.pageType === 'markdown' ? (st.pageEngine!.serialize() as { source: string }).source : documentMarkdown(html)], { type: 'text/markdown;charset=utf-8' });
    else if (format === 'json') blob = new Blob([JSON.stringify(st.pageType === 'notion' ? { ...(st.pageEngine?.serialize() as object), kind: 'notion' } : st.pageEngine?.serialize(), null, 2)], { type: 'application/json' });
    else blob = new Blob([st.pageEngine?.text() ?? plainText(html)], { type: 'text/plain;charset=utf-8' });
    if (st.gen === gen) st.exportStatus.textContent = 'Choose where to save the file…';
    const result = await saveDocumentBlob(blob, name);
    if (st.gen === gen) st.exportStatus.textContent = result;
  } catch (error) { if (st.gen === gen) st.exportStatus.textContent = `Export failed: ${error instanceof Error ? error.message : String(error)}`; }
  finally { st.btn.download!.disabled = false; st.btn.download!.removeAttribute('aria-busy'); }
}
function print(st: State): void {
  if (!st.target || !st.loaded) return;
  printDocument(exportHtml(st), st.target.title || 'Document');
  st.exportStatus.textContent = 'Print preview opened. Choose Print / Save as PDF.';
}

// -------------------------------------------------------- shared dialog

let dlg: HTMLDialogElement | null = null;
let shown: State | null = null;

/** Resize the existing editor in place, keeping selection, drafts and history. */
export function setDocumentFullscreen(d: HTMLDialogElement, on: boolean): void {
  d.toggleAttribute('data-document-fullscreen', on);
  const button = d.querySelector<HTMLElement>('[data-document-fullscreen-toggle]');
  if (button) {
    relabel(button, on ? 'fullscreen-exit' : 'fullscreen', on ? 'Exit full screen' : 'Full screen');
    button.setAttribute('aria-pressed', String(on));
  }
  requestAnimationFrame(refitNoteEditors);
}

function dialog(): HTMLDialogElement | null {
  if (dlg) return dlg;
  const d = document.getElementById('note-dialog') as HTMLDialogElement | null;
  if (!d) return null;
  dlg = d;
  const tryClose = async () => {
    if (!shown || (await flushAll(shown)) && !shown.conflict) d.close();
    else toast('The note has unsaved changes — fix the save before closing.', undefined, true);
  };
  d.querySelector('[data-nd-close]')?.addEventListener('click', () => void tryClose());
  const openFile = () => shown?.root.querySelector<HTMLButtonElement>('[data-note-open-file]')?.click();
  d.querySelector('[data-nd-open]')?.addEventListener('click', openFile);
  d.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); } });
  d.querySelector('[data-document-fullscreen-toggle]')?.addEventListener('click', () => setDocumentFullscreen(d, !d.hasAttribute('data-document-fullscreen')));
  d.addEventListener('cancel', (e) => {
    if (e.target !== d) return;
    e.preventDefault();
    if (d.hasAttribute('data-document-fullscreen')) setDocumentFullscreen(d, false);
    else void tryClose();
  });
  d.addEventListener('close', () => {
    setDocumentFullscreen(d, false);
    const st = shown;
    shown = null;
    expandedDesktopWard();
    if (!st) return;
    delete st.root.dataset.full;
    st.btn.expand!.hidden = false;
    const b = body(st.owner);
    if (b && states.get(st.owner) === st) mount(st, b);
    if (st.owner === 'note-link') {
      st.ro.disconnect();
      clearTimeout(st.liveTimer);
      states.delete(st.owner);
      st.root.remove();
    }
  });
  return d;
}

function openDialog(st: State): void {
  const d = dialog();
  if (!d) return;
  if (shown) d.close();
  shown = st;
  expandedDesktopWard(st.owner);
  d.querySelector('[data-nd-title]')!.textContent = st.target?.title ?? 'Notepad';
  st.root.dataset.full = '';
  st.btn.expand!.hidden = true; // the dialog's ✕ is the way back
  d.querySelector('[data-nd-host]')!.append(st.root);
  const b = body(st.owner);
  if (b) {
    b.textContent = '';
    b.append(el('p', 'wd-note text-xs text-ink-faint', 'Open in the editor…'));
  }
  d.showModal();
  fit(st);
}

/** A link can name an unfiled note or a notebook with no dashboard tile. */
export async function openLinkedNote(id: string): Promise<void> {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) return;
  const d = dialog();
  if (!d) return;
  if (shown) {
    if (!(await flushAll(shown)) || shown.conflict) return;
    await new Promise<void>((resolve) => { d.addEventListener('close', () => resolve(), { once: true }); d.close(); });
  }
  const st = build('note-link', true);
  states.set(st.owner, st);
  if (!(await open(st, { id, api: `/api/note/${id}?ward=`, title: 'Note', cfg: noteConfig({ i: '', type: 'note', size: '2x2' }) }))) {
    st.ro.disconnect();
    states.delete(st.owner);
    toast('That note could not be opened.', undefined, true);
    return;
  }
  openDialog(st);
}

// ------------------------------------------------------ the editor API

/** An editor for whoever hosts one (the notebook): `root` goes wherever it
 *  should show, `open` points it at a document. It is registered under `owner`
 *  so the page-wide flush handlers (a mention, a relaunch, pagehide) save it. */
export interface NoteEditor {
  root: HTMLElement;
  /** The editable element — read-only access for an outline or a word count. */
  doc: HTMLElement;
  /** The open document's id, or null. */
  id(): string | null;
  /** Show a document (null = nothing). False = unsaved edits could not be saved; the editor stays put. */
  open(target: EditorTarget | null): Promise<boolean>;
  /** Save what is pending; true when nothing is left unsaved. */
  flush(): Promise<boolean>;
  dirty(): boolean;
  /** Called after every edit and every load. */
  onInput(fn: (() => void) | null): void;
  /** The editor's expanded layout (full toolbar, wide page). */
  full(on: boolean): void;
  destroy(): void;
}

export function createNoteEditor(owner: string): NoteEditor {
  const st = build(owner, false);
  states.set(owner, st);
  apply(st);
  return {
    root: st.root,
    doc: st.doc,
    id: () => st.target?.id ?? null,
    open: (t) => open(st, t),
    flush: () => flushAll(st),
    dirty: () => (st.editor ? !st.editor.connected && st.editor.pendingLocal : st.docDirty || st.inkDirty || st.conflict) || !!st.pageEngine?.dirty?.(),
    onInput: (fn) => { st.onInput = fn; },
    full: (on) => { st.root.toggleAttribute('data-full', on); fit(st); },
    destroy: () => {
      if (picker?.st === st) closePicker();
      st.ribbon?.destroy(); st.editor?.destroy(); st.editor = null;
      st.pageEngine?.destroy(); st.word?.destroy(); st.proof?.destroy();
      st.ro.disconnect();
      clearTimeout(st.liveTimer);
      if (states.get(owner) === st) states.delete(owner);
    },
  };
}

/** Redraw after the host resized the editor (a pane switch, a dialog open). */
export function refitNoteEditors(): void {
  for (const st of states.values()) fit(st);
}

// -------------------------------------------------------------- registry

document.execCommand('defaultParagraphSeparator', false, 'p');

// The ✨ bar takes focus, so the selection it should work on is the last one
// made inside a document — tracked here, once, for every editor on the page.
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  for (const st of states.values()) if (st.doc.contains(range.commonAncestorContainer)) st.sel = range.cloneRange();
});
// The document was saved elsewhere — the agent's write_note, or another
// surface's editor (logic.ts relays the stream event): every editor showing
// it pulls the new version, unless the user is mid-edit there (their keystrokes
// win, and their next save meets the rev check instead), or it is the editor
// whose own save this is (in flight, or already at that rev).
window.addEventListener('fd:note', (e) => {
  const d = (e as CustomEvent<{ ward?: string; note?: string; rev?: number; meta?: boolean; gone?: boolean }>).detail ?? {};
  if (d.meta) return; // a title or tag changed — the notebook list cares, the document did not move
  for (const st of states.values()) {
    if (!st.target) continue;
    if (st.target.id !== d.note && st.owner !== d.ward) continue;
    if (d.gone) {
      clearTimeout(st.docTimer);
      clearTimeout(st.inkTimer);
      st.conflict = st.docDirty || st.inkDirty || st.saving > 0 || !!st.pageEngine?.dirty?.();
      st.loaded = false;
      apply(st);
      fail(st, 'This note was deleted. Copy any unsaved text before closing.');
      continue;
    }
    if (st.editor) continue; // the room delivered it already
    if (st.saving || st.docDirty || st.inkDirty || st.conflict || st.pageEngine?.dirty?.()) continue;
    if (d.rev !== undefined && st.rev >= d.rev) continue;
    void load(st);
  }
});
window.addEventListener('fd:ward-context', event => {
  const { wards, waitUntil } = (event as CustomEvent<{ wards: string[]; waitUntil(p: Promise<unknown>): void }>).detail;
  waitUntil((async () => {
    await Promise.all(pendingWrites);
    for (const id of wards) {
      const st = states.get(id);
      if (!st) continue;
      if (st.busy) throw Error('Wait for the note operation to finish before mentioning it.');
      if (st.conflict || !(await flushAll(st))) throw Error('The note could not be saved. Your edits are still a draft.');
    }
  })());
});
window.addEventListener('fd:before-workspace-navigation', event => {
  (event as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil((async () => {
    await Promise.all(pendingWrites);
    for (const st of states.values()) {
      if (st.busy) throw Error('Wait for the note operation to finish before relaunching.');
      if (!(await flushAll(st))) throw Error('The note could not be saved. Try again before relaunching.');
      saveDesktopState(`note:${st.owner}`, { tool: st.tool, color: st.color.value, width: st.width.value, top: st.page.scrollTop, left: st.page.scrollLeft });
    }
  })());
});
window.addEventListener('beforeunload', event => {
  if ([...states.values()].some(st => st.pageEngine?.dirty?.())) event.preventDefault();
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
      st = build(w.i, true);
      states.set(w.i, st);
      mount(st, b);
      void open(st, wardTarget(w));
      return;
    }
    void open(st, wardTarget(w)); // the same document: knobs re-read; another one (config.note changed): flushed, then loaded
    if (shown === st) return; // it is in the dialog; the body already says so
    mount(st, b);
  },
  stop(id) {
    const st = states.get(id);
    if (!st) return;
    void flushDoc(st);
    void flushInk(st);
    st.ribbon?.destroy(); st.editor?.destroy(); st.editor = null;
    st.pageEngine?.destroy(); st.word?.destroy(); st.proof?.destroy();
    st.ro.disconnect();
    clearTimeout(st.liveTimer);
    states.delete(id);
    if (shown === st) dlg?.close();
  },
};
