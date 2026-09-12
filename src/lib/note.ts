import crypto from 'node:crypto';
import { getDb } from './db.ts';
import { getDashboard } from './dashboard.ts';
import type { WardInstance } from './wards.ts';
import { excerpt, noteLinks, plainText, sanitizeHtml } from './note-text.ts';
import { emitNoteEvent } from './note-events.ts';
import { knowledgeChanged } from './agent/observation-events.ts';
import { readPageDocument } from './notebook-pages.ts';

export { excerpt, plainText, sanitizeHtml, textToHtml, noteLinks } from './note-text.ts';

// The note document store. The document is HTML the browser's own editor
// produced (contenteditable), so the trust boundary is here: every save is
// rebuilt through an allowlist — tags from a fixed set, no attributes but a
// vetted href and a text-align, every stray `<` escaped, every tag balanced —
// and a page only ever renders what came back out of this file. The agent's
// write_note goes through the same door.
//
// A document is keyed (user, id) in `notes` (the column is still called
// `ward`: a Notepad ward's document id IS its ward id unless its config names
// another one — `noteIdOf`). A notebook (lib/notebook.ts) organizes documents
// through the metadata columns beside the html; nothing here depends on where
// a document is displayed, so a Notepad ward and a Notebook can show the SAME
// row. Every save bumps `rev`; a save that names the rev it started from is
// refused (409) when another surface saved in between.

export const NOTE_HTML_MAX = 16 * 1024 * 1024;
export const NOTE_INK_MAX = 2 * 1024 * 1024;
export const NOTE_TITLE_MAX = 120;
export const NOTE_TAG_MAX = 32;
export const NOTE_TAGS_MAX = 20;
export const NOTE_ID_RE = /^[a-z0-9-]{1,32}$/;

/** The document halves — what `/api/note` serves and the legacy tools read. */
export interface NoteDoc {
  html: string;
  /** JSON: Stroke[] (scripts/app/note.ts) — opaque here, only its size and shape are checked. */
  ink: string;
  updated: string | null;
}
/** The document with its identity: the id it is stored under, its title, and
 *  the rev bumped on every save (the client hands it back so a stale save is
 *  refused; 0 = never saved). */
export interface NoteFull extends NoteDoc {
  id: string;
  title: string;
  rev: number;
  /** Content identity also catches equal revision counters from different runtimes. */
  etag: string;
}

const contentTag = (html: string, ink: string) => crypto.createHash('sha256').update(JSON.stringify([html, ink])).digest('hex');

/** A note's metadata — what a list shows; the body is loaded per note. */
export interface NoteMeta {
  id: string;
  title: string;
  /** The first lines of the text when there is no title, for lists. */
  excerpt: string;
  notebook: string | null;
  section: string | null;
  tags: string[];
  pinned: boolean;
  ord: number;
  created: string;
  updated: string;
  archived: string | null;
  trashed: string | null;
  rev: number;
  /** Values of the home notebook's properties, by property id (lib/notebook.ts validates them). */
  props: Record<string, string | number | boolean>;
  /** A template: listed under Templates, offered by New ▾, never in the ordinary lists or search. */
  template: boolean;
  /** A search hit's matching passage, \u0001…\u0002 around the matches. */
  snippet?: string;
}

interface Row {
  ward: string;
  title: string;
  excerpt: string;
  html: string;
  ink: string;
  notebook: string | null;
  section: string | null;
  tags: string;
  pinned: number;
  ord: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  trashed_at: string | null;
  rev: number;
  props: string;
  template: number;
}

export const META_COLS = 'ward, title, excerpt, notebook, section, tags, pinned, ord, created_at, updated_at, archived_at, trashed_at, rev, props, template';

