// Notion client. One `api()` over the REST surface, everything above it typed
// and cached. Property and block shapes live in the two pure codecs
// (notion-props.ts / notion-blocks.ts) — nothing in this file branches on a
// property or block type, and nothing above this file talks HTTP.
//
// API version 2026-03-11: a DATABASE holds one or more DATA SOURCES, and rows
// are queried from a data source, not the database. Everything the app stored
// before this upgrade (tasks_db_id, a ward's config.db) is a database id, so
// `notionSourceId` resolves either kind of id to the data source to query.

import { liveToken, getLink, getMeta, patchMeta } from './linked-accounts.ts';
import { getDashboard } from './dashboard.ts';
import { cached, invalidate } from './cache.ts';
import { CHECKLIST_PAGE_SIZE } from './logic.ts';
import { TASK_WARDS } from './wards.ts';
import { plainText, readProps, toRichText, writeProps, type PropValue, type RichTextItem } from './notion-props.ts';
import { readBlock, updateBlockBody, writeBlock, type BlockDraft, type NBlock } from './notion-blocks.ts';
import { buildFilter } from './notion-filter.ts';
import type { CalEvent } from './google.ts';
import { isDeepStrictEqual } from 'node:util';

export { CHECKLIST_PAGE_SIZE, TASK_WARDS };
export type { PropValue, NBlock, BlockDraft };

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';

