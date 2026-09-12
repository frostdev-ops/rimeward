import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionChecklist, notionChecklistAdd, taskWardSource } from '../../../lib/notion.ts';
import { shareNotionWard } from '../../../lib/share-notion.ts';

export const prerender = false;

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  const ward = url.searchParams.get('ward');
  const db = await taskWardSource(userId, ward);
  // No db yet is a normal state for a fresh ward — the ward shows a picker,
  // not the "Connect Notion" chip a 404 would produce.
  if (!db) return Response.json({ needsConfig: true }, { headers: { 'cache-control': 'no-store' } });
  try {
    return Response.json({ items: await notionChecklist(userId, db) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[checklist]', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { ward?: string; title?: string; due?: string } | null;
  if (locals.share && !shareNotionWard(locals.share, body?.ward)) return Response.json({ error: 'not in this share' }, { status: 403 });
  const db = await taskWardSource(userId, body?.ward);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const due = typeof body?.due === 'string' && DUE_RE.test(body.due) ? body.due : undefined;
  if (!db || !title) return Response.json({ error: 'bad item' }, { status: 400 });
  try {
    await notionChecklistAdd(userId, db, title, due);
    return Response.json({ ok: true });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[checklist add]', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
