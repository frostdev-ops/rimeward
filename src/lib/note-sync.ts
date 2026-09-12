import { getDb } from './db.ts';
import { NOTE_HTML_MAX, NOTE_ID_RE, NOTE_INK_MAX, indexNote, newNoteId, normalizeTags, normalizeTitle, notifyNoteWritten, relinkNote, sanitizeHtml } from './note.ts';
import { excerpt, plainText } from './note-text.ts';
import { normalizeProps, normalizeSections, normalizeViews } from './notebook.ts';

// Notes and notebooks as Rime sync records (agent/sync-store.ts): one record
// per document (`note/<id>`) and per notebook (`notebook/<id>`), the whole row
// as the payload, `null` once it is gone. Every paired runtime keeps a full
// copy, so a desktop works offline and the server stays the shared copy.
// Conflicts (both sides changed the same document since the last exchange)
// are settled by the newer `updated` stamp; the loser becomes a "conflict
// copy" note beside the winner in the same notebook — nothing is lost, and
// nothing here ever fires a notebook leyline (replication is not an event).

export interface NoteRecord {
  id: string;
  title: string;
  html: string;
  ink: string;
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
  props: Record<string, string | number | boolean>;
  template: boolean;
}
export interface NotebookRecord {
  id: string;
  title: string;
  sections: unknown[];
  views: unknown[];
  props: unknown[];
  created: string;
  updated: string;
}

export const NOTE_KEY = /^note\/([a-z0-9-]{1,32})$/;
export const NOTEBOOK_KEY = /^notebook\/([a-z0-9-]{1,32})$/;
const SUB_ID_RE = /^[a-z0-9]{1,16}$/;
const STAMP = (v: unknown) => typeof v === 'string' && v.length <= 40;
const failure = (text: string) => Object.assign(new Error(text), { status: 400 });

const ROW_COLS = 'ward, title, html, ink, notebook, section, tags, pinned, ord, created_at, updated_at, archived_at, trashed_at, rev, props, template';
interface Row {
  ward: string; title: string; html: string; ink: string; notebook: string | null; section: string | null; tags: string; pinned: number; ord: number;
  created_at: string; updated_at: string; archived_at: string | null; trashed_at: string | null; rev: number; props: string; template: number;
}
const parse = <T,>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};
const toRecord = (r: Row): NoteRecord => ({
  id: r.ward, title: r.title, html: r.html, ink: r.ink, notebook: r.notebook, section: r.section, tags: parse<string[]>(r.tags, []), pinned: r.pinned === 1, ord: r.ord,
  created: r.created_at, updated: r.updated_at, archived: r.archived_at, trashed: r.trashed_at, rev: r.rev, props: parse(r.props, {}), template: r.template === 1,
});

/** The record of one document, or null when there is no such row. */
export function noteRecord(user: number, id: string): NoteRecord | null {
  const r = getDb().prepare(`SELECT ${ROW_COLS} FROM notes WHERE user_id = ? AND ward = ?`).get(user, id) as Row | undefined;
  return r ? toRecord(r) : null;
}
export function notebookRecord(user: number, id: string): NotebookRecord | null {
  const r = getDb().prepare('SELECT id, title, sections, views, props, created_at, updated_at FROM notebooks WHERE user_id = ? AND id = ?').get(user, id) as
    | { id: string; title: string; sections: string; views: string; props: string; created_at: string; updated_at: string }
    | undefined;
  return r ? { id: r.id, title: r.title, sections: parse(r.sections, []), views: parse(r.views, []), props: parse(r.props, []), created: r.created_at, updated: r.updated_at } : null;
}