/** Notion's own error body is far more useful than the status alone. */
async function api<T>(token: string, path: string, init?: RequestInit, retry = 0): Promise<T> {
  const res = await fetch(`${NOTION}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': VERSION,
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  // A 429 explicitly refused the request. Never replay uncertain writes on a
  // timeout or 5xx (a create may already have succeeded).
  if (res.status === 429 && retry < 2) {
    const delay = Number(res.headers.get('retry-after') ?? 1);
    if (Number.isFinite(delay) && delay >= 0 && delay <= 15) {
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay) * 1000));
      return api(token, path, init, retry + 1);
    }
  }
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { code?: string; message?: string };
      if (j.message) msg = `${j.code ?? res.status}: ${j.message}`.slice(0, 300);
    } catch {
      /* not JSON — the raw slice is the best we have */
    }
    const err = new Error(`notion ${res.status} ${msg}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Paged<T> {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Walk a paginated endpoint. Hard-capped: an unbounded loop against someone
 *  else's API is how you get rate-limited into a corner. */
async function paged<T>(
  token: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; max?: number; pageSize?: number } = {}
): Promise<T[]> {
  const { method = 'GET', body, max = 200, pageSize = 100 } = opts;
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10 && out.length < max; i++) {
    let data: Paged<T>;
    if (method === 'POST') {
      data = await api<Paged<T>>(token, path, {
        method,
        ...json({ ...body, page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
    } else {
      const sep = path.includes('?') ? '&' : '?';
      const qs = `${sep}page_size=${pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      data = await api<Paged<T>>(token, `${path}${qs}`);
    }
    out.push(...data.results);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out.slice(0, max);
}

// ------------------------------------------------------------------ objects

interface NotionObject {
  id: string;
  object: 'page' | 'database' | 'data_source';
  url?: string;
  icon?: { type: string; emoji?: string; external?: { url?: string }; file?: { url?: string } };
  cover?: { external?: { url?: string }; file?: { url?: string } } | null;
  parent?: { type?: string; page_id?: string; database_id?: string; data_source_id?: string; workspace?: boolean };
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  title?: RichTextItem[]; // databases and data sources
  properties?: Record<string, { type: string; title?: RichTextItem[] }>; // pages
  data_sources?: { id: string; name: string }[]; // databases, 2025-09-03+
}

export function objectTitle(obj: NotionObject): string {
  if (obj.title) return plainText(obj.title);
  for (const prop of Object.values(obj.properties ?? {})) {
    if (prop.type === 'title') return plainText(prop.title);
  }
  return '';
}

function icon(obj: NotionObject): string {
  return obj.icon?.type === 'emoji' ? (obj.icon.emoji ?? '') : '';
}

export interface NotionHit {
  id: string;
  title: string;
  icon: string;
  url: string;
  object: string;
  lastEdited: string;
  created: string;
  /** databases only: the lists inside them. */
  sources?: { id: string; name: string }[];
}

function toHit(o: NotionObject): NotionHit {
  return {
    id: o.id,
    title: objectTitle(o),
    icon: icon(o),
    url: o.url ?? '',
    object: o.object,
    lastEdited: o.last_edited_time ?? '',
    created: o.created_time ?? '',
    ...(o.data_sources ? { sources: o.data_sources } : {}),
  };
}

// ------------------------------------------------------------------- search

export type SearchKind = 'page' | 'data_source';

export async function notionSearch(userId: number, query: string, kind?: SearchKind, limit = 10): Promise<NotionHit[]> {
  const token = await liveToken(userId, 'notion');
  const data = await api<Paged<NotionObject>>(token, '/search', {
    method: 'POST',
    ...json({
      query,
      page_size: Math.min(Math.max(limit, 1), 100),
      ...(kind ? { filter: { value: kind, property: 'object' } } : {}),
    }),
  });
  return data.results.map(toHit);
}

export function notionRecent(userId: number): Promise<NotionHit[]> {
  return cached(`notion:recent:${userId}`, 5 * 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const data = await api<Paged<NotionObject>>(token, '/search', {
      method: 'POST',
      ...json({
        page_size: 10,
        filter: { value: 'page', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      }),
    });
    return data.results.map(toHit);
  });
}

/** Every list the integration can see. Since 2026-03-11 /search only knows
 *  `page` and `data_source`, so these ids are DATA SOURCE ids — which is what
 *  every reader wants anyway (notionSourceId passes them straight through). */
export function notionDatabases(userId: number): Promise<NotionHit[]> {
  return cached(`notion:dbs:${userId}`, 5 * 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const rows = await paged<NotionObject>(token, '/search', {
      method: 'POST',
      body: { filter: { value: 'data_source', property: 'object' } },
      max: 100,
      pageSize: 50,
    });
    return rows.map(toHit);
  });
}

// ------------------------------------------------- databases & data sources

/** A database's lists. Cached: the mapping changes about never. */
export function notionDataSources(userId: number, dbId: string): Promise<{ id: string; name: string }[]> {
  return cached(`notion:ds:${userId}:${dbId}`, 10 * 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const db = await api<NotionObject>(token, `/databases/${dbId}`);
    return db.data_sources ?? [];
  });
}

/** Resolve a STORED id to the data source to query. `id` may be a database id
 *  (everything saved before the 2026-03-11 upgrade is one) or already a data
 *  source id; `preferred` picks one list inside a multi-list database. */
export async function notionSourceId(userId: number, id: string, preferred?: string): Promise<string> {
  if (preferred) return preferred;
  try {
    const sources = await notionDataSources(userId, id);
    if (sources.length) return sources[0]!.id;
  } catch (err) {
    // 404 here means `id` was never a database — it already IS a data source.
    if ((err as { status?: number }).status !== 404) throw err;
  }
  return id;
}

export interface SourceProp {
  name: string;
  type: string;
  /** select/status/multi_select option names, for an editor's dropdown. */
  options?: { name: string; color?: string }[];
  /** status only: which options count as finished. */
  doneOptions?: string[];
}

export interface SourceSchema {
  id: string;
  title: string;
  props: SourceProp[];
  /** The raw {name: {type}} map the property codec writes against. */
  types: Record<string, { type: string }>;
}

interface SelectOption {
  id: string;
  name: string;
  color?: string;
}
interface DbProp {
  type: string;
  select?: { options?: SelectOption[] };
  multi_select?: { options?: SelectOption[] };
  status?: { options?: SelectOption[]; groups?: { name: string; option_ids: string[] }[] };
}

export function notionSourceSchema(userId: number, sourceId: string): Promise<SourceSchema> {
  return cached(`notion:schema:${userId}:${sourceId}`, 5 * 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const ds = await api<NotionObject & { properties: Record<string, DbProp> }>(token, `/data_sources/${sourceId}`);
    const props: SourceProp[] = [];
    const types: Record<string, { type: string }> = {};
    for (const [name, p] of Object.entries(ds.properties ?? {})) {
      types[name] = { type: p.type };
      const opts = p.select?.options ?? p.multi_select?.options ?? p.status?.options;
      const row: SourceProp = { name, type: p.type };
      if (opts?.length) row.options = opts.map((o) => ({ name: o.name, ...(o.color ? { color: o.color } : {}) }));
      if (p.status?.groups) {
        const byId = new Map((p.status.options ?? []).map((o) => [o.id, o.name]));
        const done = p.status.groups.find((g) => /complete|done/i.test(g.name));
        if (done) row.doneOptions = done.option_ids.map((id) => byId.get(id)!).filter(Boolean);
      }
      props.push(row);
    }
    return { id: sourceId, title: objectTitle(ds), props, types };
  });
}

/** Create a database (with its first data source) under a parent page. */
export async function notionCreateDatabase(
  userId: number,
  parentPageId: string,
  title: string,
  properties: Record<string, unknown> = { Name: { title: {} } }
): Promise<NotionHit> {
  const token = await liveToken(userId, 'notion');
  const db = await api<NotionObject>(token, '/databases', {
    method: 'POST',
    ...json({
      parent: { type: 'page_id', page_id: parentPageId },
      title: toRichText(title, 200),
      initial_data_source: { properties },
    }),
  });
  invalidate(`notion:dbs:${userId}`);
  return toHit(db);
}

/** Rename a database, or move it to (or out of) trash. Trashing a database
 *  takes its lists and rows with it — recoverable in Notion. */
export async function notionUpdateDatabase(userId: number, dbId: string, patch: { title?: string; inTrash?: boolean }): Promise<void> {
  const token = await liveToken(userId, 'notion');
  await api(token, `/databases/${dbId}`, {
    method: 'PATCH',
    ...json({
      ...(patch.title !== undefined ? { title: toRichText(patch.title, 200) } : {}),
      ...(patch.inTrash !== undefined ? { in_trash: patch.inTrash } : {}),
    }),
  });
  invalidate(`notion:dbs:${userId}`);
  invalidate(`notion:ds:${userId}:${dbId}`);
}

/** Add a second (third, …) list to an existing database. */
export async function notionCreateSource(
  userId: number,
  dbId: string,
  title: string,
  properties: Record<string, unknown> = { Name: { title: {} } }
): Promise<{ id: string }> {
  const token = await liveToken(userId, 'notion');
  const ds = await api<{ id: string }>(token, '/data_sources', {
    method: 'POST',
    ...json({ parent: { type: 'database_id', database_id: dbId }, title: toRichText(title, 200), properties }),
  });
  invalidate(`notion:ds:${userId}:${dbId}`);
  invalidate(`notion:dbs:${userId}`);
  return ds;
}

/** Rename a list, or change its columns. `properties` uses Notion's schema
 *  shape ({"Priority": {"select": {…}}}, or null for a column to delete). */
export async function notionUpdateSource(
  userId: number,
  sourceId: string,
  patch: { title?: string; properties?: Record<string, unknown>; inTrash?: boolean }
): Promise<void> {
  const token = await liveToken(userId, 'notion');
  await api(token, `/data_sources/${sourceId}`, {
    method: 'PATCH',
    ...json({
      ...(patch.title !== undefined ? { title: toRichText(patch.title, 200) } : {}),
      ...(patch.properties ? { properties: patch.properties } : {}),
      ...(patch.inTrash !== undefined ? { in_trash: patch.inTrash } : {}),
    }),
  });
  invalidate(`notion:schema:${userId}:${sourceId}`);
  invalidate(`notion:rows:${userId}:${sourceId}`);
  invalidate(`notion:cal:${userId}:${sourceId}`);
  patchMeta(userId, 'notion', { task_props: undefined }); // columns moved — re-detect
}

export interface QueryOpts {
  filter?: Record<string, unknown>;
  sorts?: { property?: string; timestamp?: string; direction: 'ascending' | 'descending' }[];
  max?: number;
}

export interface Row {
  id: string;
  url: string;
  icon: string;
  created: string;
  edited: string;
  archived: boolean;
  props: Record<string, PropValue>;
}

interface RawPage extends NotionObject {
  properties: Record<string, never>;
}

const toRow = (p: RawPage): Row => ({
  id: p.id,
  url: p.url ?? '',
  icon: icon(p),
  created: p.created_time ?? '',
  edited: p.last_edited_time ?? '',
  archived: !!(p.archived || p.in_trash),
  props: readProps(p.properties),
});

/** Query a data source. Uncached on purpose — callers that want sharing use
 *  notionRows; an ad-hoc filter must never poison that shared entry. */
export async function notionQuery(userId: number, sourceId: string, opts: QueryOpts = {}): Promise<Row[]> {
  const token = await liveToken(userId, 'notion');
  const rows = await paged<RawPage>(token, `/data_sources/${sourceId}/query`, {
    method: 'POST',
    body: { ...(opts.filter ? { filter: opts.filter } : {}), ...(opts.sorts?.length ? { sorts: opts.sorts } : {}) },
    max: opts.max ?? CHECKLIST_PAGE_SIZE,
    pageSize: Math.min(opts.max ?? CHECKLIST_PAGE_SIZE, 100),
  });
  return rows.map(toRow);
}

/** The shared, cached read of a whole list — what every ward and watcher on a
 *  data source rides. Deliberately unfiltered; see CLAUDE.md. */
export function notionRows(userId: number, sourceId: string, sortProp?: string): Promise<Row[]> {
  return cached(`notion:rows:${userId}:${sourceId}`, 60_000, () =>
    notionQuery(userId, sourceId, { sorts: sortProp ? [{ property: sortProp, direction: 'ascending' }] : undefined })
  );
}

// -------------------------------------------------------------------- pages

export interface PageMeta {
  id: string;
  title: string;
  url: string;
  icon: string;
  cover: string;
  edited: string;
  created: string;
  archived: boolean;
  /** 'data_source' when the page is a row — its columns come from a schema. */
  parentType: string;
  parentId: string;
}

function toMeta(p: NotionObject): PageMeta {
  const parent = p.parent ?? {};
  return {
    id: p.id,
    title: objectTitle(p),
    url: p.url ?? '',
    icon: icon(p),
    cover: p.cover?.external?.url ?? p.cover?.file?.url ?? '',
    edited: p.last_edited_time ?? '',
    created: p.created_time ?? '',
    archived: !!(p.archived || p.in_trash),
    parentType: parent.type ?? '',
    parentId: parent.data_source_id ?? parent.database_id ?? parent.page_id ?? '',
  };
}

export interface PageFull {
  meta: PageMeta;
  props: Record<string, PropValue>;
}

export function notionPage(userId: number, pageId: string): Promise<PageFull> {
  return cached(`notion:page:${userId}:${pageId}`, 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const p = await api<RawPage>(token, `/pages/${pageId}`);
    return { meta: toMeta(p), props: readProps(p.properties) };
  });
}

/** Compat shim: the watchers only ever wanted the meta row. */
export async function notionPageMeta(userId: number, pageId: string): Promise<PageMeta> {
  return (await notionPage(userId, pageId)).meta;
}

function invalidatePage(userId: number, pageId: string): void {
  invalidate(`notion:page:${userId}:${pageId}`);
  invalidate(`notion:blocks:${userId}:${pageId}`);
  // A row edit must also drop the list its ward reads. Which data source that
  // is would cost another request, so drop this user's row caches wholesale.
  invalidate(`notion:rows:${userId}:`);
  invalidate(`notion:cal:${userId}:`);
}

/** Write any set of properties BY NAME. Unknown or computed columns come back
 *  in `skipped` instead of failing the whole edit. */
export async function notionUpdateProps(
  userId: number,
  pageId: string,
  patch: Record<string, unknown>,
  schemaTypes?: Record<string, { type: string }>
): Promise<{ skipped: string[] }> {
  const token = await liveToken(userId, 'notion');
  let types = schemaTypes;
  if (!types) {
    // No schema handed in: read the page's own property types. Works for a
    // standalone page too, which has no data source to ask.
    const page = await api<RawPage>(token, `/pages/${pageId}`);
    types = Object.fromEntries(
      Object.entries(page.properties ?? {}).map(([k, v]) => [k, { type: (v as { type: string }).type }])
    );
  }
  const { properties, skipped } = writeProps(types, patch);
  if (Object.keys(properties).length) {
    await api(token, `/pages/${pageId}`, { method: 'PATCH', ...json({ properties }) });
    invalidatePage(userId, pageId);
  }
  return { skipped };
}

/** Page icon and cover — the two bits of chrome that are not properties. */
export async function notionSetChrome(userId: number, pageId: string, chrome: { icon?: string; cover?: string }): Promise<void> {
  const token = await liveToken(userId, 'notion');
  const body: Record<string, unknown> = {};
  if (chrome.icon !== undefined) body.icon = chrome.icon ? { type: 'emoji', emoji: chrome.icon.slice(0, 8) } : null;
  if (chrome.cover !== undefined) body.cover = chrome.cover ? { type: 'external', external: { url: chrome.cover.slice(0, 2000) } } : null;
  if (!Object.keys(body).length) return;
  await api(token, `/pages/${pageId}`, { method: 'PATCH', ...json(body) });
  invalidatePage(userId, pageId);
}

export async function notionCreatePage(
  userId: number,
  parent: { sourceId?: string; pageId?: string },
  props: Record<string, unknown>,
  children?: BlockDraft[]
): Promise<PageMeta> {
  const token = await liveToken(userId, 'notion');
  let properties: Record<string, unknown>;
  if (parent.sourceId) {
    const schema = await notionSourceSchema(userId, parent.sourceId);
    properties = writeProps(schema.types, props).properties;
  } else {
    // A child page has exactly one property: its title.
    properties = { title: { title: toRichText(String(props.title ?? props.Name ?? 'Untitled'), 200) } };
  }
  const page = await api<RawPage>(token, '/pages', {
    method: 'POST',
    ...json({
      parent: parent.sourceId
        ? { type: 'data_source_id', data_source_id: parent.sourceId }
        : { type: 'page_id', page_id: parent.pageId },
      properties,
      ...(children?.length ? { children: children.slice(0, 100).map(writeBlock) } : {}),
    }),
  });
  if (parent.sourceId) {
    invalidate(`notion:rows:${userId}:${parent.sourceId}`);
    invalidate(`notion:cal:${userId}:${parent.sourceId}`);
  }
  if (parent.pageId) invalidate(`notion:blocks:${userId}:${parent.pageId}`);
  return toMeta(page);
}

/** Archive (Notion's recoverable trash), or restore. */
export async function notionArchive(userId: number, pageId: string, archived = true): Promise<void> {
  const token = await liveToken(userId, 'notion');
  await api(token, `/pages/${pageId}`, { method: 'PATCH', ...json({ in_trash: archived }) });
  invalidatePage(userId, pageId);
}

// ------------------------------------------------------------------- blocks

export interface PageBlock extends NBlock {
  /** Nesting level; 0 = a direct child of the page. */
  depth: number;
}

const MAX_BLOCKS = 300;

/** The block tree, flattened depth-first with a `depth` on each row.
 *  ponytail: stops at MAX_BLOCKS and at maxDepth levels — a ward is not a
 *  Notion clone. Fetch children lazily per toggle if that ever bites. */
export function notionBlocks(userId: number, blockId: string, maxDepth = 3): Promise<PageBlock[]> {
  return cached(`notion:blocks:${userId}:${blockId}`, 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const out: PageBlock[] = [];
    const walk = async (parent: string, depth: number): Promise<void> => {
      if (depth > maxDepth || out.length >= MAX_BLOCKS) return;
      const raws = await paged<Record<string, unknown>>(token, `/blocks/${parent}/children`, { max: MAX_BLOCKS - out.length });
      for (const raw of raws) {
        if (out.length >= MAX_BLOCKS) return;
        const b: PageBlock = { ...readBlock(raw), depth };
        out.push(b);
        // child_page / child_database children are other pages, not content.
        if (b.hasChildren && b.type !== 'child_page' && b.type !== 'child_database') await walk(b.id, depth + 1);
      }
    };
    await walk(blockId, 0);
    return out;
  });
}

/** Append blocks to a page or a block. `after` inserts mid-list. */
export async function notionAppendBlocks(userId: number, parentId: string, drafts: BlockDraft[], after?: string): Promise<NBlock[]> {
  const token = await liveToken(userId, 'notion');
  const data = await api<Paged<Record<string, unknown>>>(token, `/blocks/${parentId}/children`, {
    method: 'PATCH',
    ...json({ children: drafts.slice(0, 100).map(writeBlock), ...(after ? { after } : {}) }),
  });
  invalidate(`notion:blocks:${userId}:`);
  return data.results.map(readBlock);
}

export async function notionUpdateBlock(userId: number, blockId: string, draft: BlockDraft): Promise<NBlock> {
  const token = await liveToken(userId, 'notion');
  const raw = await api<Record<string, unknown>>(token, `/blocks/${blockId}`, { method: 'PATCH', ...json(updateBlockBody(draft)) });
  invalidate(`notion:blocks:${userId}:`);
  return readBlock(raw);
}

/** Notion's DELETE moves the block to trash — recoverable, like a page. */
export async function notionDeleteBlock(userId: number, blockId: string): Promise<void> {
  const token = await liveToken(userId, 'notion');
  await api(token, `/blocks/${blockId}`, { method: 'DELETE' });
  invalidate(`notion:blocks:${userId}:`);
}

export async function notionBlock(userId: number, blockId: string): Promise<NBlock> {
  const token = await liveToken(userId, 'notion');
  return readBlock(await api<Record<string, unknown>>(token, `/blocks/${blockId}`));
}

/** Plain text of the LAST block on a page — the capture-page watcher's probe. */
export async function notionLastBlockText(userId: number, pageId: string): Promise<string> {
  const token = await liveToken(userId, 'notion');
  const raws = await paged<Record<string, unknown>>(token, `/blocks/${pageId}/children`, { max: 500 });
  const last = raws.at(-1);
  return last ? readBlock(last).text : '';
}

export async function notionCapture(userId: number, text: string, pageId = notionCapturePageId(userId)): Promise<void> {
  await notionAppendBlocks(userId, pageId, [{ type: 'paragraph', text }]);
}

// ----------------------------------------------------------------- comments

export interface NComment {
  id: string;
  discussionId: string;
  text: string;
  author: string;
  created: string;
}

export function notionComments(userId: number, pageId: string): Promise<NComment[]> {
  return cached(`notion:comments:${userId}:${pageId}`, 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const rows = await paged<{
      id: string;
      discussion_id: string;
      created_time: string;
      created_by?: { id?: string; name?: string };
      rich_text?: RichTextItem[];
    }>(token, `/comments?block_id=${encodeURIComponent(pageId)}`, { max: 50 });
    const names = await notionUserNames(userId).catch(() => new Map<string, string>());
    return rows.map((c) => ({
      id: c.id,
      discussionId: c.discussion_id,
      text: plainText(c.rich_text),
      author: c.created_by?.name ?? names.get(c.created_by?.id ?? '') ?? '',
      created: c.created_time,
    }));
  });
}

/** Start a thread on a page, or reply into an existing discussion. */
export async function notionAddComment(userId: number, target: { pageId?: string; discussionId?: string }, text: string): Promise<void> {
  const token = await liveToken(userId, 'notion');
  await api(token, '/comments', {
    method: 'POST',
    ...json({
      ...(target.discussionId ? { discussion_id: target.discussionId } : { parent: { page_id: target.pageId } }),
      rich_text: toRichText(text),
    }),
  });
  invalidate(target.pageId ? `notion:comments:${userId}:${target.pageId}` : `notion:comments:${userId}:`);
}

// -------------------------------------------------------------------- users

export interface NUser {
  id: string;
  name: string;
  avatar: string;
  type: string;
  email: string;
}

export function notionUsers(userId: number): Promise<NUser[]> {
  return cached(`notion:users:${userId}`, 30 * 60_000, async () => {
    const token = await liveToken(userId, 'notion');
    const rows = await paged<{ id: string; name?: string; avatar_url?: string; type?: string; person?: { email?: string } }>(
      token,
      '/users',
      { max: 100 }
    );
    return rows.map((u) => ({ id: u.id, name: u.name ?? '', avatar: u.avatar_url ?? '', type: u.type ?? '', email: u.person?.email ?? '' }));
  });
}

async function notionUserNames(userId: number): Promise<Map<string, string>> {
  return new Map((await notionUsers(userId)).map((u) => [u.id, u.name]));
}

export async function notionMe(userId: number): Promise<NUser> {
  const token = await liveToken(userId, 'notion');
  const u = await api<{ id: string; name?: string; avatar_url?: string; type?: string; bot?: { owner?: { user?: { name?: string } } } }>(
    token,
    '/users/me'
  );
  return { id: u.id, name: u.name ?? u.bot?.owner?.user?.name ?? '', avatar: u.avatar_url ?? '', type: u.type ?? '', email: '' };
}

// ------------------------------------------------------------- file uploads

/** Single-part upload (Notion caps this mode at 20 MB). Returns the id you
 *  attach with `{file_upload_id}` on a files property or a media block. */
export async function notionUploadFile(userId: number, filename: string, contentType: string, bytes: Uint8Array): Promise<string> {
  const token = await liveToken(userId, 'notion');
  const created = await api<{ id: string; upload_url: string }>(token, '/file_uploads', {
    method: 'POST',
    ...json({ mode: 'single_part', filename: filename.slice(0, 200), content_type: contentType }),
  });
  const form = new FormData();
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: contentType }), filename);
  const res = await fetch(created.upload_url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'notion-version': VERSION },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`notion upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return created.id;
}

// ------------------------------------------------------------------- tasks
// The task wards ('notion-tasks' and 'checklist') are one list over one data
// source. Done-ness rides a checkbox, a status, or a select property — most
// Notion task templates ship a status, not a checkbox.

export type DoneKind = 'checkbox' | 'status' | 'select';

export interface DoneProp {
  name: string;
  kind: DoneKind;
  /** Option written when checking off (status/select only). */
  doneValue?: string;
  /** Option written when un-checking. */
  openValue?: string;
}

export interface TaskProps {
  title: string;
  /** null = no done-ness column; the list renders read-only. */
  done: DoneProp | null;
  date: string | null;
}

const DONE_RE = /^(done|complete|completed|closed|finished|shipped)$/i;
const OPEN_RE = /^(to.?do|not.?started|open|backlog|inbox|new)$/i;

function pickDone(entries: [string, DbProp][]): DoneProp | null {
  const checkbox = entries.find(([, p]) => p.type === 'checkbox');
  if (checkbox) return { name: checkbox[0], kind: 'checkbox' };

  const status = entries.find(([, p]) => p.type === 'status');
  if (status) {
    const [name, p] = status;
    const opts = p.status?.options ?? [];
    const byId = new Map(opts.map((o) => [o.id, o.name]));
    const inGroup = (re: RegExp) =>
      (p.status?.groups ?? []).find((g) => re.test(g.name))?.option_ids.map((id) => byId.get(id)).find(Boolean);
    const doneValue = inGroup(/complete|done/i) ?? opts.find((o) => DONE_RE.test(o.name))?.name;
    if (doneValue) {
      const openValue = inGroup(/to.?do|not.?started|backlog/i) ?? opts.find((o) => o.name !== doneValue)?.name;
      return { name, kind: 'status', doneValue, openValue };
    }
  }

  for (const [name, p] of entries) {
    if (p.type !== 'select') continue;
    const opts = p.select?.options ?? [];
    const doneValue = opts.find((o) => DONE_RE.test(o.name))?.name;
    if (!doneValue) continue;
    const openValue = opts.find((o) => OPEN_RE.test(o.name))?.name ?? opts.find((o) => o.name !== doneValue)?.name;
    return { name, kind: 'select', doneValue, openValue };
  }
  return null;
}

/** Pure: the whole column heuristic, testable without touching Notion. */
export function pickTaskProps(properties: Record<string, DbProp>): TaskProps {
  const entries = Object.entries(properties);
  const first = (t: string) => entries.find(([, p]) => p.type === t)?.[0] ?? null;
  return { title: first('title') ?? 'Name', done: pickDone(entries), date: first('date') };
}

/** SourceSchema → the shape pickTaskProps reads. Keeps the heuristic pure. */
function schemaToDbProps(schema: SourceSchema): Record<string, DbProp> {
  const out: Record<string, DbProp> = {};
  for (const p of schema.props) {
    const options = (p.options ?? []).map((o, i) => ({ id: `o${i}`, name: o.name, color: o.color }));
    if (p.type === 'status') {
      const doneIds = options.filter((o) => (p.doneOptions ?? []).includes(o.name)).map((o) => o.id);
      out[p.name] = { type: p.type, status: { options, groups: doneIds.length ? [{ name: 'Complete', option_ids: doneIds }] : [] } };
    } else if (p.type === 'select') out[p.name] = { type: p.type, select: { options } };
    else if (p.type === 'multi_select') out[p.name] = { type: p.type, multi_select: { options } };
    else out[p.name] = { type: p.type };
  }
  return out;
}

/** Column roles for a data source, remembered in link meta. Re-detected
 *  whenever the config dialog reads the schema. */
async function taskProps(userId: number, sourceId: string): Promise<TaskProps> {
  const link = getLink(userId, 'notion');
  const byId = ((link ? getMeta(link).task_props : undefined) ?? {}) as Record<string, TaskProps>;
  if (byId[sourceId]) return byId[sourceId];
  const props = pickTaskProps(schemaToDbProps(await notionSourceSchema(userId, sourceId)));
  patchMeta(userId, 'notion', { task_props: { ...byId, [sourceId]: props } });
  return props;
}

/** Everything a task-ward config dialog needs about one database: its lists,
 *  the chosen list's columns, and which column check-off will write. */
export async function notionTaskSchema(
  userId: number,
  dbId: string,
  dsId?: string
): Promise<{ sources: { id: string; name: string }[]; sourceId: string; title: string; done: DoneProp | null; props: SourceProp[] }> {
  const sources = await notionDataSources(userId, dbId).catch(() => []);
  const sourceId = dsId ?? sources[0]?.id ?? dbId;
  const schema = await notionSourceSchema(userId, sourceId);
  const props = pickTaskProps(schemaToDbProps(schema));
  // Re-reading the schema is exactly when a new column should be noticed.
  const link = getLink(userId, 'notion');
  const byId = ((link ? getMeta(link).task_props : undefined) ?? {}) as Record<string, TaskProps>;
  patchMeta(userId, 'notion', { task_props: { ...byId, [sourceId]: props } });
  return { sources, sourceId, title: schema.title, done: props.done, props: schema.props };
}

/** A row's property as the ward draws it — the codec's full value, so the
 *  list's chips carry every option colour and any styled runs. */
export type Field = PropValue;

export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  url: string;
  created: string;
  edited: string;
  /** Every non-title property, flattened. The ward picks which to show. */
  fields: Record<string, Field>;
}

function readDone(d: DoneProp | null, props: Record<string, PropValue>): boolean {
  if (!d) return false;
  const v = props[d.name];
  if (!v) return false;
  if (d.kind === 'checkbox') return v.value === true;
  const name = String(v.value ?? '');
  return d.doneValue ? name === d.doneValue : DONE_RE.test(name);
}

function donePatch(d: DoneProp, done: boolean): Record<string, unknown> {
  if (d.kind === 'checkbox') return { [d.name]: done };
  const value = done ? d.doneValue : d.openValue;
  // Visible failure beats a PATCH that silently does nothing.
  if (!value) throw new Error(`"${d.name}" has no ${done ? 'done' : 'open'} option`);
  return { [d.name]: value };
}

/** The shared, cached list read, keyed by DATA SOURCE. */
export async function notionChecklist(userId: number, sourceId: string): Promise<ChecklistItem[]> {
  const props = await taskProps(userId, sourceId);
  const rows = await notionRows(userId, sourceId, props.date ?? undefined);
  return rows.map((r) => {
    const fields: Record<string, Field> = {};
    for (const [name, v] of Object.entries(r.props)) {
      if (name === props.title || !v.text) continue;
      fields[name] = v;
    }
    return {
      id: r.id,
      title: r.props[props.title]?.text ?? '',
      done: readDone(props.done, r.props),
      due: props.date ? (r.props[props.date]?.value as { start?: string } | undefined)?.start || null : null,
      url: r.url,
      created: r.created,
      edited: r.edited,
      fields,
    };
  });
}

export async function notionChecklistToggle(userId: number, sourceId: string, pageId: string, done: boolean): Promise<void> {
  const props = await taskProps(userId, sourceId);
  if (!props.done) throw new Error('this list has no checkbox, status or select column to check off');
  const schema = await notionSourceSchema(userId, sourceId);
  await notionUpdateProps(userId, pageId, donePatch(props.done, done), schema.types);
}

export async function notionChecklistAdd(userId: number, sourceId: string, title: string, due?: string): Promise<void> {
  const props = await taskProps(userId, sourceId);
  const patch: Record<string, unknown> = { [props.title]: title.slice(0, 200) };
  if (due) {
    // Visible failure beats a silently dropped due date.
    if (!props.date) throw new Error('this list has no date column');
    patch[props.date] = { start: due };
  }
  if (props.done && props.done.kind !== 'checkbox' && props.done.openValue) Object.assign(patch, donePatch(props.done, false));
  await notionCreatePage(userId, { sourceId }, patch);
}

/** The legacy singleton tasks list: the checklist over the account-level db. */
export async function notionTasks(userId: number): Promise<{ tasks: ChecklistItem[] } | { needsConfig: true }> {
  const link = getLink(userId, 'notion');
  const dbId = link ? (getMeta(link).tasks_db_id as string | undefined) : undefined;
  if (!dbId) return { needsConfig: true };
  return { tasks: await notionChecklist(userId, await notionSourceId(userId, dbId)) };
}

// ------------------------------------------------------ one-off page fields
// For the logic engine's 'notion-task-done' condition and 'notion.check-task'
// action: works on ANY page by finding its first checkbox / date column.

async function firstOfType(userId: number, pageId: string, type: string): Promise<{ name: string; v: PropValue } | null> {
  const { props } = await notionPage(userId, pageId);
  for (const [name, v] of Object.entries(props)) if (v.type === type) return { name, v };
  return null;
}

export async function notionPageChecked(userId: number, pageId: string): Promise<boolean> {
  const hit = await firstOfType(userId, pageId, 'checkbox');
  if (!hit) throw new Error('page has no checkbox property');
  return hit.v.value === true;
}

export async function notionSetPageChecked(userId: number, pageId: string, done: boolean): Promise<void> {
  const hit = await firstOfType(userId, pageId, 'checkbox');
  if (!hit) throw new Error('page has no checkbox property');
  await notionUpdateProps(userId, pageId, { [hit.name]: done }, { [hit.name]: { type: 'checkbox' } });
}

export async function notionPageDue(userId: number, pageId: string): Promise<string | null> {
  const hit = await firstOfType(userId, pageId, 'date');
  return (hit?.v.value as { start?: string } | undefined)?.start || null;
}

// ----------------------------------------------------------- ward resolvers

/** The stored pointer for a task ward: its own config, else — for a legacy
 *  'notion-tasks' ward with none — the account-level tasks database. */
export function taskWardRef(userId: number, ward: unknown): { db: string; ds?: string } | null {
  if (typeof ward !== 'string') return null;
  const w = getDashboard(userId).find((x) => x.i === ward && TASK_WARDS.has(x.type));
  if (!w) return null;
  if (typeof w.config?.db === 'string') {
    return { db: w.config.db, ...(typeof w.config.ds === 'string' ? { ds: w.config.ds } : {}) };
  }
  if (w.type === 'checklist') return null;
  const link = getLink(userId, 'notion');
  const db = link ? (getMeta(link).tasks_db_id as string | undefined) : undefined;
  return db ? { db } : null;
}

/** The ONE resolver every route and tool uses: ward id → data source to query.
 *  null = no such ward, or it has no database picked yet. */
export async function taskWardSource(userId: number, ward: unknown): Promise<string | null> {
  const ref = taskWardRef(userId, ward);
  return ref ? notionSourceId(userId, ref.db, ref.ds) : null;
}

/** The account-level tasks data source. Throws (→ error run) if unset. */
export async function notionTasksSource(userId: number): Promise<string> {
  const link = getLink(userId, 'notion');
  const id = link ? (getMeta(link).tasks_db_id as string | undefined) : undefined;
  if (!id) throw new Error('no tasks database configured');
  return notionSourceId(userId, id);
}

/** The account-level calendar database (a database with a date column). */
export function notionCalendarDbId(userId: number): string | null {
  const link = getLink(userId, 'notion');
  const id = link ? (getMeta(link).calendar_db_id as string | undefined) : undefined;
  return id || null;
}

/** The date column a calendar reads when the ward names none: Date/When/
 *  Start/Due by name if there is one, else the first date column. */
export function pickDateProp(schema: SourceSchema): SourceProp | undefined {
  const dates = schema.props.filter((p) => p.type === 'date');
  return dates.find((p) => /^(date|when|start|due)$/i.test(p.name)) ?? dates[0];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The rows whose `prop` date touches [from, to] — a month grid's read. Its
 *  OWN cache key (never the shared notionRows entry, CLAUDE.md), dropped
 *  wherever rows are. Notion's date filters compare the START only, so the
 *  lower bound is widened by 45 days to catch ranges that began earlier; the
 *  client clips by end. */
export function notionDated(userId: number, sourceId: string, prop: string, from: string, to: string): Promise<Row[]> {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) throw Object.assign(new Error('from/to must be YYYY-MM-DD, from ≤ to'), { status: 400 });
  return cached(`notion:cal:${userId}:${sourceId}:${prop}:${from}:${to}`, 60_000, async () => {
    const schema = await notionSourceSchema(userId, sourceId);
    if (schema.types[prop]?.type !== 'date') throw Object.assign(new Error(`"${prop}" is not a date column`), { status: 400 });
    const filter = buildFilter(schema.types, [
      { property: prop, op: 'on_or_after', value: shiftDay(from, -45) },
      { property: prop, op: 'on_or_before', value: to },
    ]);
    return notionQuery(userId, sourceId, { filter, sorts: [{ property: prop, direction: 'ascending' }], max: 200 });
  });
}

/** That database's rows dated inside the agenda window, as calendar events.
 *  A date-filtered query, so it gets its OWN cache key — it must never land in
 *  the shared notionRows entry (CLAUDE.md). A row qualifies by its START date,
 *  like a Notion calendar view does. */
export function notionAgenda(userId: number, days: number): Promise<CalEvent[]> {
  return cached(`ncal:${userId}:${days}`, 5 * 60_000, async () => {
    const dbId = notionCalendarDbId(userId);
    if (!dbId) return [];
    const sourceId = await notionSourceId(userId, dbId);
    const schema = await notionSourceSchema(userId, sourceId);
    const when = pickDateProp(schema);
    if (!when) throw new Error(`calendar database "${schema.title || dbId}" has no date column`);
    const titleProp = schema.props.find((p) => p.type === 'title')?.name;
    // Local calendar days, not UTC ones: at 9pm ET a UTC "today" is already tomorrow.
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const filter = buildFilter(schema.types, [
      { property: when.name, op: 'on_or_after', value: day(now) },
      { property: when.name, op: 'on_or_before', value: day(new Date(now.getTime() + days * 86_400_000)) },
    ]);
    const rows = await notionQuery(userId, sourceId, { filter, sorts: [{ property: when.name, direction: 'ascending' }], max: 50 });
    // Date-only values take the naive "T00:00:00" form Google all-day events use (calendar.ts eventMs).
    const iso = (d: string) => (d.includes('T') ? d : `${d}T00:00:00`);
    const calendar = schema.title || 'notion';
    return rows.flatMap((r): CalEvent[] => {
      const v = r.props[when.name]?.value as { start?: string; end?: string | null } | undefined;
      if (r.archived || !v?.start) return [];
      return [
        {
          id: r.id,
          source: 'notion',
          calendar,
          title: (titleProp && r.props[titleProp]?.text) || '(untitled)',
          start: iso(v.start),
          end: iso(v.end || v.start),
          allDay: !v.start.includes('T'),
          location: '',
        },
      ];
    });
  });
}

export function notionCapturePageId(userId: number): string {
  const link = getLink(userId, 'notion');
  const id = link ? (getMeta(link).capture_page_id as string | undefined) : undefined;
  if (!id) throw new Error('no capture page configured');
  return id;
}

/** Accepts a raw id or a pasted notion.so URL; returns the dashed UUID. */
export function parseNotionId(input: string): string | null {
  const m =
    input.trim().match(/[0-9a-f]{32}(?![0-9a-f])/i) ??
    input.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) return null;
  const hex = m[0].replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Linked notebook sheets retain Notion's wire values; the older ward codecs
// deliberately flatten them and must not be used for this round trip.
export interface LinkedNotionProperty extends Record<string, unknown> { id: string; type: string }
export interface LinkedNotionPage extends Record<string, unknown> {
  id: string;
  properties: Record<string, LinkedNotionProperty>;
  parent?: { data_source_id?: string; database_id?: string };
}
export interface LinkedNotionSource extends Record<string, unknown> {
  id: string;
  properties: Record<string, LinkedNotionProperty>;
  parent?: { database_id?: string };
}
export interface LinkedNotionView extends Record<string, unknown> { id: string; data_source_id: string; name: string; type: string }
export interface LinkedNotionRows {
  rows: LinkedNotionPage[];
  nextCursor: string | null;
  hasMore: boolean;
  queryId?: string;
  totalCount?: number;
  incomplete: boolean;
  incompleteReason?: string;
}
const linkedError = (message: string, status = 400) => Object.assign(new Error(message), { status });
const sameNotionId = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();
const propId = (id: string) => { try { return decodeURIComponent(id); } catch { return id; } };
const linkedProp = (properties: Record<string, LinkedNotionProperty>, id: string) => Object.values(properties).find((p) => propId(p.id) === propId(id));
function linkedCursor(data: Paged<unknown>): string | null {
  if (data.has_more && !data.next_cursor) throw linkedError('Notion returned an incomplete page without a continuation cursor. Refresh to continue.', 502);
  return data.has_more ? data.next_cursor! : null;
}

export function notionLinkedConnection(userId: number, expectedWorkspaceId?: string): { workspaceId: string; label: string } {
  const link = getLink(userId, 'notion');
  if (!link) throw linkedError('Connect Notion to open this database.', 404);
  const workspaceId = getMeta(link).workspace_id;
  if (typeof workspaceId !== 'string' || !workspaceId) throw linkedError('Reconnect Notion to identify its workspace.', 409);
  if (expectedWorkspaceId !== undefined && !sameNotionId(workspaceId, expectedWorkspaceId)) {
    throw linkedError('This notebook belongs to another Notion workspace. Reconnect its original workspace to continue.', 409);
  }
  return { workspaceId, label: link.account_label };
}

async function linkedToken(userId: number, workspaceId: string) {
  notionLinkedConnection(userId, workspaceId);
  return liveToken(userId, 'notion');
}

export async function notionLinkedSearch(userId: number, query = '', cursor?: string) {
  const connection = notionLinkedConnection(userId);
  const token = await liveToken(userId, 'notion');
  const result = await api<Paged<LinkedNotionSource>>(token, '/search', { method: 'POST', ...json({ query, page_size: 50, filter: { value: 'data_source', property: 'object' }, ...(cursor ? { start_cursor: cursor } : {}) }) });
  return { ...connection, results: result.results, nextCursor: linkedCursor(result), hasMore: !!result.has_more };
}

export async function notionLinkedUsers(userId: number, workspaceId: string, cursor?: string) {
  const token = await linkedToken(userId, workspaceId);
  const result = await api<Paged<Record<string, unknown>>>(token, `/users?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
  return { users: result.results, nextCursor: linkedCursor(result), hasMore: !!result.has_more };
}

export async function notionLinkedSource(userId: number, workspaceId: string, sourceId: string) {
  const token = await linkedToken(userId, workspaceId);
  const source = await api<LinkedNotionSource>(token, `/data_sources/${sourceId}`);
  const views: LinkedNotionView[] = [];
  let viewsError: string | undefined;
  let cursor: string | null = null;
  try {
    // Bound the picker, explicitly expose continuation instead of silently
    // inventing a complete list. Row queries themselves remain cursor based.
    do {
      const refs: Paged<{ id: string }> = await api(token, `/views?data_source_id=${sourceId}&page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const ref of refs.results) views.push(await api<LinkedNotionView>(token, `/views/${encodeURIComponent(ref.id)}`));
      cursor = linkedCursor(refs);
    } while (cursor && views.length < 100);
    if (cursor) viewsError = 'Only the first 100 saved views are listed. Additional views remain available in Notion.';
  } catch (error) { viewsError = (error as Error).message; }
  return { source, views, ...(viewsError ? { viewsError } : {}) };
}

async function linkedView(token: string, sourceId: string, viewId: string) {
  const view = await api<LinkedNotionView>(token, `/views/${viewId}`);
  if (!sameNotionId(view.data_source_id, sourceId)) throw linkedError('This view belongs to a different data source.', 409);
  return view;
}

export async function notionLinkedRows(userId: number, workspaceId: string, sourceId: string, opts: { viewId?: string; cursor?: string; queryId?: string; pageSize?: number } = {}): Promise<LinkedNotionRows> {
  const token = await linkedToken(userId, workspaceId);
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 50), 1), 100);
  let data: Paged<LinkedNotionPage> & { id?: string; total_count?: number; request_status?: { type?: string; incomplete_reason?: string } };
  if (opts.viewId) {
    await linkedView(token, sourceId, opts.viewId);
    data = opts.queryId
      ? await api(token, `/views/${opts.viewId}/queries/${encodeURIComponent(opts.queryId)}?page_size=${pageSize}${opts.cursor ? `&start_cursor=${encodeURIComponent(opts.cursor)}` : ''}`)
      : await api(token, `/views/${opts.viewId}/queries`, { method: 'POST', ...json({ page_size: pageSize }) });
  } else {
    data = await api(token, `/data_sources/${sourceId}/query`, { method: 'POST', ...json({ page_size: pageSize, ...(opts.cursor ? { start_cursor: opts.cursor } : {}) }) });
  }
  // Some view responses return page references. Resolve those without
  // flattening metadata, property values, icons or covers.
  const rows: LinkedNotionPage[] = [];
  for (const row of data.results) rows.push(row.properties ? row : await api(token, `/pages/${encodeURIComponent(row.id)}`));
  return { rows, nextCursor: linkedCursor(data), hasMore: !!data.has_more, incomplete: data.request_status?.type === 'incomplete', ...(data.request_status?.incomplete_reason ? { incompleteReason: data.request_status.incomplete_reason } : {}), ...(opts.viewId ? { queryId: opts.queryId ?? data.id } : {}), ...(typeof data.total_count === 'number' ? { totalCount: data.total_count } : {}) };
}

export async function notionLinkedDeleteQuery(userId: number, workspaceId: string, sourceId: string, viewId: string, queryId: string) {
  const token = await linkedToken(userId, workspaceId);
  await linkedView(token, sourceId, viewId);
  await api(token, `/views/${viewId}/queries/${encodeURIComponent(queryId)}`, { method: 'DELETE' });
}

async function linkedPage(token: string, sourceId: string, pageId: string) {
  const page = await api<LinkedNotionPage>(token, `/pages/${pageId}`);
  if (!sameNotionId(page.parent?.data_source_id, sourceId)) throw linkedError('This row no longer belongs to the linked data source.', 409);
  return page;
}

async function completeProperty(token: string, pageId: string, property: LinkedNotionProperty): Promise<{ property: LinkedNotionProperty; complete: boolean; nextCursor?: string | null }> {
  if (!['title', 'rich_text', 'people', 'relation', 'rollup'].includes(property.type)) return { property, complete: true };
  const items: unknown[] = [];
  let cursor: string | null = null;
  let final = property;
  for (let page = 0; page < 100; page++) {
    const data: Paged<LinkedNotionProperty> & { object?: string; property_item?: LinkedNotionProperty } = await api(token, `/pages/${pageId}/properties/${encodeURIComponent(propId(property.id))}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (data.object !== 'list') {
      const value: LinkedNotionProperty = { ...property, ...data };
      const rollup = value.rollup as { type?: string } | undefined;
      return { property: value, complete: property.type !== 'rollup' || (!!rollup && !['incomplete', 'unsupported'].includes(rollup.type ?? '')) };
    }
    for (const item of data.results) {
      const value = item[item.type];
      items.push(property.type === 'rollup' ? { type: item.type, [item.type]: ['title', 'rich_text', 'people', 'relation'].includes(item.type) && !Array.isArray(value) ? [value] : value } : value);
    }
    if (data.property_item) final = { ...property, ...data.property_item };
    cursor = linkedCursor(data);
    if (!data.has_more) {
      if (property.type === 'rollup') {
        const rollup = final.rollup as Record<string, unknown> | undefined;
        return { property: { ...final, ...(rollup?.type === 'array' ? { rollup: { ...rollup, array: items } } : {}), items }, complete: !!rollup && !['incomplete', 'unsupported'].includes(String(rollup.type)) };
      }
      return { property: { ...property, [property.type]: items, has_more: false }, complete: true };
    }
  }
  if (property.type === 'rollup') {
    const rollup = final.rollup as Record<string, unknown> | undefined;
    return { property: { ...final, ...(rollup?.type === 'array' ? { rollup: { ...rollup, array: items } } : {}), items, has_more: true }, complete: false, nextCursor: cursor };
  }
  return { property: { ...final, [property.type]: items, has_more: true }, complete: false, nextCursor: cursor };
}

export async function notionLinkedProperty(userId: number, workspaceId: string, sourceId: string, pageId: string, propertyId: string) {
  const token = await linkedToken(userId, workspaceId);
  const page = await linkedPage(token, sourceId, pageId);
  const property = linkedProp(page.properties, propertyId);
  if (!property) throw linkedError('This property was removed. Refresh the database.', 409);
  return completeProperty(token, pageId, property);
}

const linkedWritable = new Set(['title', 'rich_text', 'number', 'checkbox', 'url', 'email', 'phone_number', 'date', 'select', 'multi_select', 'status', 'people', 'relation', 'files']);

/** Strip only response metadata; rich-text runs, links, mentions, annotations,
 * timezone and untouched file variants keep their original wire meaning. */
function linkedWriteValue(type: string, value: unknown): unknown {
  if (!linkedWritable.has(type)) throw linkedError(`The ${type} property is read-only.`);
  if (['title', 'rich_text', 'people', 'relation', 'multi_select', 'files'].includes(type)) {
    if (!Array.isArray(value)) throw linkedError(`${type} requires an array.`);
    if (value.length > 100) throw linkedError('Notion limits a property write to 100 items. This value remains protected to prevent truncation.');
    return value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw linkedError(`Invalid ${type} item.`);
      const p = item as Record<string, unknown>;
      if (['people', 'relation', 'multi_select'].includes(type)) {
        if (typeof p.id !== 'string' || !p.id) throw linkedError(`${type} entries require stable IDs.`);
        return { id: p.id };
      }
      if (type === 'files') {
        const fileType = p.type as string;
        if (!['file', 'external', 'file_upload'].includes(fileType)) throw linkedError('Unsupported file type; retain this file in Notion.');
        const file = p[fileType] as Record<string, unknown> | undefined;
        if (!file || typeof file !== 'object') throw linkedError('Invalid file value.');
        return { name: p.name, type: fileType, [fileType]: fileType === 'file_upload' ? { id: file.id } : { url: file.url } };
      }
      const runType = p.type as string;
      if (!['text', 'mention', 'equation'].includes(runType)) throw linkedError('Unsupported rich-text run; edit this value in Notion.');
      return { type: runType, [runType]: p[runType], ...(p.annotations ? { annotations: p.annotations } : {}) };
    });
  }
  if (type === 'select' || type === 'status') {
    if (value === null) return null;
    const option = value as { id?: unknown };
    if (!option || typeof option.id !== 'string') throw linkedError('An existing option ID is required.');
    return { id: option.id };
  }
  if (type === 'number' && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw linkedError('Enter a finite number or clear the cell.');
  if (type === 'checkbox' && typeof value !== 'boolean') throw linkedError('A checkbox must be true or false.');
  if (['url', 'email', 'phone_number'].includes(type) && value !== null && typeof value !== 'string') throw linkedError(`${type} must be text or null.`);
  if (type === 'date' && value !== null && (typeof value !== 'object' || Array.isArray(value) || typeof (value as { start?: unknown }).start !== 'string')) throw linkedError('A date requires a start value.');
  return value;
}

function comparableProperty(property: LinkedNotionProperty) {
  const value = linkedWriteValue(property.type, property[property.type]);
  if (property.type !== 'files') return value;
  // Signed download URLs rotate without changing the stored file.
  return (value as Record<string, unknown>[]).map((file) => {
    if (file.type !== 'file') return file;
    const url = new URL((file.file as { url: string }).url);
    return { ...file, file: { url: `${url.origin}${url.pathname}` } };
  });
}

export async function notionLinkedUpdateProperty(userId: number, workspaceId: string, sourceId: string, pageId: string, propertyId: string, value: unknown, original: LinkedNotionProperty) {
  const token = await linkedToken(userId, workspaceId);
  const source = await api<LinkedNotionSource>(token, `/data_sources/${sourceId}`);
  const schema = linkedProp(source.properties, propertyId);
  if (!schema || !linkedWritable.has(schema.type)) throw linkedError('This property was removed, changed type, or is read-only.', 409);
  const page = await linkedPage(token, sourceId, pageId);
  const current = linkedProp(page.properties, propertyId);
  if (!current || original?.type !== schema.type || propId(original?.id ?? '') !== propId(current.id)) throw linkedError('The property changed. Refresh before editing.', 409);
  const full = await completeProperty(token, pageId, current);
  if (!full.complete) throw linkedError('This property could not be loaded completely. Editing is blocked to prevent data loss.', 409);
  if (!isDeepStrictEqual(comparableProperty(full.property), comparableProperty(original))) throw linkedError('This cell changed in Notion. Your draft was kept; refresh and review the newer value before saving.', 409);
  let payload = linkedWriteValue(schema.type, value);
  if (schema.type === 'files') {
    const freshFiles = linkedWriteValue('files', full.property.files) as Record<string, unknown>[];
    const identity = (file: Record<string, unknown>) => comparableProperty({ id: current.id, type: 'files', files: [file] });
    payload = (payload as Record<string, unknown>[]).map((file) => file.type === 'file' ? freshFiles.find((fresh) => isDeepStrictEqual(identity(fresh), identity(file))) ?? file : file);
  }
  await api(token, `/pages/${pageId}`, { method: 'PATCH', ...json({ properties: { [current.id]: { [schema.type]: payload } } }) });
  invalidatePage(userId, pageId);
  const row = await linkedPage(token, sourceId, pageId);
  const saved = linkedProp(row.properties, propertyId);
  return { row, ...(saved ? await completeProperty(token, pageId, saved) : {}) };
}

export async function notionLinkedCreate(userId: number, workspaceId: string, sourceId: string, values: Record<string, unknown>) {
  const token = await linkedToken(userId, workspaceId);
  const source = await api<LinkedNotionSource>(token, `/data_sources/${sourceId}`);
  const properties: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(values)) {
    const schema = linkedProp(source.properties, id);
    if (!schema || !raw || typeof raw !== 'object') throw linkedError('A property no longer exists. Refresh before adding a row.', 409);
    properties[schema.id] = { [schema.type]: linkedWriteValue(schema.type, (raw as Record<string, unknown>)[schema.type]) };
  }
  const row = await api<LinkedNotionPage>(token, '/pages', { method: 'POST', ...json({ parent: { type: 'data_source_id', data_source_id: sourceId }, properties }) });
  invalidatePage(userId, row.id);
  return { row };
}

export async function notionLinkedUpdateDefinition(userId: number, workspaceId: string, sourceId: string, action: 'view' | 'schema', patch: Record<string, unknown>, original: Record<string, unknown>, viewId?: string) {
  const token = await linkedToken(userId, workspaceId);
  const current = action === 'view' ? await linkedView(token, sourceId, viewId!) : await api<LinkedNotionSource>(token, `/data_sources/${sourceId}`);
  const allowed = action === 'view' ? ['name', 'filter', 'sorts', 'quick_filters', 'configuration'] : ['title', 'properties'];
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !allowed.includes(key))) throw linkedError('Unsupported database or view change.');
  for (const key of Object.keys(patch)) {
    if (!isDeepStrictEqual(current[key], original[key])) throw linkedError(`The shared ${key} changed in Notion. Refresh before saving.`, 409);
  }
  const result = await api(token, action === 'view' ? `/views/${viewId}` : `/data_sources/${sourceId}`, { method: 'PATCH', ...json(patch) });
  invalidate(`notion:schema:${userId}:${sourceId}`);
  invalidate(`notion:dbs:${userId}`);
  invalidate(`notion:rows:${userId}:${sourceId}`);
  invalidate(`notion:cal:${userId}:${sourceId}`);
  return action === 'view' ? { view: result } : { source: result };
}
