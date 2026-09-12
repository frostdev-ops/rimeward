// The Notebook ward (type `notebook`): a set of note documents organized into
// sections, tags, pins and a manual order, with saved views (list, table or
// cards), typed properties, templates and full-text search — the notepad's
// editor, one document at a time, over a library. The card is the compact
// view: a search box, New note, and the pinned and most recent notes. Expand
// (or any row) opens #notebook-dialog: navigation (sections, tags, views,
// properties, templates, Ask, archive, trash, index), the note list and ONE
// shared editor (note.ts createNoteEditor) pointed at the selected note. The
// editor saves before it switches and refuses to move while a save fails, so
// selecting another note can never drop an edit. Under 640px the three panes
// show one at a time (data-pane) with Back buttons.
//
// Data: GET /api/notebook/<ward> (metadata + one page of note METADATA —
// bodies load locally through /api/note/<id>?ward=<ward>; the host selects
// model settings), POST {op} for every change. Sync replicates the documents.

import { expandedDesktopWard, restoreExpandedWard } from './desktop-state.ts';
import { notebookConfig, rowsOf, wardTitle, type WardInstance } from '../../lib/wards.ts';
import type { NoteMeta } from '../../lib/note.ts';
import type { Layout, Notebook, PropDef, PropType, SavedView, Section, Sort, Status } from '../../lib/notebook.ts';
import { RENDERERS, body, note as noteMsg } from './wards.ts';
import { el, getJson, holdToFire, postJson, reducedMotion, toast } from './dom.ts';
import { icon, relabel } from './icon.ts';
import type { NotebookPageType } from '../../lib/notebook-pages.ts';
import { importNotebookFile, pickNotebookFiles, type ImportedNotebookFile } from './notebook-import.ts';
import { askText, confirmAction } from './workspace-dialogs.ts';
import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import { createNoteEditor, openLinkedNote, refitNoteEditors, setDocumentFullscreen, type NoteEditor } from './note.ts';
// Inside a share (lib/shares.ts SHARE_NOTEBOOK_OPS): a viewer changes nothing; an editor writes
// pages, never the notebook itself — the controls the server would refuse are not offered.
import { shareReadOnly, shareView } from './share-view.ts';

interface Meta {
  notebook: Notebook;
  tags: { tag: string; n: number }[];
  linkable: { id: string; title: string }[];
  notes: NoteMeta[];
  total: number;
  next?: number;
}
interface Query {
  section?: string | 'none';
  tag?: string;
  status: Status;
  pinned?: boolean;
  template?: boolean;
  props?: Record<string, string>;
  q?: string;
  sort: Sort;
  dir: 'asc' | 'desc';
  group: 'none' | 'section' | 'tag';
  layout: Layout;
}
type Nav =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'section'; id: string | 'none' }
  | { kind: 'tag'; tag: string }
  | { kind: 'view'; id: string }
  | { kind: 'status'; status: Status }
  | { kind: 'templates' }
  | { kind: 'ask' }
  | { kind: 'index' };

const PAGE = 50;
const PROP_TYPE_LABELS: Record<PropType, string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Choice', checkbox: 'Checkbox' };
const when = (iso: string) => {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const ms = Date.now() - d.getTime();
  if (ms < 86_400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], ms < 300 * 86_400_000 ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
const titleOf = (n: NoteMeta) => n.title || n.excerpt.slice(0, 60) || 'Untitled';
const btn = (id: string, label: string, fn: () => void, cls = 'btn min-h-0 px-2 py-1 text-xs'): HTMLButtonElement => {
  const b = el('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(id));
  b.addEventListener('click', fn);
  return b;
};
/** A property value as a list shows it. */
const propText = (p: PropDef, v: unknown): string => (v === undefined || v === null || v === '' ? '' : p.type === 'checkbox' ? (v === true ? 'Yes' : '') : String(v));
const propIcon = (t: PropType) => (t === 'checkbox' ? 'check' : t === 'date' ? 'calendar' : t === 'select' ? 'list' : 'tag');

/** A snippet's U+0001…U+0002 marks become <mark>; everything else is text. */
function snippet(s: string): HTMLElement {
  const out = el('span', 'nb-row-x');
  const parts = s.split(/([\u0001\u0002])/);
  let on = false;
  for (const p of parts) {
    if (p === '\u0001') on = true;
    else if (p === '\u0002') on = false;
    else if (p) out.append(on ? el('mark', undefined, p) : p);
  }
  return out;
}

// --------------------------------------------------------------- compact

const cards = new Map<string, { w: WardInstance; nbId: string }>();

async function renderCompact(w: WardInstance): Promise<void> {
  const b = body(w.i);
  if (!b) return;
  const limit = Math.min(30, Math.max(3, rowsOf(w) * 4 - 2));
  const { status, data } = await getJson(`/api/notebook/${w.i}?sort=updated&limit=${limit}`);
  if (!body(w.i)) return;
  if (status !== 200) {
    noteMsg(w.i, status === 404 ? 'This notebook ward is not on the layout yet — reload.' : 'Notebook unavailable.');
    return;
  }
  const m = data as Meta;
  cards.set(w.i, { w, nbId: m.notebook.id });
  b.textContent = '';
  b.classList.remove('overflow-y-auto');
  const root = el('div', 'nb-c');
  const bar = el('div', 'nb-c-bar');
  const search = el('input', 'input nb-c-q');
  search.type = 'search';
  search.placeholder = `Search ${m.total ? `${m.total} note${m.total === 1 ? '' : 's'}` : 'notes'}…`;
  search.setAttribute('aria-label', 'Search this notebook');
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && search.value.trim()) void openNotebook(w, { q: search.value.trim() });
  });
  const add = btn('plus', 'New page', () => {
    const r = add.getBoundingClientRect();
    openMenu(r.left, r.bottom, menu => {
      menu.append(menuItem('folder', 'Open file…', () => pickNotebookFiles(async files => {
        await openNotebook(w); if (cur?.w.i !== w.i || !files[0]) return;
        await importNotebookFiles(cur, files);
      }, false)));
      for (const [kind, label, glyph] of [['document', 'Document', 'note'], ['markdown', 'Markdown', 'code'], ['spreadsheet', 'Spreadsheet', 'database'], ['slides', 'Slides', 'page'], ['drawing', 'Drawing', 'pen'], ['notion', 'Linked Notion database', 'database']] as const) menu.append(menuItem(glyph, label, () => void openNotebook(w, { create: kind === 'document' ? true : kind })));
    });
  });
  add.className = 'btn-primary nb-add';
  add.append(el('span', undefined, 'New page'));
  bar.append(search, ...(shareReadOnly ? [] : [add]), btn('resize', 'Open the notebook', () => void openNotebook(w)));
  root.append(bar);
  const rows = el('div', 'nb-c-rows');
  rows.setAttribute('role', 'list');
  if (!m.notes.length) {
    const empty = el('p', 'wd-note text-xs text-ink-faint', 'No notes yet — start one.');
    rows.append(empty);
  }
  for (const n of m.notes) {
    const r = el('button', 'nb-c-row');
    r.type = 'button';
    r.setAttribute('role', 'listitem');
    const t = el('span', 'nb-c-row-t');
    if (n.pinned) t.append(icon('pin', 'nb-pin', 'Pinned'));
    t.append(el('span', 'truncate', titleOf(n)));
    t.append(el('span', 'ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint', when(n.updated)));
    r.append(t);
    const sub = [m.notebook.sections.find((s) => s.id === n.section)?.title, ...n.tags.map((x) => `#${x}`)].filter(Boolean).join(' · ');
    if (sub || (n.title && n.excerpt)) r.append(el('span', 'nb-row-x', sub || n.excerpt));
    r.addEventListener('click', () => void openNotebook(w, { note: n.id }));
    rows.append(r);
  }
  root.append(rows);
  b.append(root);
  restoreExpandedWard(w.i, () => void openNotebook(w));
}

RENDERERS.notebook = {
  render: renderCompact,
  stop(id) {
    cards.delete(id);
    if (dlg && cur?.w.i === id) dlg.close();
  },
};

// ---------------------------------------------------------------- dialog

interface Dlg {
  w: WardInstance;
  importing?: boolean;
  drawerClosed: boolean;
  nbId: string;
  meta: Meta;
  nav: Nav;
  query: Query;
  notes: NoteMeta[];
  total: number;
  next?: number;
  selected: NoteMeta | null;
  editor: NoteEditor;
  listGen: number;
  /** Selections run one after another; the editor confirms which document it shows before the pane follows. */
  selecting: Promise<unknown>;
  /** Title/section/tag saves in flight — awaited before a switch or close; false = one failed (the draft is put back). */
  metaSaves: Promise<boolean>;
  failedFields: Set<string>;
  /** Bumped per refreshMeta; a late answer for an older one is dropped. */
  metaGen: number;
  /** Bumped per selection; a late backlinks answer for an older note is dropped. */
  linksGen: number;
  els: {
    root: HTMLElement; nav: HTMLElement; list: HTMLElement; edit: HTMLElement; title: HTMLElement;
    rows: HTMLElement; listHead: HTMLElement; editHead: HTMLElement; outline: HTMLElement; editHost: HTMLElement; empty: HTMLElement; hint: HTMLElement;
  };
}

let dlg: HTMLDialogElement | null = null;
let cur: Dlg | null = null;
let refreshTimer = 0;