export function rowMeta(r: Omit<Row, 'html' | 'ink'> & { snippet?: string }): NoteMeta {
  const m: NoteMeta = {
    id: r.ward, title: r.title, excerpt: r.excerpt, notebook: r.notebook, section: r.section, tags: parseTags(r.tags),
    pinned: r.pinned === 1, ord: r.ord, created: r.created_at, updated: r.updated_at, archived: r.archived_at, trashed: r.trashed_at, rev: r.rev,
    props: parseProps(r.props), template: r.template === 1,
  };
  if (r.snippet !== undefined) m.snippet = r.snippet;
  return m;
}

function parseProps(json: string): Record<string, string | number | boolean> {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x))) as Record<string, string | number | boolean>;
  } catch {
    return {};
  }
}

function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Tags as stored: trimmed, no control characters, deduped case-insensitively, bounded. Throws 400 on junk. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw Object.assign(new Error('tags must be a list'), { status: 400 });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') throw Object.assign(new Error('bad tag'), { status: 400 });
    const tag = t.replace(/\s+/g, ' ').trim().replace(/^#/, '');
    if (!tag) continue;
    if (tag.length > NOTE_TAG_MAX || /[\x00-\x1f,]/.test(tag)) throw Object.assign(new Error(`a tag is at most ${NOTE_TAG_MAX} characters, no commas`), { status: 400 });
    const k = tag.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
  }
  if (out.length > NOTE_TAGS_MAX) throw Object.assign(new Error(`at most ${NOTE_TAGS_MAX} tags`), { status: 400 });
  return out;
}

/** A title as stored: one line, trimmed, bounded. Throws 400 on junk. */
export function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw Object.assign(new Error('bad title'), { status: 400 });
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length > NOTE_TITLE_MAX) throw Object.assign(new Error(`a title is at most ${NOTE_TITLE_MAX} characters`), { status: 400 });
  return t;
}

/** The note ward itself, or null when `ward` isn't this user's note ward. */
export function noteWard(userId: number, ward: unknown): WardInstance | null {
  if (typeof ward !== 'string') return null;
  return getDashboard(userId).find((w) => w.i === ward && w.type === 'note') ?? null;
}

/** The document a Notepad ward shows: the one its config names, else its own id. */
export const noteIdOf = (w: WardInstance): string => (typeof w.config?.note === 'string' && NOTE_ID_RE.test(w.config.note) ? w.config.note : w.i);

/** What a route's `<id>` names. Legacy (`exact` false): this user's note ward
 *  first (→ the document it shows, its own id or `config.note`), else one of
 *  this user's documents. `exact`: a document id and nothing else — what a
 *  notebook, `note`-addressed tools and `update_note` use, so a Notepad that
 *  was re-pointed at another document (config.note) can never make a request
 *  for document A land on document B. Null when it is neither — the only
 *  answer an unknown or another user's id ever gets. */
export function resolveNote(userId: number, id: unknown, exact = false): { id: string; ward: WardInstance | null } | null {
  if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return null;
  const w = noteWard(userId, id);
  if (w && (!exact || !noteExists(userId, id))) {
    const note = exact ? id : noteIdOf(w);
    if (!noteExists(userId, note) && (note !== w.i || getDb().prepare("SELECT 1 FROM agent_sync_records WHERE user_id = ? AND key = ? AND payload = 'null'").get(userId, `note/${note}`))) return null;
    // A notepad's unsaved own document remains addressable while Configure
    // switches its alias. Exact reads must never follow that alias.
    return { id: note, ward: exact ? { ...w, config: { ...w.config, note } } : w };
  }
  const row = getDb().prepare('SELECT 1 FROM notes WHERE user_id = ? AND ward = ?').get(userId, id);
  return row ? { id, ward: null } : null;
}

export const noteExists = (userId: number, id: string): boolean => !!getDb().prepare('SELECT 1 FROM notes WHERE user_id = ? AND ward = ?').get(userId, id);

const escText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

function readRow(userId: number, id: string): Row | undefined {
  return getDb().prepare(`SELECT html, ink, ${META_COLS} FROM notes WHERE user_id = ? AND ward = ?`).get(userId, id) as Row | undefined;
}

