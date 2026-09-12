import type { APIRoute } from 'astro';
import { jsonBody, needId, notionRoute } from '../../../lib/notion-route.ts';
import { notionAppendBlocks, notionDeleteBlock, notionUpdateBlock, type BlockDraft } from '../../../lib/notion.ts';
import { isWritable } from '../../../lib/notion-blocks.ts';
import { notShared, shareNotionBlock, shareNotionPage } from '../../../lib/share-notion.ts';

export const prerender = false;

/** The codec rejects unknown types, but checking here keeps the 400 honest
 *  (a bad type is the caller's mistake, not an upstream failure). */
function draft(raw: unknown): BlockDraft {
  const o = (raw ?? {}) as Record<string, unknown>;
  const type = String(o.type ?? 'paragraph');
  if (!isWritable(type)) throw Object.assign(new Error(`block type "${type}" cannot be created here`), { status: 400 });
  return {
    type,
    text: typeof o.text === 'string' ? o.text.slice(0, 2000) : '',
    ...(typeof o.checked === 'boolean' ? { checked: o.checked } : {}),
    ...(typeof o.language === 'string' ? { language: o.language.slice(0, 40) } : {}),
    ...(typeof o.url === 'string' ? { url: o.url.slice(0, 2000) } : {}),
    ...(typeof o.icon === 'string' ? { icon: o.icon.slice(0, 8) } : {}),
    ...(typeof o.color === 'string' ? { color: o.color.slice(0, 40) } : {}),
  };
}

interface PostBody {
  parentId?: string;
  after?: string;
  blocks?: unknown[];
}

export const POST: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion block append', async () => {
    const body = await jsonBody<PostBody>(request);
    const parentId = needId(body.parentId, 'parent id');
    if (locals.share && !(await shareNotionPage(locals.share, locals.user!.userId, parentId)) && !(await shareNotionBlock(locals.share, locals.user!.userId, parentId))) throw notShared();
    const drafts = (Array.isArray(body.blocks) ? body.blocks : []).slice(0, 50).map(draft);
    if (!drafts.length) throw Object.assign(new Error('nothing to add'), { status: 400 });
    return { blocks: await notionAppendBlocks(locals.user!.userId, parentId, drafts, body.after ? needId(body.after, 'anchor id') : undefined) };
  });

export const PATCH: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion block update', async () => {
    const body = await jsonBody<{ id?: string; block?: unknown }>(request);
    const id = needId(body.id, 'block id');
    if (locals.share && !(await shareNotionBlock(locals.share, locals.user!.userId, id))) throw notShared();
    return { block: await notionUpdateBlock(locals.user!.userId, id, draft(body.block)) };
  });

export const DELETE: APIRoute = ({ url, locals }) =>
  notionRoute(locals.user!.userId, 'notion block delete', async () => {
    const id = needId(url.searchParams.get('id'), 'block id');
    if (locals.share && !(await shareNotionBlock(locals.share, locals.user!.userId, id))) throw notShared();
    await notionDeleteBlock(locals.user!.userId, id);
    return { ok: true };
  });