const narrowNotebook = matchMedia('(max-width: 1050px)');
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem('fd-notebook-sidebar-collapsed') === '1'; } catch { /* private storage */ }
function syncNotebookChrome(c: Dlg): void {
  if (!dlg) return;
  c.els.root.toggleAttribute('data-nav-collapsed', c.drawerClosed);
  const fullscreen = dlg.querySelector<HTMLButtonElement>('[data-document-fullscreen-toggle]')!;
  fullscreen.disabled = !c.selected;
  const openFile = dlg.querySelector<HTMLButtonElement>('[data-nb-open]'); if (openFile) openFile.disabled = !!c.importing;
  if (!c.selected && dlg.hasAttribute('data-document-fullscreen')) setDocumentFullscreen(dlg, false);
  const expanded = !dlg.hasAttribute('data-document-fullscreen') && !c.drawerClosed;
  const button = dlg.querySelector<HTMLElement>('[data-nb-sidebar]')!;
  relabel(button, expanded ? 'left' : 'list', expanded ? 'Hide navigation and pages' : 'Show navigation and pages');
  button.setAttribute('aria-expanded', String(expanded));
}
function setPane(c: Dlg, pane: 'nav' | 'list' | 'edit'): void {
  if (pane !== 'edit' && dlg?.hasAttribute('data-document-fullscreen')) setDocumentFullscreen(dlg, false);
  c.els.root.dataset.pane = pane;
  if (pane !== 'edit') c.drawerClosed = false;
  else if (narrowNotebook.matches) c.drawerClosed = true;
  syncNotebookChrome(c);
}
narrowNotebook.addEventListener('change', () => { if (cur) { if (narrowNotebook.matches && cur.els.root.dataset.pane === 'edit') cur.drawerClosed = true; syncNotebookChrome(cur); } });

function dialog(): HTMLDialogElement | null {
  if (dlg) return dlg;
  const d = document.getElementById('notebook-dialog') as HTMLDialogElement | null;
  if (!d) return null;
  dlg = d;
  bindContextMenu(d, event => {
    const c = cur, target = event.target instanceof Element ? event.target : null;
    if (!c || !target || target.closest('input,textarea,select,[contenteditable],.ctx-menu,[data-nb-host]')) return;
    if (!target.closest('[data-nb-nav],[data-nb-list],[data-nb-title],[data-nb-empty],[data-nb-edit-head]')) return;
    event.preventDefault(); event.stopPropagation();
    openMenu(event.clientX, event.clientY, menu => {
      if (target.closest('[data-nb-edit-head]') && c.selected) noteMenu(c, c.selected, menu);
      else notebookMenu(c, menu);
    });
  });
  const tryClose = async () => {
    if (!cur) return d.close();
    const c = cur;
    (document.activeElement as HTMLElement | null)?.blur?.(); // a title/tags draft saves on blur
    await c.selecting;
    if (cur !== c) return;
    if ((await c.metaSaves) && (await c.editor.flush()) && !c.editor.dirty()) d.close();
    else toast('The open note has unsaved changes — fix the save before closing.', undefined, true);
  };
  d.querySelector('[data-nb-close]')?.addEventListener('click', () => void tryClose());
  d.querySelector('[data-nb-open]')?.addEventListener('click', () => { if (cur) openNotebookFile(cur); });
  if (shareView) d.querySelector<HTMLElement>('[data-nb-rename]')?.setAttribute('hidden', '');
  if (shareReadOnly) d.querySelector<HTMLElement>('[data-nb-open]')?.setAttribute('hidden', '');
  d.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); if (cur) openNotebookFile(cur); } });
  d.querySelector('[data-nb-sidebar]')?.addEventListener('click', () => {
    if (!cur) return;
    const wasFullscreen = d.hasAttribute('data-document-fullscreen');
    setDocumentFullscreen(d, false);
    const open = wasFullscreen || cur.drawerClosed;
    cur.drawerClosed = !open;
    sidebarCollapsed = cur.drawerClosed;
    try { localStorage.setItem('fd-notebook-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); } catch { /* private storage */ }
    setPane(cur, open ? 'list' : 'edit');
  });
  d.querySelector('[data-document-fullscreen-toggle]')?.addEventListener('click', () => {
    if (!cur?.selected) return;
    setPane(cur, 'edit');
    setDocumentFullscreen(d, !d.hasAttribute('data-document-fullscreen'));
    syncNotebookChrome(cur);
  });
  d.addEventListener('cancel', (e) => {
    if (e.target !== d) return;
    e.preventDefault();
    if (d.hasAttribute('data-document-fullscreen')) { setDocumentFullscreen(d, false); if (cur) syncNotebookChrome(cur); }
    else void tryClose();
  });
  d.addEventListener('close', () => {
    setDocumentFullscreen(d, false);
    const c = cur;
    cur = null;
    expandedDesktopWard();
    if (!c) return;
    c.editor.destroy();
    c.els.editHost.textContent = '';
    void renderCompact(c.w);
  });
  return d;
}

const defaultQuery = (): Query => ({ status: 'active', sort: 'manual', dir: 'asc', group: 'none', layout: 'list' });
const emptyBook = (w: WardInstance): Notebook => ({ id: w.i, title: wardTitle(w), sections: [], views: [], props: [], created: '', updated: '' });

async function openNotebook(w: WardInstance, opts: { note?: string; q?: string; create?: boolean | NotebookPageType } = {}): Promise<void> {
  const d = dialog();
  if (!d) return;
  if (cur && cur.w.i !== w.i) {
    const previous = cur;
    (document.activeElement as HTMLElement | null)?.blur?.();
    await previous.selecting;
    if (!(await previous.metaSaves) || !(await previous.editor.flush()) || previous.editor.dirty()) {
      toast('Save the open note before opening another notebook.', undefined, true);
      return;
    }
    if (cur !== previous) return;
    await new Promise<void>((resolve) => {
      d.addEventListener('close', () => resolve(), { once: true });
      d.close();
    });
  }
  if (!cur) {
    const q = (sel: string) => d.querySelector<HTMLElement>(sel)!;
    const editor = createNoteEditor(w.i);
    editor.full(true);
    const els = {
      root: q('[data-nb-root]'), nav: q('[data-nb-nav]'), list: q('[data-nb-list]'), edit: q('[data-nb-edit]'), title: q('[data-nb-title]'),
      rows: q('[data-nb-rows]'), listHead: q('[data-nb-list-head]'), editHead: q('[data-nb-edit-head]'), outline: q('[data-nb-outline]'), editHost: q('[data-nb-host]'), empty: q('[data-nb-empty]'), hint: q('[data-nb-hint]'),
    };
    els.editHost.append(editor.root);
    const c: Dlg = {
      w, drawerClosed: false, nbId: w.i, meta: { notebook: emptyBook(w), tags: [], linkable: [], notes: [], total: 0 }, nav: { kind: 'all' }, query: defaultQuery(), notes: [], total: 0, selected: null, editor,
      listGen: 0, selecting: Promise.resolve(), metaSaves: Promise.resolve(true), failedFields: new Set(), metaGen: 0, linksGen: 0, els,
    };
    cur = c;
    editor.onInput(() => outline(c));
    setPane(c, 'list');
    expandedDesktopWard(w.i);
    d.showModal();
    await refreshMeta(c);
    if (cur !== c) return;
  }
  const c = cur;
  if (opts.q) {
    c.query.q = opts.q;
    c.query.sort = 'rank';
    setNav(c, { kind: 'all' }, true);
  }
  if (opts.note) {
    await select(c, opts.note);
    if (cur === c && c.selected && sidebarCollapsed) { c.drawerClosed = true; syncNotebookChrome(c); }
  }
  if (opts.create) await createNote(c, undefined, typeof opts.create === 'string' ? opts.create : undefined);
  refitNoteEditors();
}

async function refreshMeta(c: Dlg): Promise<void> {
  const gen = ++c.metaGen;
  const params = listParams(c);
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?${params}`);
  if (cur !== c || c.metaGen !== gen) return; // a newer refresh is on its way
  if (params !== listParams(c)) return;
  if (status !== 200) {
    c.els.rows.textContent = '';
    const p = el('p', 'wd-note text-xs text-ink-faint', 'Couldn’t load the notebook.');
    const retry = el('button', 'btn min-h-0 ml-2 px-2 py-0.5 text-xs', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => void refreshMeta(c));
    p.append(retry);
    c.els.rows.append(p);
    return;
  }
  const m = data as Meta;
  c.meta = m;
  c.nbId = m.notebook.id;
  const listing = c.nav.kind !== 'ask' && c.nav.kind !== 'index';
  if (listing) {
    c.notes = m.notes;
    c.total = m.total;
    c.next = m.next;
  }
  c.els.title.textContent = m.notebook.title || wardTitle(c.w);
  renderNav(c);
  if (listing) renderList(c);
  if (c.selected) {
    const fresh = m.notes.find((n) => n.id === c.selected!.id);
    if (fresh) {
      c.selected = fresh;
      renderEditHead(c);
    }
  }
}

function listParams(c: Dlg): string {
  const p = new URLSearchParams();
  const q = c.query;
  if (q.section) p.set('section', q.section);
  if (q.tag) p.set('tag', q.tag);
  if (q.status !== 'active') p.set('status', q.status);
  if (q.pinned) p.set('pinned', '1');
  if (q.template) p.set('template', '1');
  for (const [k, v] of Object.entries(q.props ?? {})) if (v) p.set(`prop.${k}`, v);
  if (q.q) p.set('q', q.q);
  p.set('sort', q.sort);
  p.set('dir', q.dir);
  p.set('limit', String(PAGE));
  return p.toString();
}

async function refreshList(c: Dlg, offset = 0): Promise<void> {
  const gen = ++c.listGen;
  if (!offset) c.els.rows.setAttribute('aria-busy', 'true');
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?part=list&offset=${offset}&${listParams(c)}`);
  if (cur !== c || c.listGen !== gen) return; // a newer list was asked for
  c.els.rows.removeAttribute('aria-busy');
  if (status !== 200) {
    toast((data as { error?: string })?.error ?? 'Couldn’t load the notes.', undefined, true);
    return;
  }
  const page = data as { notes: NoteMeta[]; total: number; next?: number };
  c.notes = offset ? [...c.notes, ...page.notes] : page.notes;
  c.total = page.total;
  c.next = page.next;
  renderNav(c);
  renderList(c);
}