/** The document of a Notepad ward (its config text seeds an unsaved one) or of a document id. */
export function readNote(userId: number, w: WardInstance | string): NoteFull {
  const id = typeof w === 'string' ? w : noteIdOf(w);
  const row = readRow(userId, id);
  if (row) return { id, title: row.title, html: row.html, ink: row.ink, updated: row.updated_at, rev: row.rev, etag: contentTag(row.html, row.ink) };
  // A note written before the document store existed keeps its config text as
  // the first draft; the first save materializes the row.
  const seed = typeof w !== 'string' && typeof w.config?.text === 'string' ? w.config.text : '';
  const html = seed
    .split(/\r?\n/)
    .map((line) => `<p>${escText(line)}</p>`)
    .join('');
  return { id, title: '', html: seed ? html : '', ink: '[]', updated: null, rev: 0, etag: contentTag(seed ? html : '', '[]') };
}

/** The two halves and the save time — the shape the notepad always had. */
export function getNote(userId: number, w: WardInstance | string): NoteDoc {
  const { html, ink, updated } = readNote(userId, w);
  return { html, ink, updated };
}

/** The metadata of one document, or null. */
export function getNoteMeta(userId: number, id: string): NoteMeta | null {
  const row = getDb().prepare(`SELECT ${META_COLS} FROM notes WHERE user_id = ? AND ward = ?`).get(userId, id) as Omit<Row, 'html' | 'ink'> | undefined;
  return row ? rowMeta(row) : null;
}

export interface NotePatch {
  html?: string;
  ink?: string;
  title?: string;
  /** The rev this edit started from; a different stored rev refuses the save (409) unless `force`. */
  rev?: number;
  etag?: string;
  force?: boolean;
  /** Explicitly confirmed page conversion/import; ordinary text writers cannot discard structured state. */
  replacePage?: boolean;
}

/** Store a patch (any half may be absent). Throws with a `status` for the
 *  route — 409 carries the current document as `doc`. Returns updated + rev.
 *  No event: what the notebook's own transactions (createNote) use. */
export function writeNoteRaw(userId: number, w: WardInstance | string, patch: NotePatch): { updated: string; rev: number; etag: string } {
  // One IMMEDIATE transaction: the write lock is taken before the rev is read,
  // so a second handle's save cannot slip between check and write, and the
  // document row never commits without its index row (an index failure rolls
  // the content back and the save reports the failure).
  const out = getDb().transaction(() => writeNoteTx(userId, w, patch)).immediate();
  notifyNoteWritten(userId, typeof w === 'string' ? w : noteIdOf(w), 'write');
  return out;
}

/** Whoever holds a live copy of a document (the collaboration room, lib/note-room.ts)
 *  hears every write the store commits and every purge — after the transaction. */
