import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionIdFrom } from '../../../lib/wards.ts';
import { notionChecklistToggle, taskWardSource } from '../../../lib/notion.ts';
import { shareNotionPage, shareNotionWard } from '../../../lib/share-notion.ts';

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { ward?: string; done?: boolean } | null;
  const db = await taskWardSource(userId, body?.ward);
  const pageId = notionIdFrom(params.pageId); // never a raw path segment into the Notion URL
  if (!db || !pageId || typeof body?.done !== 'boolean') return Response.json({ error: 'bad body' }, { status: 400 });
  // A share ticks rows of its own lists only: the toggle would otherwise reach any page in the owner's workspace.
  if (locals.share && !(shareNotionWard(locals.share, body?.ward) && (await shareNotionPage(locals.share, userId, pageId)))) return Response.json({ error: 'not in this share' }, { status: 403 });
  try {
    await notionChecklistToggle(userId, db, pageId, body.done);
    return Response.json({ ok: true });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[checklist toggle]', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