/** A change landed (ours or the agent's): the metadata and the list, coalesced. */
function scheduleRefresh(c: Dlg): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshMeta(c), 150);
}

async function op(c: Dlg, body: Record<string, unknown>): Promise<Record<string, any> | null> {
  const res = await postJson(`/api/notebook/${c.w.i}`, body);
  if (!res.ok) {
    toast((res.data as { error?: string })?.error ?? 'That didn’t work.', undefined, true);
    return null;
  }
  return res.data as Record<string, any>;
}

// ------------------------------------------------------------------- nav

function setNav(c: Dlg, nav: Nav, keepSearch = false): void {
  c.listGen++;
  c.metaGen++;
  c.nav = nav;
  const q: Query = { ...defaultQuery(), q: keepSearch ? c.query.q : undefined, sort: keepSearch && c.query.q ? 'rank' : c.query.sort === 'rank' ? 'manual' : c.query.sort, dir: c.query.dir, layout: c.query.layout };
  switch (nav.kind) {
    case 'pinned': q.pinned = true; break;
    case 'section': q.section = nav.id; break;
    case 'tag': q.tag = nav.tag; break;
    case 'status': q.status = nav.status; break;
    case 'templates': q.template = true; q.sort = 'title'; q.dir = 'asc'; break;
    case 'view': {
      const v = c.meta.notebook.views.find((x) => x.id === nav.id);
      if (v) Object.assign(q, { section: v.section, tag: v.tag, status: v.status ?? 'active', pinned: v.pinned, q: v.q ?? q.q, props: v.props, sort: v.sort, dir: v.dir, group: v.group, layout: v.layout ?? 'list' });
      break;
    }
  }
  c.query = q;
  renderNav(c);
  setPane(c, 'list');
  if (nav.kind === 'index') void renderIndex(c);
  else if (nav.kind === 'ask') renderAsk(c);
  else void refreshList(c);
}

function navItem(c: Dlg, iconId: string, label: string, nav: Nav, n?: number, menu?: (m: HTMLElement) => void): HTMLButtonElement {
  const b = el('button', 'nb-item');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(iconId), el('span', 'truncate', label));
  if (n !== undefined) b.append(el('span', 'nb-n', String(n)));
  b.setAttribute('aria-current', String(JSON.stringify(c.nav) === JSON.stringify(nav)));
  b.addEventListener('click', () => setNav(c, nav));
  const buildMenu = (m: HTMLElement) => {
    m.append(menuItem(iconId, `Open ${label}`, () => setNav(c, nav)));
    if (nav.kind === 'status' && nav.status === 'trash') { if (!shareView) m.append(menuItem('trash', 'Empty trash…', () => void emptyTrash(c), true)); }
    else if ((nav.kind === 'all' || nav.kind === 'section' || nav.kind === 'templates') && !shareReadOnly) m.append(menuItem('plus', 'New page here', () => { setNav(c, nav); void createNote(c); }));
    menu?.(m);
  };
  bindContextMenu(b, e => { e.preventDefault(); e.stopPropagation(); b.focus({ preventScroll: true }); openMenu(e.clientX, e.clientY, buildMenu); });
  holdToFire(b, 400, e => openMenu(e.clientX, e.clientY, buildMenu));
  return b;
}

function notebookMenu(c: Dlg, m: HTMLElement): void {
  if (shareReadOnly) return;
  m.append(menuItem('folder', 'Open file…', () => openNotebookFile(c)));
  if (!shareView) m.append(menuItem('pen', 'Rename notebook…', () => void renameNotebook(c)));
  for (const [kind, label, glyph] of [['document', 'Document', 'note'], ['markdown', 'Markdown', 'code'], ['spreadsheet', 'Spreadsheet', 'database'], ['slides', 'Slides', 'page'], ['drawing', 'Drawing', 'pen'], ['notion', 'Linked Notion database', 'database']] as const) m.append(menuItem(glyph, `New ${label.toLowerCase()}`, () => void createNote(c, undefined, kind === 'document' ? undefined : kind)));
  if (shareView) return;
  m.append(menuItem('folder', 'New section…', () => void addSection(c)));
  m.append(menuItem('eye', 'Save current view…', () => void saveView(c)));
  for (const type of Object.keys(PROP_TYPE_LABELS) as PropType[]) m.append(menuItem(propIcon(type), `Add ${PROP_TYPE_LABELS[type].toLowerCase()} property…`, () => void addProperty(c, type)));
}

function renderNav(c: Dlg): void {
  const { nav } = c.els;
  const book = c.meta.notebook;
  nav.textContent = '';
  const head = (label: string, action?: HTMLElement) => {
    const h = el('div', 'nb-nav-h');
    h.append(el('span', undefined, label));
    if (action) h.append(action);
    nav.append(h);
  };
  nav.append(navItem(c, 'notebook', 'All notes', { kind: 'all' }, c.nav.kind === 'all' && c.query.status === 'active' && !c.query.q ? c.total : undefined));
  nav.append(navItem(c, 'pin', 'Pinned', { kind: 'pinned' }));
  nav.append(navItem(c, 'list', 'Index', { kind: 'index' }));
  nav.append(navItem(c, 'sparkle', 'Ask', { kind: 'ask' }));
  head('Sections', shareView ? undefined : btn('plus', 'New section', () => void addSection(c), 'nb-nav-act'));
  for (const s of book.sections) {
    nav.append(navItem(c, 'folder', s.title, { kind: 'section', id: s.id }, undefined, shareView ? undefined : (m) => {
      m.append(el('div', 'ctx-label', s.title));
      m.append(menuItem('pen', 'Rename…', () => void renameSection(c, s)));
      m.append(menuItem('close', 'Delete section (notes stay)', () => void deleteSection(c, s), true));
    }));
  }
  nav.append(navItem(c, 'folder-out', 'Unfiled', { kind: 'section', id: 'none' }));
  if (c.meta.tags.length) {
    head('Tags');
    for (const t of c.meta.tags.slice(0, 40)) nav.append(navItem(c, 'tag', t.tag, { kind: 'tag', tag: t.tag }, t.n));
  }
  head('Views', shareView ? undefined : btn('plus', 'Save the current list as a view', () => void saveView(c), 'nb-nav-act'));
  for (const v of book.views) {
    nav.append(navItem(c, v.layout === 'table' ? 'database' : v.layout === 'cards' ? 'page' : 'eye', v.title, { kind: 'view', id: v.id }, undefined, shareView ? undefined : (m) => {
      m.append(el('div', 'ctx-label', v.title));
      m.append(menuItem('pen', 'Rename…', () => void renameView(c, v)));
      m.append(menuItem('reset', 'Update to the current list', () => void updateView(c, v)));
      m.append(menuItem('close', 'Delete view', () => void deleteView(c, v), true));
    }));
  }
  const addProp = btn('plus', 'Add a property', () => addPropertyMenu(c, addProp), 'nb-nav-act');
  head('Properties', shareView ? undefined : addProp);
  for (const p of book.props) {
    const b = el('button', 'nb-item');
    b.type = 'button';
    b.dataset.prop = p.id;
    b.title = p.name; b.setAttribute('aria-label', p.name);
    b.append(icon(propIcon(p.type)), el('span', 'truncate', p.name), el('span', 'nb-n', PROP_TYPE_LABELS[p.type]));
    const menu = (m: HTMLElement) => {
      m.append(el('div', 'ctx-label', `${p.name} · ${PROP_TYPE_LABELS[p.type]}`));
      if (!shareView) m.append(menuItem('pen', 'Rename…', () => void renameProperty(c, p)));
      if (p.type === 'select' && !shareView) m.append(menuItem('list', 'Edit choices…', () => void editPropertyOptions(c, p)));
      m.append(menuItem('search', 'Filter the list by it…', () => void filterByProperty(c, p)));
      if (!shareView) m.append(menuItem('close', 'Delete property (values go)', () => void deleteProperty(c, p), true));
    };
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      openMenu(r.left + 8, r.bottom, menu);
    });
    bindContextMenu(b, e => { e.preventDefault(); e.stopPropagation(); b.focus({ preventScroll: true }); openMenu(e.clientX, e.clientY, menu); });
    nav.append(b);
  }
  head('Elsewhere');
  nav.append(navItem(c, 'copy', 'Templates', { kind: 'templates' }));
  nav.append(navItem(c, 'archive', 'Archive', { kind: 'status', status: 'archived' }));
  nav.append(navItem(c, 'trash', 'Trash', { kind: 'status', status: 'trash' }));
  if (c.meta.linkable.length) {
    head('Notepads');
    for (const l of c.meta.linkable.slice(0, 20)) {
      const b = el('button', 'nb-item');
      b.type = 'button';
      b.title = `Add ${l.title} to this notebook`; b.setAttribute('aria-label', b.title);
      b.append(icon('note'), el('span', 'truncate', l.title), icon('plus', 'nb-n', 'Add to this notebook'));
      bindContextMenu(b, event => { event.preventDefault(); event.stopPropagation(); b.focus(); openMenu(event.clientX, event.clientY, menu => { menu.append(menuItem('plus', 'Add to this notebook', () => b.click())); menu.append(menuItem('note', 'Open notepad', () => void openNote(l.id, c))); }); });
      b.addEventListener('click', async () => {
        const r = await op(c, { op: 'link', id: l.id });
        if (r) {
          toast(`Added ${l.title} to ${c.meta.notebook.title || 'the notebook'} — the same document, not a copy.`);
          scheduleRefresh(c);
        }
      });
      nav.append(b);
    }
  }
}

