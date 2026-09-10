import type { APIRoute } from 'astro';
import { needId, notionRoute } from '../../../lib/notion-route.ts';
import {
  notionLinkedConnection, notionLinkedSearch, notionLinkedSource, notionLinkedRows,
  notionLinkedProperty, notionLinkedUpdateProperty, notionLinkedCreate,
  notionLinkedUpdateDefinition, notionLinkedDeleteQuery, notionLinkedUsers,
  type LinkedNotionProperty,
} from '../../../lib/notion.ts';

export const prerender = false;
type Body = Record<string, unknown>;
const bad = (message: string) => { throw Object.assign(new Error(message), { status: 400 }); };
const string = (value: unknown, name: string, max = 2000): string => typeof value === 'string' && value.length > 0 && value.length <= max ? value : bad(`A valid ${name} is required.`);
const optional = (value: unknown, name: string) => value === undefined || value === null || value === '' ? undefined : string(value, name);
const object = (value: unknown, name: string): Body => value && typeof value === 'object' && !Array.isArray(value) ? value as Body : bad(`A valid ${name} is required.`);
const context = (body: Body) => ({ workspaceId: needId(body.workspaceId, 'workspace id'), sourceId: needId(body.sourceId, 'data source id') });

// Reuse account authentication and upstream errors, preserving the distinction
// between a stale edit (409) and a malformed request (400).
async function route(userId: number, run: () => Promise<unknown>) {
  let conflict: string | undefined;
  const response = await notionRoute(userId, 'linked Notion database', async () => {
    try { return await run(); }
    catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      conflict = (error as Error).message;
      return null;
    }
  });
  return conflict ? Response.json({ error: conflict, conflict: true }, { status: 409, headers: { 'cache-control': 'no-store' } }) : response;
}

export const GET: APIRoute = ({ url, locals }) => route(locals.user!.userId, async () => {
  const user = locals.user!.userId;
  const body = Object.fromEntries(url.searchParams);
  if (body.action === 'connection') return notionLinkedConnection(user);
  if (body.action === 'search') return notionLinkedSearch(user, body.q?.slice(0, 200) ?? '', optional(body.cursor, 'cursor'));
  if (body.action === 'users') return notionLinkedUsers(user, needId(body.workspaceId, 'workspace id'), optional(body.cursor, 'cursor'));
  const { workspaceId, sourceId } = context(body);
  if (body.action === 'source') return notionLinkedSource(user, workspaceId, sourceId);
  if (body.action === 'rows') return notionLinkedRows(user, workspaceId, sourceId, {
    ...(body.viewId ? { viewId: needId(body.viewId, 'view id') } : {}),
    cursor: optional(body.cursor, 'cursor'), queryId: optional(body.queryId, 'query id'),
    pageSize: Math.min(Math.max(Number(body.pageSize) || 50, 1), 100),
  });
  if (body.action === 'property') return notionLinkedProperty(user, workspaceId, sourceId, needId(body.pageId, 'page id'), string(body.propertyId, 'property id', 200));
  return bad('Unknown linked database action.');
});

async function bodyOf(request: Request) {
  // Notion itself limits requests to 500 KB. Reject before parsing a large draft.
  if (Number(request.headers.get('content-length')) > 500_000) bad('This edit exceeds Notion’s 500 KB request limit.');
  const reader = request.body?.getReader();
  if (!reader) return bad('A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 500_000) { await reader.cancel(); return bad('This edit exceeds Notion’s 500 KB request limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'JSON body'); }
  catch { return bad('A valid JSON body is required.'); }
}

export const PATCH: APIRoute = ({ request, locals }) => route(locals.user!.userId, async () => {
  const body = await bodyOf(request);
  const { workspaceId, sourceId } = context(body);
  if (body.action === 'view' || body.action === 'schema') {
    return notionLinkedUpdateDefinition(locals.user!.userId, workspaceId, sourceId, body.action, object(body.patch, 'patch'), object(body.original, 'original definition'), body.action === 'view' ? needId(body.viewId, 'view id') : undefined);
  }
  if (body.action !== undefined && body.action !== 'property') return bad('Unknown linked database action.');
  return notionLinkedUpdateProperty(locals.user!.userId, workspaceId, sourceId, needId(body.pageId, 'page id'), string(body.propertyId, 'property id', 200), body.value, object(body.original, 'original property') as LinkedNotionProperty);
});

export const POST: APIRoute = ({ request, locals }) => route(locals.user!.userId, async () => {
  const body = await bodyOf(request);
  const { workspaceId, sourceId } = context(body);
  if (body.action !== 'create') return bad('Unknown linked database action.');
  return notionLinkedCreate(locals.user!.userId, workspaceId, sourceId, object(body.properties, 'properties'));
});

export const DELETE: APIRoute = ({ request, locals }) => route(locals.user!.userId, async () => {
  const body = await bodyOf(request);
  const { workspaceId, sourceId } = context(body);
  if (body.action !== 'query') return bad('Only temporary query cleanup is supported.');
  await notionLinkedDeleteQuery(locals.user!.userId, workspaceId, sourceId, needId(body.viewId, 'view id'), string(body.queryId, 'query id'));
  return { ok: true };
});