/** Validate a payload (already JSON-parsed) — the trust boundary for what another runtime sends. */
export function validateNoteRecord(value: unknown): NoteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid note record.');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !NOTE_ID_RE.test(v.id)) throw failure('Invalid note id.');
  if (typeof v.html !== 'string' || v.html.length > NOTE_HTML_MAX) throw failure('Invalid note text.');
  if (typeof v.ink !== 'string' || v.ink.length > NOTE_INK_MAX || !Array.isArray(parse<unknown>(v.ink, null))) throw failure('Invalid note ink.');
  if (v.notebook !== null && (typeof v.notebook !== 'string' || !NOTE_ID_RE.test(v.notebook))) throw failure('Invalid note notebook.');
  if (v.section !== null && (typeof v.section !== 'string' || !SUB_ID_RE.test(v.section))) throw failure('Invalid note section.');
  if (!STAMP(v.created) || !STAMP(v.updated) || (v.archived !== null && !STAMP(v.archived)) || (v.trashed !== null && !STAMP(v.trashed))) throw failure('Invalid note stamps.');
  if (typeof v.rev !== 'number' || !Number.isInteger(v.rev) || v.rev < 0 || typeof v.ord !== 'number' || !Number.isInteger(v.ord)) throw failure('Invalid note revision.');
  if (!v.props || typeof v.props !== 'object' || Array.isArray(v.props) || JSON.stringify(v.props).length > 20_000) throw failure('Invalid note properties.');
  let title: string;
  let tags: string[];
  try {
    title = normalizeTitle(v.title);
    tags = normalizeTags(v.tags);
  } catch (e) {
    throw failure(`Invalid note: ${(e as Error).message}`);
  }
  const props = Object.fromEntries(Object.entries(v.props as Record<string, unknown>).filter(([k, x]) => SUB_ID_RE.test(k) && ['string', 'number', 'boolean'].includes(typeof x))) as NoteRecord['props'];
  return {
    id: v.id, title, html: sanitizeHtml(v.html), ink: v.ink, notebook: v.notebook as string | null, section: v.section as string | null, tags, pinned: v.pinned === true, ord: v.ord,
    created: v.created as string, updated: v.updated as string, archived: v.archived as string | null, trashed: v.trashed as string | null, rev: v.rev, props, template: v.template === true,
  };
}
export function validateNotebookRecord(value: unknown): NotebookRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid notebook record.');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !NOTE_ID_RE.test(v.id) || typeof v.title !== 'string' || v.title.length > 60 || !STAMP(v.created) || !STAMP(v.updated)) throw failure('Invalid notebook.');
  try {
    const sections = normalizeSections(v.sections ?? []);
    const props = normalizeProps(v.props ?? []);
    const views = normalizeViews(v.views ?? [], sections, props);
    return { id: v.id, title: v.title, sections, views, props, created: v.created as string, updated: v.updated as string };
  } catch (e) {
    throw failure(`Invalid notebook: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ capture

/** What changes when a note changes — everything but the bodies, whose size
 *  stands in for them (a content edit bumps `rev` anyway). Hashing every
 *  body every 15 s is what this avoids. */
const fingerprints = new Map<string, string>();
export function noteFingerprints(user: number): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT ward, rev, title, notebook, section, tags, pinned, ord, archived_at, trashed_at, props, template, updated_at, length(html) AS h, length(ink) AS k FROM notes WHERE user_id = ?')
    .all(user) as Record<string, unknown>[];
  return new Map(rows.map((r) => [r.ward as string, JSON.stringify(r)]));
}
/** The ids whose record must be (re)written now: changed rows plus rows whose record is missing; `gone` = records whose row vanished. */
export function changedNotes(user: number, recorded: (key: string) => boolean): { ids: string[]; gone: string[]; books: string[] } {
  const fps = noteFingerprints(user);
  const ids: string[] = [];
  for (const [id, fp] of fps) {
    const k = `${user}:${id}`;
    if (fingerprints.get(k) !== fp || !recorded(`note/${id}`)) {
      ids.push(id);
      fingerprints.set(k, fp);
    }
  }
  for (const k of [...fingerprints.keys()]) if (k.startsWith(`${user}:`) && !fps.has(k.slice(String(user).length + 1))) fingerprints.delete(k);
  const gone = (getDb()
    .prepare(`SELECT key FROM agent_sync_records r WHERE user_id = ? AND key LIKE 'note/%' AND payload != 'null' AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.user_id = r.user_id AND n.ward = substr(r.key, 6))`)
    .all(user) as { key: string }[]).map((r) => r.key);
  const books = (getDb().prepare('SELECT id FROM notebooks WHERE user_id = ?').all(user) as { id: string }[]).map((r) => r.id);
  return { ids, gone, books };
}

// ------------------------------------------------------------------ install

/** Write a received note record over the local row (or delete it) — straight
 *  SQL, no events, the index and the link rows kept in step. */
export function installNote(user: number, id: string, rec: NoteRecord | null): void {
  const db = getDb();
  db.transaction(() => {
    if (!rec) {
      db.prepare('DELETE FROM notes WHERE user_id = ? AND ward = ?').run(user, id);
      db.prepare('DELETE FROM notes_fts WHERE user_id = ? AND id = ?').run(user, id);
      db.prepare('DELETE FROM note_links WHERE user_id = ? AND (src = ? OR dst = ?)').run(user, id, id);
      return;
    }
    if (rec.id !== id) throw failure('Note record id mismatch.');
    const text = plainText(rec.html);
    db.prepare(
      `INSERT INTO notes (user_id, ward, html, ink, title, excerpt, notebook, section, tags, pinned, ord, created_at, updated_at, archived_at, trashed_at, rev, props, template)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, ward) DO UPDATE SET html = excluded.html, ink = excluded.ink, title = excluded.title, excerpt = excluded.excerpt, notebook = excluded.notebook,
         section = excluded.section, tags = excluded.tags, pinned = excluded.pinned, ord = excluded.ord, created_at = excluded.created_at, updated_at = excluded.updated_at,
         archived_at = excluded.archived_at, trashed_at = excluded.trashed_at, rev = excluded.rev, props = excluded.props, template = excluded.template`
    ).run(user, id, rec.html, rec.ink, rec.title, excerpt(text), rec.notebook, rec.section, JSON.stringify(rec.tags), rec.pinned ? 1 : 0, rec.ord, rec.created, rec.updated, rec.archived, rec.trashed, rec.rev, JSON.stringify(rec.props), rec.template ? 1 : 0);
    indexNote(user, id, rec.title, text, rec.tags);
    relinkNote(user, id, rec.html);
  })();
  notifyNoteWritten(user, id, rec ? 'write' : 'gone');
}
export function installNotebook(user: number, id: string, rec: NotebookRecord | null): void {
  const db = getDb();
  if (!rec) {
    db.prepare('DELETE FROM notebooks WHERE user_id = ? AND id = ?').run(user, id);
    return;
  }
  if (rec.id !== id) throw failure('Notebook record id mismatch.');
  db.prepare(
    `INSERT INTO notebooks (user_id, id, title, sections, views, props, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, sections = excluded.sections, views = excluded.views, props = excluded.props, created_at = excluded.created_at, updated_at = excluded.updated_at`
  ).run(user, id, rec.title, JSON.stringify(rec.sections), JSON.stringify(rec.views), JSON.stringify(rec.props), rec.created, rec.updated);
}

// ---------------------------------------------------------------- conflicts

/** Both runtimes changed the same document since they last agreed. The newer
 *  `updated` stamp wins (a tie goes to the server); the loser is kept as a
 *  new note, "<title> (conflict copy from <where>)", in the same notebook and
 *  section, unarchived and untrashed so it is seen. Returns true when the
 *  LOCAL version won — the caller then keeps its row and pushes it. */
export function resolveNoteConflict(user: number, local: NoteRecord | null, remote: NoteRecord | null, remoteName = 'the server'): boolean {
  if (!local || !remote) return !local && !!remote; // an existing deletion record wins on either side
  const localWins = local.updated > remote.updated;
  const loser = localWins ? remote : local;
  const where = localWins ? remoteName : 'this device';
  const id = newNoteId(user);
  const suffix = ` (conflict copy from ${where})`;
  const title = `${(loser.title || plainText(loser.html).slice(0, 40) || 'Untitled').slice(0, 120 - suffix.length)}${suffix}`;
  installNote(user, id, { ...loser, id, title, archived: null, trashed: null, template: false, rev: 1, created: loser.updated, updated: loser.updated, ord: loser.ord + 1 });
  return localWins;
}