async function addSection(c: Dlg): Promise<void> {
  const title = await askText('New section', '');
  if (!title?.trim()) return;
  const r = await op(c, { op: 'notebook', sections: [...c.meta.notebook.sections, { title: title.trim() }] });
  if (r) scheduleRefresh(c);
}
async function renameSection(c: Dlg, s: Section): Promise<void> {
  const title = await askText('Rename section', s.title);
  if (!title?.trim() || title.trim() === s.title) return;
  const r = await op(c, { op: 'notebook', sections: c.meta.notebook.sections.map((x) => (x.id === s.id ? { ...x, title: title.trim() } : x)) });
  if (r) scheduleRefresh(c);
}
async function deleteSection(c: Dlg, s: Section): Promise<void> {
  if (!await confirmAction(`Delete the section “${s.title}”? Its notes stay in the notebook, unfiled.`)) return;
  const r = await op(c, { op: 'notebook', sections: c.meta.notebook.sections.filter((x) => x.id !== s.id) });
  if (r) {
    if (c.nav.kind === 'section' && c.nav.id === s.id) setNav(c, { kind: 'all' });
    scheduleRefresh(c);
  }
}
function viewOf(c: Dlg, title: string, id?: string): Record<string, unknown> {
  const q = c.query;
  return { id, title, section: q.section === 'none' ? undefined : q.section, tag: q.tag, status: q.status, pinned: q.pinned, q: q.q, props: q.props, sort: q.sort === 'rank' ? 'updated' : q.sort, dir: q.dir, group: q.group, layout: q.layout };
}
async function saveView(c: Dlg): Promise<void> {
  const title = await askText('Save the current filter, sort and layout as a view named', '');
  if (!title?.trim()) return;
  const r = await op(c, { op: 'notebook', views: [...c.meta.notebook.views, viewOf(c, title.trim())] });
  if (r) {
    const v = (r.notebook as Notebook).views.at(-1);
    if (v) c.nav = { kind: 'view', id: v.id };
    scheduleRefresh(c);
  }
}
async function renameView(c: Dlg, v: SavedView): Promise<void> {
  const title = await askText('Rename view', v.title);
  if (!title?.trim() || title.trim() === v.title) return;
  const r = await op(c, { op: 'notebook', views: c.meta.notebook.views.map((x) => (x.id === v.id ? { ...x, title: title.trim() } : x)) });
  if (r) scheduleRefresh(c);
}
async function updateView(c: Dlg, v: SavedView): Promise<void> {
  const r = await op(c, { op: 'notebook', views: c.meta.notebook.views.map((x) => (x.id === v.id ? viewOf(c, v.title, v.id) : x)) });
  if (r) {
    toast(`Updated ${v.title}.`);
    scheduleRefresh(c);
  }
}
async function deleteView(c: Dlg, v: SavedView): Promise<void> {
  const r = await op(c, { op: 'notebook', views: c.meta.notebook.views.filter((x) => x.id !== v.id) });
  if (r) {
    if (c.nav.kind === 'view' && c.nav.id === v.id) setNav(c, { kind: 'all' });
    scheduleRefresh(c);
  }
}
async function renameNotebook(c: Dlg): Promise<void> {
  const title = await askText('Notebook name', c.meta.notebook.title || wardTitle(c.w));
  if (!title?.trim()) return;
  const r = await op(c, { op: 'notebook', title: title.trim() });
  if (r) {
    scheduleRefresh(c);
    for (const card of cards.values()) if (card.nbId === c.nbId) void renderCompact(card.w);
  }
}

// ------------------------------------------------------------ properties

/** + on Properties: pick the type, then name it (and list the choices of a Choice). */
function addPropertyMenu(c: Dlg, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.bottom, (m) => {
    m.append(el('div', 'ctx-label', 'Add a property'));
    for (const t of Object.keys(PROP_TYPE_LABELS) as PropType[]) m.append(menuItem(propIcon(t), PROP_TYPE_LABELS[t], () => void addProperty(c, t)));
  });
}
async function addProperty(c: Dlg, type: PropType): Promise<void> {
  const name = await askText(`Name of the new ${PROP_TYPE_LABELS[type].toLowerCase()} property`, '');
  if (!name?.trim()) return;
  const def: Record<string, unknown> = { name: name.trim(), type };
  if (type === 'select') {
    const opts = await askText('Choices, comma separated', '');
    if (!opts?.trim()) return;
    def.options = opts.split(',').map((o) => o.trim()).filter(Boolean);
  }
  const r = await op(c, { op: 'notebook', props: [...c.meta.notebook.props, def] });
  if (r) scheduleRefresh(c);
}
async function renameProperty(c: Dlg, p: PropDef): Promise<void> {
  const name = await askText('Rename property', p.name);
  if (!name?.trim() || name.trim() === p.name) return;
  const r = await op(c, { op: 'notebook', props: c.meta.notebook.props.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x)) });
  if (r) scheduleRefresh(c);
}
async function editPropertyOptions(c: Dlg, p: PropDef): Promise<void> {
  const opts = await askText('Choices, comma separated (a removed choice stays on the notes that had it until they are edited)', (p.options ?? []).join(', '));
  if (opts === null) return;
  const options = opts.split(',').map((o) => o.trim()).filter(Boolean);
  if (!options.length) return;
  const r = await op(c, { op: 'notebook', props: c.meta.notebook.props.map((x) => (x.id === p.id ? { ...x, options } : x)) });
  if (r) scheduleRefresh(c);
}
async function deleteProperty(c: Dlg, p: PropDef): Promise<void> {
  if (!await confirmAction(`Delete the property “${p.name}”? Its values are removed from every note in this notebook.`)) return;
  const r = await op(c, { op: 'notebook', props: c.meta.notebook.props.filter((x) => x.id !== p.id) });
  if (r) scheduleRefresh(c);
}
/** Narrow the current list to one property value (checkbox: checked). */
async function filterByProperty(c: Dlg, p: PropDef): Promise<void> {
  let v: string | null;
  if (p.type === 'checkbox') v = 'true';
  else if (p.type === 'select') v = await askText(`Show notes whose ${p.name} is one of: ${p.options!.join(', ')}`, p.options![0]);
  else v = await askText(`Show notes whose ${p.name} equals`, '');
  if (!v?.trim()) return;
  c.query.props = { ...c.query.props, [p.id]: v.trim() };
  setPane(c, 'list');
  void refreshList(c);
}

// ------------------------------------------------------------------ list

