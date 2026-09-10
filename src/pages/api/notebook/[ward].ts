import type { APIRoute } from 'astro';
import { broadcast } from '../../../lib/logic-engine.ts';
import { getNoteMeta } from '../../../lib/note.ts';
import {
  LIST_MAX, SORTS, STATUSES, askNotebook, createNote, emptyTrash, ensureNotebook, linkNote, linkableNoteWards, listNotes, noteBacklinks, notebookIdOf, notebookIndex,
  notebookWard, purgeNote, reorderNotes, tagCounts, unlinkNote, updateNoteMeta, updateNotebook, type ListQuery, type Sort, type Status,
} from '../../../lib/notebook.ts';
import { isNotebookPageType, pageDocument } from '../../../lib/notebook-pages.ts';
import { wardTitle } from '../../../lib/wards.ts';

export const prerender = false;

// A Notebook ward's notebook. GET = the notebook (sections, views, tags, what
// can be linked) and one page of note METADATA — filtered, searched, sorted,
// bounded; bodies load per note from /api/note/<id>?ward=<this ward>.
// POST = one operation on it (`op`). `<ward>` must be one of this user's
// notebook wards: the layout is the registry. Replicated documents are served
// from this runtime, including when a paired runtime is offline.

const MAX_BODY = 24 * 1024 * 1024; // imported documents plus JSON framing; note.ts enforces content limits

function query(p: URLSearchParams, notebook: string): ListQuery {
  const q: ListQuery = { notebook };
  const section = p.get('section');
  if (section === 'none') q.section = null;
  else if (section) q.section = section.slice(0, 16);
  const tag = p.get('tag');
  if (tag) q.tag = tag.slice(0, 32);
  const status = p.get('status');
  if ((STATUSES as readonly string[]).includes(status ?? '')) q.status = status as Status;
  if (p.get('pinned') === '1') q.pinned = true;
  if (p.get('template') === '1') q.template = true;
  // Property filters ride as prop.<id>=<value>.
  for (const [k, v] of p) if (k.startsWith('prop.') && v) (q.props ??= {})[k.slice(5).slice(0, 16)] = v.slice(0, 100);
  const text = p.get('q')?.trim();
  if (text) q.q = text.slice(0, 200);
  const sort = p.get('sort');
  if ((SORTS as readonly string[]).includes(sort ?? '')) q.sort = sort as Sort;
  if (p.get('dir') === 'asc' || p.get('dir') === 'desc') q.dir = p.get('dir') as 'asc' | 'desc';
  q.limit = Math.min(Math.max(Number(p.get('limit')) || 50, 1), LIST_MAX);
  q.offset = Math.max(Number(p.get('offset')) || 0, 0);
  return q;
}

const fail = (err: unknown, fallback: string) => {
  const status = (err as { status?: number }).status ?? (fallback.startsWith('the model') ? 502 : 500);
  if (status === 500) console.error('[notebook]', err);
  const out: Record<string, unknown> = { error: err instanceof Error ? err.message : fallback };
  const other = (err as { notebook?: string }).notebook;
  if (other) out.notebook = other;
  return Response.json(out, { status });
};