export type NoteWriteHook = (userId: number, id: string, kind: 'write' | 'gone') => void;
export const noteWriteHooks = new Set<NoteWriteHook>();
export function notifyNoteWritten(userId: number, id: string, kind: 'write' | 'gone'): void {
  for (const fn of noteWriteHooks) {
    try { fn(userId, id, kind); } catch (err) { console.error('[note] hook failed:', err); }
  }
}
function writeNoteTx(userId: number, w: WardInstance | string, patch: NotePatch): { updated: string; rev: number; etag: string } {
  const cur = readNote(userId, w);
  if (!patch.force && ((patch.rev !== undefined && patch.rev !== cur.rev) || (patch.etag !== undefined && patch.etag !== cur.etag))) {
    throw Object.assign(new Error('the note changed elsewhere since you opened it'), { status: 409, doc: cur });
  }
  let html = cur.html;
  let ink = cur.ink;
  let title = cur.title;
  if (patch.html !== undefined) {
    if (patch.html.length > NOTE_HTML_MAX) throw Object.assign(new Error('the document is too large'), { status: 413 });
    html = sanitizeHtml(patch.html);
    if (html.length > NOTE_HTML_MAX) throw Object.assign(new Error('the document is too large'), { status: 413 });
    const page = readPageDocument(html), previousPage = readPageDocument(cur.html);
    // The marker as an ATTRIBUTE (whitespace before it): a link to `…?data-page=2` is prose, not a page.
    const pageMarker = /<[a-z][^>]*\sdata-page(?:-state)?\s*=/i;
    // Page engines own one complete wrapper. Legacy append writers must not save
    // trailing paragraphs that the engine would hide and discard on its next edit.
    if (pageMarker.test(patch.html) && (!page || html.indexOf('</div>') !== html.length - 6 || html.indexOf('<div', 1) !== -1)) {
      throw Object.assign(new Error('Invalid structured page: its state and all content must remain in one complete page document.'), { status: 400 });
    }
    if (pageMarker.test(cur.html) && (!previousPage || previousPage.type !== page?.type) && patch.replacePage !== true) {
      throw Object.assign(new Error('This is a structured notebook page. Use its editor, or explicitly confirm replacing its page type before writing ordinary text.'), { status: 400 });
    }
  }
  if (patch.ink !== undefined) {
    if (patch.ink.length > NOTE_INK_MAX) throw Object.assign(new Error('too much ink — clear some strokes'), { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(patch.ink);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) throw Object.assign(new Error('bad ink'), { status: 400 });
    ink = patch.ink;
  }
  if (patch.title !== undefined) title = normalizeTitle(patch.title);
  const text = plainText(html);
  const row = getDb()
    .prepare(
      `INSERT INTO notes (user_id, ward, html, ink, title, excerpt, created_at, rev) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)
       ON CONFLICT(user_id, ward) DO UPDATE SET html = excluded.html, ink = excluded.ink, title = excluded.title, excerpt = excluded.excerpt,
         updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), rev = notes.rev + 1
       RETURNING updated_at, rev`
    )
    .get(userId, cur.id, html, ink, title, excerpt(text)) as { updated_at: string; rev: number };
  indexNote(userId, cur.id, title, text);
  if (patch.html !== undefined) relinkNote(userId, cur.id, html);
  return { updated: row.updated_at, rev: row.rev, etag: contentTag(html, ink) };
}

/** Store a patch and tell the listeners (a notebook leyline's "Note saved");
 *  the event carries the note's home notebook as it is after the write. */
export function writeNote(userId: number, w: WardInstance | string, patch: NotePatch): { updated: string; rev: number; etag: string } {
  const out = writeNoteRaw(userId, w, patch);
  const meta = getNoteMeta(userId, typeof w === 'string' ? w : noteIdOf(w));
  if (meta && !meta.template && !meta.trashed && (patch.html !== undefined || patch.ink !== undefined)) emitNoteEvent({ type: 'saved', userId, id: meta.id, notebook: meta.notebook, title: meta.title || meta.excerpt.slice(0, 60), tags: meta.tags, section: meta.section });
  else if (meta && patch.title !== undefined) emitNoteEvent({ type:'metadata',userId,id:meta.id,notebook:meta.notebook,title:meta.title,tags:meta.tags,section:meta.section });
  return out;
}

/** Rewrite the outgoing link rows of a document from its (sanitized) HTML. */
export function relinkNote(userId: number, id: string, html: string): void {
  const db = getDb();
  db.prepare('DELETE FROM note_links WHERE user_id = ? AND src = ?').run(userId, id);
  const ins = db.prepare('INSERT OR IGNORE INTO note_links (user_id, src, dst) VALUES (?, ?, ?)');
  for (const dst of noteLinks(html)) if (dst !== id) ins.run(userId, id, dst);
}

/** Notes whose text links to this one — title + home notebook, for the "Linked from" list. Trashed sources are left out. */
export function backlinks(userId: number, id: string): { id: string; title: string; notebook: string | null }[] {
  return (getDb()
    .prepare(
      `SELECT n.ward AS id, n.title, n.excerpt, n.notebook FROM note_links l JOIN notes n ON n.user_id = l.user_id AND n.ward = l.src
       WHERE l.user_id = ? AND l.dst = ? AND n.trashed_at IS NULL ORDER BY n.updated_at DESC LIMIT 100`
    )
    .all(userId, id) as { id: string; title: string; excerpt: string; notebook: string | null }[]).map((r) => ({ id: r.id, title: r.title || r.excerpt.slice(0, 60) || 'Untitled', notebook: r.notebook }));
}

/** Delete a document for good: the row, its index row and its link rows.
 *  Only a trashed note may go (the UI's "Delete forever"); links INTO it from
 *  other notes are left as dangling <a data-note> text in their documents. */
export function purgeNote(userId: number, id: string): void {
  knowledgeChanged(userId);
  const db = getDb();
  const row = db.prepare('SELECT trashed_at FROM notes WHERE user_id = ? AND ward = ?').get(userId, id) as { trashed_at: string | null } | undefined;
  if (!row) throw Object.assign(new Error('no such note'), { status: 404 });
  if (!row.trashed_at) throw Object.assign(new Error('only a note in the trash can be deleted for good'), { status: 409 });
  db.transaction(() => {
    db.prepare('DELETE FROM notes WHERE user_id = ? AND ward = ?').run(userId, id);
    db.prepare('DELETE FROM notes_fts WHERE user_id = ? AND id = ?').run(userId, id);
    db.prepare('DELETE FROM note_links WHERE user_id = ? AND (src = ? OR dst = ?)').run(userId, id, id);
    // Record the deletion now, even before the next sync, so a remaining Notepad tile cannot recreate it.
    db.prepare("INSERT INTO agent_sync_records(user_id,key,hash,payload) VALUES(?,?,?,'null') ON CONFLICT(user_id,key) DO UPDATE SET hash=excluded.hash,payload=excluded.payload")
      .run(userId, `note/${id}`, crypto.createHash('sha256').update('null').digest('hex'));
  })();
  notifyNoteWritten(userId, id, 'gone');
}

/** Store a patch; the saved `updated_at`. */
export function saveNote(userId: number, w: WardInstance | string, patch: NotePatch): string {
  return writeNote(userId, w, patch).updated;
}

/** Rewrite a document's full-text row: title, its text (transcribed
 *  handwriting included — it IS text by then; ink never is) and its tags.
 *  ponytail: the delete scans the unindexed id column — fine for a personal
 *  notebook; map notes to an INTEGER key if it ever shows up in a profile. */
export function indexNote(userId: number, id: string, title: string, text: string, tags?: string[]): void {
  knowledgeChanged(userId);
  const db = getDb();
  const tagList = tags ?? parseTags((db.prepare('SELECT tags FROM notes WHERE user_id = ? AND ward = ?').get(userId, id) as { tags: string } | undefined)?.tags ?? '[]');
  db.prepare('DELETE FROM notes_fts WHERE user_id = ? AND id = ?').run(userId, id);
  db.prepare('INSERT INTO notes_fts (user_id, id, title, body, tags) VALUES (?, ?, ?, ?, ?)').run(userId, id, title, text, tagList.join(' '));
}

/** A fresh document id (NOTE_ID_RE) that no row or ward of this user's holds. */
export function newNoteId(userId: number): string {
  const wards = new Set(getDashboard(userId).map((w) => w.i));
  for (;;) {
    const id = 'nt' + crypto.randomBytes(6).toString('hex');
    if (!wards.has(id) && !noteExists(userId, id)) return id;
  }
}

/** A user's FTS5 query from what they typed: every word a quoted prefix
 *  phrase (so operators, quotes and columns in the input are plain text),
 *  ANDed — or ORed (`any`), what a question retrieves its notes with. Null
 *  when nothing searchable was typed. */
export function ftsQuery(q: string, any = false): string | null {
  const toks = q.slice(0, 200).replace(/["*]/g, ' ').split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).slice(0, 12);
  return toks.length ? toks.map((t) => `"${t}"*`).join(any ? ' OR ' : ' ') : null;
}