function renderList(c: Dlg): void {
  const { rows, listHead, hint } = c.els;
  c.els.root.dataset.layout = c.query.layout;
  // SearchSelect moves focus into its popup; keep its original field alive until the choice lands.
  if (!listHead.contains(document.activeElement) && !listHead.querySelector('[aria-expanded="true"]')) {
    listHead.textContent = '';
    const back = btn('left', 'Back to sections', () => { setPane(c, 'nav'); }, 'btn nb-back min-h-0 px-2 py-1 text-xs');
    const search = el('input', 'input nb-q');
    search.type = 'search';
    search.placeholder = c.query.template ? 'Search templates…' : 'Search this notebook…';
    search.setAttribute('aria-label', 'Search this notebook');
    search.value = c.query.q ?? '';
    let t = 0;
    const go = () => {
      const v = search.value.trim();
      if ((c.query.q ?? '') === v) return;
      c.query.q = v || undefined;
      if (v && c.query.sort !== 'rank') c.query.sort = 'rank';
      if (!v && c.query.sort === 'rank') c.query.sort = 'manual';
      if (v && !sort.querySelector('option[value="rank"]')) sort.prepend(new Option('Best match', 'rank'));
      if (!v) sort.querySelector('option[value="rank"]')?.remove();
      sort.value = c.query.sort;
      void refreshList(c);
    };
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(go, 250);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(t);
        go();
      }
    });
    const sort = el('select', 'input nb-sort');
    sort.setAttribute('aria-label', 'Sort notes');
    const opts: [Sort, string][] = [['manual', 'Manual order'], ['updated', 'Last updated'], ['created', 'Created'], ['title', 'Title']];
    if (c.query.q) opts.unshift(['rank', 'Best match']);
    for (const [v, l] of opts) sort.append(new Option(l, v));
    sort.value = c.query.sort;
    sort.addEventListener('change', () => {
      c.query.sort = sort.value as Sort;
      c.query.dir = sort.value === 'title' || sort.value === 'manual' ? 'asc' : 'desc';
      void refreshList(c);
    });
    const group = el('select', 'input nb-sort');
    group.setAttribute('aria-label', 'Group notes');
    for (const [v, l] of [['none', 'No grouping'], ['section', 'By section'], ['tag', 'By tag']] as const) group.append(new Option(l, v));
    group.value = c.query.group;
    group.addEventListener('change', () => {
      c.query.group = group.value as Query['group'];
      renderList(c);
    });
    const layout = el('select', 'input nb-sort nb-layout');
    layout.setAttribute('aria-label', 'Layout');
    for (const [v, l] of [['list', 'List'], ['table', 'Table'], ['cards', 'Cards']] as const) layout.append(new Option(l, v));
    layout.value = c.query.layout;
    layout.addEventListener('change', () => {
      c.query.layout = layout.value as Layout;
      renderList(c);
    });
    const addLabel = c.query.template ? 'New template' : 'New page';
    const add = btn('plus', addLabel, () => void newNoteMenu(c, add), 'btn-primary nb-add');
    add.append(el('span', undefined, addLabel));
    listHead.append(back, search, sort, group, layout, add);
    if (c.query.status === 'trash' && c.notes.length) listHead.append(btn('trash', 'Empty the trash (delete every trashed note for good)', () => void emptyTrash(c)));
    const filters = Object.entries(c.query.props ?? {}).filter(([, v]) => v);
    if (filters.length) {
      const row = el('div', 'nb-backlinks');
      row.append(el('span', undefined, 'Filtered:'));
      for (const [pid, v] of filters) {
        const p = c.meta.notebook.props.find((x) => x.id === pid);
        const chip = el('button', 'chip', `${p?.name ?? pid} = ${p?.type === 'checkbox' ? (v === 'true' ? 'yes' : 'no') : v}`);
        chip.append(icon('close'));
        chip.type = 'button';
        chip.title = 'Remove this filter';
        chip.addEventListener('click', () => {
          const next = { ...c.query.props };
          delete next[pid];
          c.query.props = Object.keys(next).length ? next : undefined;
          void refreshList(c);
        });
        row.append(chip);
      }
      listHead.append(row);
    }
  }
  hint.textContent = c.query.q
    ? 'Titles, text and tags. Handwriting is found once it has been transcribed.'
    : c.query.template
      ? 'New note offers templates with their text, handwriting, tags and properties.'
      : c.query.status === 'trash'
        ? 'Restore from a note’s menu; Delete forever removes it on every runtime it synced to.'
        : '';

  rows.textContent = '';
  rows.setAttribute('role', 'listbox');
  rows.setAttribute('aria-label', c.query.template ? 'Templates' : 'Notes');
  if (!c.notes.length) {
    const msg = c.query.q
      ? `Nothing matches “${c.query.q}”.`
      : c.query.status === 'trash'
        ? 'The trash is empty.'
        : c.query.status === 'archived'
          ? 'Nothing archived.'
          : c.query.template
            ? 'No templates yet — mark a note “Use as a template” from its menu, or make one here.'
            : c.nav.kind === 'all'
              ? 'No notes yet.'
              : 'No notes here.';
    const p = el('p', 'wd-note text-xs text-ink-faint', msg);
    if (!c.query.q && c.query.status === 'active') {
      const b = el('button', 'btn min-h-0 ml-2 px-2 py-0.5 text-xs', c.query.template ? 'New template' : 'New note');
      b.type = 'button';
      b.addEventListener('click', () => void createNote(c));
      const open = el('button', 'btn min-h-0 ml-2 px-2 py-0.5 text-xs', 'Open file…'); open.type = 'button'; open.onclick = () => openNotebookFile(c);
      p.append(b, open);
    }
    rows.append(p);
    return;
  }
  if (c.query.layout === 'table') renderTable(c);
  else if (c.query.layout === 'cards') renderCards(c);
  else renderRows(c);
  if (c.next !== undefined) {
    const more = el('button', 'btn min-h-0 mx-auto my-2 px-2 py-1 text-xs', `Load more (${c.total - c.notes.length} left)`);
    more.type = 'button';
    more.addEventListener('click', () => void refreshList(c, c.next));
    rows.append(more);
  }
  rows.addEventListener('keydown', listKeys, { once: false });
}

/** The notes grouped as the Group select says (one group, key '', when none). */
function groupsOf(c: Dlg): Map<string, NoteMeta[]> {
  const sectionTitle = (id: string | null) => (id ? c.meta.notebook.sections.find((s) => s.id === id)?.title ?? 'Unfiled' : 'Unfiled');
  const groups = new Map<string, NoteMeta[]>();
  for (const n of c.notes) {
    const keys = c.query.group === 'section' ? [sectionTitle(n.section)] : c.query.group === 'tag' ? (n.tags.length ? n.tags : ['No tag']) : [''];
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return groups;
}

function renderRows(c: Dlg): void {
  let first = true;
  for (const [k, list] of groupsOf(c)) {
    if (k) c.els.rows.append(el('div', 'nb-group', k));
    for (const n of list) {
      c.els.rows.append(row(c, n, first));
      first = false;
    }
  }
}

/** Table layout: built-in columns plus one per property; rows select like list rows. */
function renderTable(c: Dlg): void {
  const props = c.meta.notebook.props;
  const wrap = el('div', 'nb-table-wrap');
  const table = el('table', 'nb-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Title', 'Section', 'Tags', c.query.sort === 'created' ? 'Created' : 'Updated', ...props.map((p) => p.name)]) hr.append(el('th', undefined, h));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  let first = true;
  for (const [k, list] of groupsOf(c)) {
    if (k) {
      const tr = el('tr');
      const td = el('td', 'nb-group', k);
      td.colSpan = 4 + props.length;
      tr.append(td);
      tbody.append(tr);
    }
    for (const n of list) {
      const tr = el('tr', 'nb-row');
      wireRow(c, tr, n, first);
      first = false;
      const title = el('td');
      if (n.pinned) title.append(icon('pin', 'nb-pin', 'Pinned'));
      title.append(titleOf(n));
      tr.append(
        title,
        el('td', undefined, n.section ? c.meta.notebook.sections.find((s) => s.id === n.section)?.title ?? '' : ''),
        el('td', undefined, n.tags.map((t) => `#${t}`).join(' ')),
        el('td', 'tabular-nums', when(c.query.sort === 'created' ? n.created : n.updated))
      );
      for (const p of props) {
        const cell = el('td', undefined, propText(p, n.props[p.id]));
        if (p.type === 'checkbox' && n.props[p.id] === true) {
          cell.replaceChildren(icon('check', 'text-accent'));
          cell.setAttribute('aria-label', 'Checked');
        }
        tr.append(cell);
      }
      tbody.append(tr);
    }
  }
  table.append(tbody);
  wrap.append(table);
  c.els.rows.append(wrap);
}

/** Card layout: a grid of short cards with the excerpt. */
function renderCards(c: Dlg): void {
  let first = true;
  for (const [k, list] of groupsOf(c)) {
    if (k) c.els.rows.append(el('div', 'nb-group', k));
    const grid = el('div', 'nb-cards');
    for (const n of list) {
      const card = el('div', 'nb-row nb-card');
      wireRow(c, card, n, first);
      first = false;
      const t = el('div', 'nb-row-t');
      if (n.pinned) t.append(icon('pin', 'nb-pin', 'Pinned'));
      t.append(el('span', 'min-w-0 flex-1 truncate', titleOf(n)));
      card.append(t);
      if (n.snippet) card.append(snippet(n.snippet));
      else if (n.title && n.excerpt) card.append(el('div', 'nb-card-x', n.excerpt));
      card.append(el('div', 'nb-row-x', [...n.tags.map((x) => `#${x}`), when(n.updated)].join(' · ')));
      grid.append(card);
    }
    c.els.rows.append(grid);
  }
}