export const GET: APIRoute = ({ params, url, locals }) => {
  const userId = locals.user!.userId;
  const w = notebookWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not a notebook ward' }, { status: 404 });
  const id = notebookIdOf(w);
  try {
    const notebook = ensureNotebook(userId, id, wardTitle(w));
    const part = url.searchParams.get('part');
    if (part === 'index') return Response.json({ index: notebookIndex(userId, id) }, { headers: { 'cache-control': 'no-store' } });
    if (part === 'meta') {
      // One note's metadata, any status — only when it is in THIS notebook.
      const note = url.searchParams.get('note');
      const meta = note ? getNoteMeta(userId, note) : null;
      if (!meta || meta.notebook !== id) return Response.json({ error: 'no such note in this notebook' }, { status: 404 });
      return Response.json({ note: meta }, { headers: { 'cache-control': 'no-store' } });
    }
    if (part === 'backlinks') {
      // Notes whose text links to this one — any notebook of the user's, so a link from elsewhere shows too.
      const note = url.searchParams.get('note');
      const meta = note ? getNoteMeta(userId, note) : null;
      if (!meta || meta.notebook !== id) return Response.json({ error: 'no such note in this notebook' }, { status: 404 });
      return Response.json({ backlinks: noteBacklinks(userId, meta.id) }, { headers: { 'cache-control': 'no-store' } });
    }
    const page = listNotes(userId, query(url.searchParams, id));
    if (part === 'list') return Response.json(page, { headers: { 'cache-control': 'no-store' } });
    return Response.json({ notebook, tags: tagCounts(userId, id), linkable: linkableNoteWards(userId), ...page }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return fail(err, 'could not read the notebook');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = notebookWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not a notebook ward' }, { status: 404 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return Response.json({ error: 'too large' }, { status: 413 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.op !== 'string') return Response.json({ error: 'bad body' }, { status: 400 });
  const id = notebookIdOf(w);
  ensureNotebook(userId, id, wardTitle(w));
  /** A note id that is in THIS notebook — every per-note op but link goes through here. */
  const mine = (raw: unknown): string => {
    const meta = typeof raw === 'string' ? getNoteMeta(userId, raw) : null;
    if (!meta || meta.notebook !== id) throw Object.assign(new Error('no such note in this notebook'), { status: 404 });
    return meta.id;
  };
  const changed = () => broadcast(userId, 'notebook', { notebook: id });
  try {
    switch (body.op) {
      case 'create': {
        const section = typeof body.section === 'string' && body.section ? body.section : undefined;
        const from = typeof body.from === 'string' && body.from ? mine(body.from) : undefined;
        if (body.kind !== undefined && !isNotebookPageType(body.kind)) return Response.json({ error: 'unknown page type' }, { status: 400 });
        if (body.html !== undefined && typeof body.html !== 'string') return Response.json({ error: 'invalid document content' }, { status: 400 });
        const html = typeof body.html === 'string' ? body.html : !from && isNotebookPageType(body.kind) ? pageDocument(body.kind, null) : undefined;
        const meta = createNote(userId, { notebook: id, section, html, title: body.title ?? (isNotebookPageType(body.kind) ? body.kind === 'notion' ? 'Linked Notion database' : `Untitled ${body.kind}` : undefined), tags: body.tags, props: body.props, from, template: body.template === true });
        changed();
        return Response.json({ note: meta });
      }
      case 'update': {
        const meta = updateNoteMeta(userId, mine(body.id), body);
        changed();
        broadcast(userId, 'note', { note: meta.id, meta: true });
        return Response.json({ note: meta });
      }
      case 'link': {
        if (typeof body.id !== 'string') return Response.json({ error: 'bad id' }, { status: 400 });
        const meta = linkNote(userId, id, body.id, { section: typeof body.section === 'string' ? body.section : undefined, move: body.move === true });
        changed();
        return Response.json({ note: meta });
      }
      case 'unlink': {
        const meta = unlinkNote(userId, mine(body.id));
        changed();
        return Response.json({ note: meta });
      }
      case 'reorder':
        reorderNotes(userId, id, body.ids);
        changed();
        return Response.json({ ok: true });
      case 'purge': {
        // Delete forever — only a note already in this notebook's trash (lib/note.ts refuses the rest).
        const nid = mine(body.id);
        purgeNote(userId, nid);
        changed();
        broadcast(userId, 'note', { note: nid, gone: true });
        return Response.json({ ok: true });
      }
      case 'empty-trash': {
        const n = emptyTrash(userId, id);
        changed();
        return Response.json({ ok: true, purged: n });
      }
      case 'ask': {
        const out = await askNotebook(userId, w, typeof body.q === 'string' ? body.q : '', body.scope === 'all' || body.scope === 'matches' ? body.scope : 'auto');
        return Response.json(out);
      }
      case 'notebook': {
        const notebook = updateNotebook(userId, id, body);
        changed();
        return Response.json({ notebook });
      }
      default:
        return Response.json({ error: 'unknown op' }, { status: 400 });
    }
  } catch (err) {
    return fail(err, body.op === 'ask' ? 'the model call failed' : 'the change failed');
  }
};