function listKeys(e: KeyboardEvent): void {
  const c = cur;
  if (!c) return;
  const items = [...c.els.rows.querySelectorAll<HTMLElement>('.nb-row')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const go = (i: number) => {
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  };
  if (e.key === 'ArrowDown') go(at + 1);
  else if (e.key === 'ArrowUp') go(at - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if ((e.key === 'Enter' || e.key === ' ') && items[at]) {
    e.preventDefault();
    items[at]!.click();
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && c.query.sort === 'manual') {
    e.preventDefault();
    const n = c.notes.find((x) => x.id === items[at]!.dataset.id);
    if (n) void moveNote(c, n, e.key === 'ArrowUp' ? -1 : 1);
  }
}

/** Selection, focus, click and the context menu — shared by every layout's row. */
function wireRow(c: Dlg, r: HTMLElement, n: NoteMeta, first: boolean): void {
  r.setAttribute('role', 'option');
  r.dataset.id = n.id;
  const selected = c.selected?.id === n.id;
  r.setAttribute('aria-selected', String(selected));
  r.tabIndex = selected || (first && !c.selected) ? 0 : -1;
  r.addEventListener('click', () => void select(c, n.id));
  const menu = (m: HTMLElement) => noteMenu(c, n, m);
  bindContextMenu(r, e => { e.preventDefault(); e.stopPropagation(); r.focus({ preventScroll: true }); openMenu(e.clientX, e.clientY, menu); });
  holdToFire(r, 400, (e) => openMenu(e.clientX, e.clientY, menu));
}

function row(c: Dlg, n: NoteMeta, first: boolean): HTMLElement {
  const r = el('div', 'nb-row');
  wireRow(c, r, n, first);
  const t = el('div', 'nb-row-t');
  if (n.pinned) t.append(icon('pin', 'nb-pin', 'Pinned'));
  t.append(el('span', 'min-w-0 flex-1 truncate', titleOf(n)));
  t.append(el('span', 'shrink-0 text-[10px] tabular-nums text-ink-faint', when(c.query.sort === 'created' ? n.created : n.updated)));
  r.append(t);
  if (n.snippet) r.append(snippet(n.snippet));
  else {
    const sub = [c.query.group !== 'section' && n.section ? c.meta.notebook.sections.find((s) => s.id === n.section)?.title : undefined, ...n.tags.map((x) => `#${x}`)].filter(Boolean).join(' · ');
    const line = n.title ? n.excerpt : '';
    if (line) r.append(el('div', 'nb-row-x', line));
    if (sub) r.append(el('div', 'nb-row-x', sub));
  }
  return r;
}

function noteMenu(c: Dlg, n: NoteMeta, m: HTMLElement): void {
  m.append(el('div', 'ctx-label', titleOf(n)));
  m.append(menuItem('note', 'Open', () => void select(c, n.id)));
  m.append(menuItem('copy', 'Copy page link', () => { void (async () => {
    const link = el('a', undefined, titleOf(n)); link.dataset.note = n.id;
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([link.outerHTML], { type: 'text/html' }), 'text/plain': new Blob([titleOf(n)], { type: 'text/plain' }) })]);
  })().catch(() => toast('Clipboard unavailable. Type [[ in a document to insert a page link.', undefined, true)); }));
  if (shareReadOnly) return;
  if (!n.trashed) {
    m.append(menuItem('pen', 'Rename…', () => { void askText('Page title', n.title).then(title => { if (title?.trim()) void patchNote(c, n, { title: title.trim() }); }); }));
    m.append(menuItem('copy', 'Duplicate page', () => { void (async () => { if (c.selected?.id === n.id && !(await c.editor.flush())) return; await createNote(c, n.id); })(); }));
    m.append(menuItem('pin', n.pinned ? 'Unpin' : 'Pin', () => void patchNote(c, n, { pinned: !n.pinned })));
    for (const s of c.meta.notebook.sections) if (s.id !== n.section) m.append(menuItem('folder', `Move to ${s.title}`, () => void patchNote(c, n, { section: s.id })));
    if (n.section) m.append(menuItem('folder-out', 'Unfile (no section)', () => void patchNote(c, n, { section: '' })));
    if (c.query.sort === 'manual' && !c.query.q) {
      m.append(menuItem('up', 'Move up (⌥↑)', () => void moveNote(c, n, -1)));
      m.append(menuItem('down', 'Move down (⌥↓)', () => void moveNote(c, n, 1)));
    }
    m.append(el('hr', 'ctx-sep'));
    m.append(menuItem('copy', n.template ? 'Stop using as a template' : 'Use as a template', () => void patchNote(c, n, { template: !n.template })));
    if (n.template) m.append(menuItem('plus', 'New note from this template', () => void createNote(c, n.id)));
    m.append(menuItem('archive', n.archived ? 'Unarchive' : 'Archive', () => void patchNote(c, n, { archived: !n.archived })));
    m.append(menuItem('trash', 'Move to trash', () => void trashNote(c, n, true), true));
    m.append(menuItem('folder-out', 'Remove from notebook (keep the note)', () => void unlinkNote(c, n), true));
  } else {
    m.append(menuItem('undo', 'Restore', () => void trashNote(c, n, false)));
    if (!shareView) m.append(menuItem('trash', 'Delete forever…', () => void purgeNote(c, n), true));
    m.append(el('p', 'px-3 py-1 text-[10px] text-ink-faint', 'Restore puts it back where it was. Delete forever cannot be undone.'));
  }
}

/** A metadata change. The saves chain so a switch/close can wait for them; a failure keeps the draft in its field. */
function patchNote(c: Dlg, n: NoteMeta, patch: Record<string, unknown>): Promise<boolean> {
  const fields = Object.keys(patch).flatMap((key) => key === 'props' ? Object.keys(patch.props as object).map((id) => `props.${id}`) : [key]);
  const run = async (): Promise<boolean> => {
    const r = await op(c, { op: 'update', id: n.id, ...patch });
    if (!r) {
      if (c.selected?.id === n.id) {
        fields.forEach((field) => c.failedFields.add(field));
        restoreDraft(c, patch);
      }
      return false;
    }
    const meta = r.note as NoteMeta;
    if (c.selected?.id === n.id) {
      fields.forEach((field) => c.failedFields.delete(field));
      c.selected = meta;
      renderEditHead(c);
    }
    scheduleRefresh(c);
    return c.failedFields.size === 0;
  };
  const p = c.metaSaves.then(run, run);
  c.metaSaves = p.then((ok) => ok, () => false);
  return p;
}
/** A title/tag/property save failed: the typed value goes back into its field so it is not lost. */
function restoreDraft(c: Dlg, patch: Record<string, unknown>): void {
  const title = c.els.editHead.querySelector<HTMLInputElement>('.nb-title');
  const tags = c.els.editHead.querySelector<HTMLInputElement>('.nb-tags');
  if (typeof patch.title === 'string' && title) title.value = patch.title;
  if (Array.isArray(patch.tags) && tags) tags.value = (patch.tags as string[]).join(', ');
  if (patch.props && typeof patch.props === 'object') {
    for (const [pid, v] of Object.entries(patch.props as Record<string, unknown>)) {
      const ctl = c.els.editHead.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-prop="${pid}"]`);
      if (!ctl) continue;
      if (ctl instanceof HTMLInputElement && ctl.type === 'checkbox') ctl.checked = v === true;
      else ctl.value = v === null || v === undefined ? '' : String(v);
    }
  }
}
/** The open note leaves the editor first — it saves, or the change waits. */
async function leaveIfOpen(c: Dlg, id: string): Promise<boolean> {
  if (c.selected?.id !== id) return true;
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (!(await c.metaSaves)) return false;
  if (!(await c.editor.open(null))) {
    toast('Save the open note first — it has changes that did not save.', undefined, true);
    return false;
  }
  c.selected = null;
  renderEditHead(c);
  return true;
}
async function trashNote(c: Dlg, n: NoteMeta, trashed: boolean): Promise<void> {
  if (trashed && !(await leaveIfOpen(c, n.id))) return;
  const r = await op(c, { op: 'update', id: n.id, trashed });
  if (!r) return;
  scheduleRefresh(c);
  if (trashed) toast(`Moved ${titleOf(n)} to the trash.`, { label: 'Undo', fn: () => void trashNote(c, n, false) });
}
async function purgeNote(c: Dlg, n: NoteMeta): Promise<void> {
  if (!await confirmAction(`Delete “${titleOf(n)}” for good? Its text, ink and links are removed everywhere it synced to. This cannot be undone.`)) return;
  if (!(await leaveIfOpen(c, n.id))) return;
  const r = await op(c, { op: 'purge', id: n.id });
  if (!r) return;
  scheduleRefresh(c);
  toast(`Deleted ${titleOf(n)} for good.`);
}
async function emptyTrash(c: Dlg): Promise<void> {
  if (!await confirmAction(`Delete every note in this notebook's trash for good (${c.total})? This cannot be undone.`)) return;
  if (c.selected?.trashed && !(await leaveIfOpen(c, c.selected.id))) return;
  const r = await op(c, { op: 'empty-trash' });
  if (!r) return;
  scheduleRefresh(c);
  toast(`Deleted ${r.purged} note${r.purged === 1 ? '' : 's'} for good.`);
}
async function unlinkNote(c: Dlg, n: NoteMeta): Promise<void> {
  if (!(await leaveIfOpen(c, n.id))) return;
  const r = await op(c, { op: 'unlink', id: n.id });
  if (!r) return;
  scheduleRefresh(c);
  toast(`${titleOf(n)} is out of the notebook — the note itself is kept.`, { label: 'Undo', fn: async () => { if (await op(c, { op: 'link', id: n.id, section: n.section ?? undefined })) scheduleRefresh(c); } });
}
async function moveNote(c: Dlg, n: NoteMeta, by: -1 | 1): Promise<void> {
  const ids = c.notes.filter((x) => x.pinned === n.pinned).map((x) => x.id);
  const at = ids.indexOf(n.id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  const all = [...c.notes.filter((x) => x.pinned).map((x) => x.id), ...c.notes.filter((x) => !x.pinned).map((x) => x.id)];
  const merged = n.pinned ? [...ids, ...all.filter((x) => !ids.includes(x))] : [...all.filter((x) => !ids.includes(x)), ...ids];
  if (await op(c, { op: 'reorder', ids: merged })) {
    await refreshList(c);
    c.els.rows.querySelector<HTMLElement>(`.nb-row[data-id="${n.id}"]`)?.focus();
  }
}

/** New ▾: a blank note, or one from each template (when the notebook has any). */
async function newNoteMenu(c: Dlg, anchor: HTMLElement): Promise<void> {
  if (c.query.template) return createNote(c);
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?part=list&template=1&sort=title&dir=asc&limit=20`);
  const templates = status === 200 ? (data as { notes: NoteMeta[] }).notes : [];
  if (cur !== c) return;
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.bottom, (m) => {
    m.append(menuItem('folder', 'Open file…', () => openNotebookFile(c)));
    m.append(menuItem('note', 'Document', () => void createNote(c)));
    for (const [type, label, glyph] of [['markdown', 'Markdown', 'code'], ['spreadsheet', 'Spreadsheet', 'database'], ['slides', 'Slides', 'page'], ['drawing', 'Drawing', 'pen'], ['notion', 'Linked Notion database', 'database']] as const) m.append(menuItem(glyph, label, () => void createNote(c, undefined, type)));
    if (templates.length) m.append(el('div', 'ctx-label', 'From a template'));
    for (const t of templates) m.append(menuItem('copy', titleOf(t), () => void createNote(c, t.id)));
  });
}

function openNotebookFile(c: Dlg): void {
  if (c.importing) return;
  pickNotebookFiles(files => importNotebookFiles(c, files), false);
}
async function importNotebookFiles(c: Dlg, files: File[]): Promise<void> {
  if (c.importing || cur !== c || !files[0]) return;
  c.importing = true;
  const button = dlg?.querySelector<HTMLButtonElement>('[data-nb-open]'); if (button) button.disabled = true;
  try {
    const imported = await importNotebookFile(files[0]);
    if (cur === c) await createNote(c, undefined, undefined, imported);
  } finally { c.importing = false; if (button && cur === c) button.disabled = false; }
}

async function createNote(c: Dlg, from?: string, kind?: NotebookPageType, imported?: ImportedNotebookFile): Promise<void> {
  if (!(await c.metaSaves) || c.failedFields.size || !(await c.editor.flush()) || c.editor.dirty()) {
    toast('Save the open note first — it has changes that did not save.', undefined, true);
    return;
  }
  const section = c.query.section && c.query.section !== 'none' ? c.query.section : undefined;
  if (cur !== c) return;
  const r = await op(c, { op: 'create', section, from, kind, html: imported?.html, title: imported?.title, template: c.query.template === true || undefined });
  if (!r) return;
  if (cur !== c) return;
  const meta = r.note as NoteMeta;
  if (imported) toast(imported.warnings.length ? `Opened ${imported.title}. ${imported.warnings.join(' ')}` : `Opened ${imported.title}.`);
  if (c.query.status !== 'active' || c.query.q || c.query.pinned || c.query.tag || c.query.props) setNav(c, section ? { kind: 'section', id: section } : meta.template ? { kind: 'templates' } : { kind: 'all' });
  else void refreshList(c);
  await select(c, meta.id, meta);
  c.els.editHead.querySelector<HTMLInputElement>('.nb-title')?.focus();
}

async function renderIndex(c: Dlg): Promise<void> {
  const { rows, listHead, hint } = c.els;
  listHead.textContent = '';
  listHead.append(btn('left', 'Back to sections', () => { setPane(c, 'nav'); }, 'btn nb-back min-h-0 px-2 py-1 text-xs'), el('span', 'text-xs text-ink-muted', 'Index — every note by section'));
  hint.textContent = '';
  rows.textContent = '';
  rows.append(el('p', 'wd-note text-xs text-ink-faint', 'Loading…'));
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?part=index`);
  if (cur !== c || c.nav.kind !== 'index') return;
  rows.textContent = '';
  if (status !== 200) {
    rows.append(el('p', 'wd-note text-xs text-ink-faint', 'Couldn’t build the index.'));
    return;
  }
  const index = (data as { index: { section: string | null; notes: { id: string; title: string }[] }[] }).index;
  if (!index.length) rows.append(el('p', 'wd-note text-xs text-ink-faint', 'No notes yet.'));
  for (const part of index) {
    rows.append(el('div', 'nb-group', part.section ? c.meta.notebook.sections.find((s) => s.id === part.section)?.title ?? 'Unfiled' : 'Unfiled'));
    const ol = el('ol', 'nb-index');
    for (const n of part.notes) {
      const li = el('li');
      const b = el('button', 'nb-index-b', n.title);
      b.type = 'button';
      b.addEventListener('click', () => void select(c, n.id));
      li.append(b);
      ol.append(li);
    }
    rows.append(ol);
  }
}

// ------------------------------------------------------------------- ask

/** Ask: one question → the notebook ward's model answers from the best-matching notes; sources open on click. */
function renderAsk(c: Dlg): void {
  const { rows, listHead, hint } = c.els;
  listHead.textContent = '';
  listHead.append(btn('left', 'Back to sections', () => { setPane(c, 'nav'); }, 'btn nb-back min-h-0 px-2 py-1 text-xs'), el('span', 'text-xs text-ink-muted', 'Ask this notebook'));
  hint.textContent = '';
  rows.textContent = '';
  rows.removeAttribute('role');
  const box = el('div', 'nb-ask');
  const form = el('div', 'flex gap-2');
  const q = el('input', 'input nb-q nb-ask-q');
  q.type = 'text';
  q.placeholder = 'What do my notes say about…';
  q.setAttribute('aria-label', 'Question');
  const scope = el('select', 'input');
  scope.setAttribute('aria-label', 'Notes to include');
  scope.append(new Option('Automatic', 'auto'), new Option('All notes', 'all'), new Option('Matching notes', 'matches'));
  const go = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'Ask');
  go.type = 'button';
  const out = el('div', 'nb-ask-a');
  out.setAttribute('role', 'status');
  const src = el('div', 'nb-ask-src');
  const ask = async () => {
    const text = q.value.trim();
    if (!text || go.disabled) return;
    go.disabled = q.disabled = scope.disabled = true;
    if (!(await c.metaSaves) || c.failedFields.size || !(await c.editor.flush()) || c.editor.dirty()) {
      go.disabled = q.disabled = scope.disabled = false; toast('Save the open note before asking. Its latest edits have not been saved.', undefined, true); return;
    }
    if (!box.isConnected || cur !== c || c.nav.kind !== 'ask') return;
    out.setAttribute('aria-busy', 'true');
    out.textContent = 'Thinking…';
    src.textContent = '';
    const res = await postJson(`/api/notebook/${c.w.i}`, { op: 'ask', q: text, scope: scope.value });
    go.disabled = q.disabled = scope.disabled = false;
    out.removeAttribute('aria-busy');
    if (!box.isConnected || cur !== c || c.nav.kind !== 'ask') return;
    if (!res.ok) {
      out.textContent = '';
      toast((res.data as { error?: string })?.error ?? 'The model call failed.', undefined, true);
      return;
    }
    const d = res.data as { answer: string; sources: { id: string; title: string }[]; coverage?: { used: number; total: number; condensed: boolean } };
    hint.textContent = d.coverage ? `Used ${d.coverage.used} of ${d.coverage.total} active notes${d.coverage.condensed ? ' · condensed in batches' : ''}` : '';
    out.textContent = d.answer;
    if (d.sources.length) {
      src.append(el('span', 'text-[10px] text-ink-faint', 'From:'));
      for (const s of d.sources) {
        const chip = el('button', 'chip', s.title);
        chip.type = 'button';
        chip.addEventListener('click', () => void select(c, s.id));
        src.append(chip);
      }
    }
  };
  go.addEventListener('click', () => void ask());
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void ask();
    }
  });
  form.append(q, scope, go);
  box.append(form, out, src);
  rows.append(box);
  q.focus();
}

// ---------------------------------------------------------------- editor

function select(c: Dlg, id: string, known?: NoteMeta): Promise<void> {
  const p = c.selecting.then(() => selectNow(c, id, known));
  c.selecting = p.catch(() => {});
  return p;
}
async function selectNow(c: Dlg, id: string, known?: NoteMeta): Promise<void> {
  if (cur !== c) return;
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (!(await c.metaSaves)) {
    toast('A title or tag change did not save — fix it before switching.', undefined, true);
    return;
  }
  const meta = known ?? c.notes.find((n) => n.id === id) ?? (await fetchMeta(c, id));
  if (!meta || cur !== c) return;
  const cfg = notebookConfig(c.w);
  const hadPending = c.editor.dirty();
  const ok = await c.editor.open({ id, api: `/api/note/${id}?ward=${c.w.i}`, title: titleOf(meta), cfg });
  if (cur !== c) return;
  if (!ok) {
    if (c.editor.id() === id) {
      // The editor moved to the note but could not load it: nothing is selected now (the footer says why).
      c.selected = null;
      markRows(c, null);
      renderEditHead(c);
      toast('That note could not be loaded.', undefined, true);
    } else if (hadPending) toast('The open note has unsaved changes — fix the save before switching.', undefined, true);
    return;
  }
  if (c.editor.id() !== id) return; // a later selection already took the editor
  c.selected = meta;
  setPane(c, 'edit');
  markRows(c, id);
  renderEditHead(c);
  refitNoteEditors();
  if (!reducedMotion()) c.els.edit.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
}

/** The list's selection marker follows the editor: one row selected (and tabbable), or none. */
function markRows(c: Dlg, id: string | null): void {
  const rows = [...c.els.rows.querySelectorAll<HTMLElement>('.nb-row')];
  const visibleSelection = rows.some((r) => r.dataset.id === id);
  for (const r of rows) {
    const on = r.dataset.id === id;
    r.setAttribute('aria-selected', String(on));
    r.tabIndex = on || (!visibleSelection && r === rows[0]) ? 0 : -1;
  }
}

/** A note not on the current page of the list (a search hit opened from the card, an index entry): one exact, notebook-scoped lookup. */
async function fetchMeta(c: Dlg, id: string, quiet = false): Promise<NoteMeta | null> {
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?part=meta&note=${encodeURIComponent(id)}`);
  if (status === 200 && (data as { note?: NoteMeta })?.note) return (data as { note: NoteMeta }).note;
  if (!quiet) toast(status === 404 ? 'That note is not in this notebook any more.' : 'Couldn’t load that note.', undefined, true);
  return null;
}

function renderEditHead(c: Dlg): void {
  syncNotebookChrome(c);
  const { editHead, empty, editHost, outline: outlineEl } = c.els;
  const n = c.selected;
  // A title, tags or property field being typed into keeps its draft: rebuilding the head would throw it away.
  if (n && editHead.dataset.note === n.id && (c.failedFields.size > 0 || editHead.contains(document.activeElement) || editHead.querySelector('[aria-expanded="true"]'))) return;
  editHead.textContent = '';
  editHead.dataset.note = n?.id ?? '';
  empty.hidden = !!n;
  editHost.hidden = !n;
  outlineEl.hidden = !n;
  editHead.append(btn('left', 'Back to the list', () => { setPane(c, 'list'); }, 'btn nb-back min-h-0 px-2 py-1 text-xs'));
  if (!n) return;
  const title = el('input', 'nb-title');
  title.type = 'text';
  title.maxLength = 120;
  title.placeholder = 'Untitled';
  title.value = n.title;
  title.setAttribute('aria-label', 'Note title');
  const saveTitle = () => {
    const v = title.value.replace(/\s+/g, ' ').trim();
    if (v !== n.title) void patchNote(c, n, { title: v });
  };
  title.addEventListener('blur', saveTitle);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      title.blur();
      c.editor.doc.focus();
    }
  });
  editHead.append(title);
  if (n.pinned) editHead.append(icon('pin', 'nb-pin', 'Pinned'));
  if (n.template) editHead.append(el('span', 'chip', 'Template'));
  if (n.archived) editHead.append(el('span', 'chip', 'Archived'));
  if (n.trashed) editHead.append(el('span', 'chip', 'In the trash'));
  const section = el('select', 'input nb-sort');
  section.setAttribute('aria-label', 'Section');
  section.append(new Option('No section', ''));
  for (const s of c.meta.notebook.sections) section.append(new Option(s.title, s.id));
  section.value = n.section ?? '';
  section.addEventListener('change', () => void patchNote(c, n, { section: section.value }));
  const tags = el('input', 'input nb-tags');
  tags.type = 'text';
  tags.placeholder = 'tags, comma separated';
  tags.setAttribute('aria-label', 'Tags, comma separated');
  tags.value = n.tags.join(', ');
  const saveTags = () => {
    const list = tags.value.split(',').map((t) => t.trim()).filter(Boolean);
    if (JSON.stringify(list) !== JSON.stringify(n.tags)) void patchNote(c, n, { tags: list });
  };
  tags.addEventListener('blur', saveTags);
  tags.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tags.blur();
    }
  });
  const more = btn('more', 'More…', () => {
    const r = more.getBoundingClientRect();
    openMenu(r.left, r.bottom, (m) => noteMenu(c, n, m));
  });
  editHead.append(section, tags, more);
  // The notebook's properties, one control each; a change saves that one value.
  if (c.meta.notebook.props.length) {
    const row = el('div', 'nb-props');
    for (const p of c.meta.notebook.props) {
      const wrap = el('label', 'nb-prop');
      wrap.append(el('span', undefined, p.name));
      const v = n.props[p.id];
      let ctl: HTMLInputElement | HTMLSelectElement;
      if (p.type === 'select') {
        ctl = el('select', 'input');
        ctl.append(new Option('—', ''));
        for (const o of p.options ?? []) ctl.append(new Option(o, o));
        if (typeof v === 'string' && v && !(p.options ?? []).includes(v)) ctl.append(new Option(v, v)); // a value from a removed choice stays visible
        ctl.value = typeof v === 'string' ? v : '';
      } else {
        ctl = el('input', p.type === 'checkbox' ? '' : 'input');
        ctl.type = p.type === 'checkbox' ? 'checkbox' : p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text';
        if (p.type === 'checkbox') ctl.checked = v === true;
        else ctl.value = v === undefined || v === null ? '' : String(v);
        if (p.type === 'text') ctl.maxLength = 500;
      }
      ctl.dataset.prop = p.id;
      ctl.setAttribute('aria-label', p.name);
      const save = () => {
        const value = ctl instanceof HTMLInputElement && ctl.type === 'checkbox' ? ctl.checked : ctl.value;
        const was = p.type === 'checkbox' ? v === true : v === undefined || v === null ? '' : String(v);
        if (value !== was) void patchNote(c, n, { props: { [p.id]: value } });
      };
      ctl.addEventListener('change', save);
      wrap.append(ctl);
      row.append(wrap);
    }
    editHead.append(row);
  }
  void renderBacklinks(c, n);
  outline(c);
}

/** "Linked from": the notes whose text links to the open one (any notebook); a chip opens it. */
async function renderBacklinks(c: Dlg, n: NoteMeta): Promise<void> {
  const gen = ++c.linksGen;
  const { status, data } = await getJson(`/api/notebook/${c.w.i}?part=backlinks&note=${encodeURIComponent(n.id)}`);
  if (cur !== c || c.linksGen !== gen || c.selected?.id !== n.id || c.els.editHead.dataset.note !== n.id) return;
  const links = status === 200 ? (data as { backlinks: { id: string; title: string; notebook: string | null }[] }).backlinks : [];
  c.els.editHead.querySelector('.nb-backlinks')?.remove();
  if (!links.length) return;
  const row = el('div', 'nb-backlinks');
  row.append(icon('link'), el('span', undefined, 'Linked from:'));
  for (const l of links.slice(0, 20)) {
    const chip = el('button', 'chip', l.title);
    chip.type = 'button';
    chip.addEventListener('click', () => void openNote(l.id, c));
    row.append(chip);
  }
  c.els.editHead.append(row);
}

/** Open a note by id from wherever it is: this notebook, or the notebook ward on the dashboard that has it. */
async function openNote(id: string, c: Dlg | null = cur): Promise<void> {
  if (c && cur === c) {
    const meta = await fetchMeta(c, id, true);
    if (meta) return select(c, id, meta);
  }
  for (const card of cards.values()) {
    if (c && card.w.i === c.w.i) continue;
    const { status } = await getJson(`/api/notebook/${card.w.i}?part=meta&note=${encodeURIComponent(id)}`);
    if (status === 200) return openNotebook(card.w, { note: id });
  }
  await openLinkedNote(id);
}

/** The open note's headings — jump links over the editor. */
function outline(c: Dlg): void {
  const box = c.els.outline;
  box.textContent = '';
  if (!c.selected) return;
  const hs = [...c.editor.doc.querySelectorAll<HTMLElement>('h1, h2, h3')].filter((h) => h.textContent?.trim());
  box.hidden = !hs.length;
  for (const h of hs.slice(0, 40)) {
    const b = el('button', 'nb-outline-b', h.textContent!.trim());
    b.type = 'button';
    b.dataset.l = h.tagName.slice(1);
    b.addEventListener('click', () => h.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'instant' : 'smooth' }));
    box.append(b);
  }
}

// ------------------------------------------------------------- events

document.getElementById('notebook-dialog')?.querySelector('[data-nb-rename]')?.addEventListener('click', () => {
  if (cur) void renameNotebook(cur);
});
// The agent or another surface changed the notebook (logic.ts relays the stream event).
window.addEventListener('fd:notebook', (e) => {
  const id = (e as CustomEvent<{ notebook?: string }>).detail?.notebook;
  if (cur && cur.nbId === id) scheduleRefresh(cur);
  for (const card of cards.values()) if (card.nbId === id && (!cur || cur.w.i !== card.w.i)) void renderCompact(card.w);
});
// A title or tag edit elsewhere: the list shows it. A note deleted for good elsewhere leaves the editor.
window.addEventListener('fd:note', (e) => {
  const d = (e as CustomEvent<{ note?: string; meta?: boolean; gone?: boolean }>).detail ?? {};
  const c = cur;
  if (!c) return;
  if (d.meta) scheduleRefresh(c);
  if (d.gone && d.note && c.selected?.id === d.note) {
    void c.editor.open(null).then((ok) => {
      if (cur !== c) return;
      if (!ok) {
        toast('That note was deleted. Copy any unsaved text before closing.', undefined, true);
        return;
      }
      c.selected = null;
      renderEditHead(c);
      markRows(c, null);
      scheduleRefresh(c);
      toast('That note was deleted for good.');
    });
  }
});
// A note link ([[Title]] in any document) was clicked: open that note.
window.addEventListener('fd:open-note', (e) => {
  const id = (e as CustomEvent<{ note?: string }>).detail?.note;
  if (id) void openNote(id);
});
window.addEventListener('fd:before-workspace-navigation', (e) => {
  const c = cur;
  if (!c) return;
  (e as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil((async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await c.selecting;
    if (!(await c.metaSaves) || c.failedFields.size) throw Error('The note metadata could not be saved. Retry before leaving.');
  })());
});
