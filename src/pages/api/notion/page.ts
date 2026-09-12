import type { APIRoute } from 'astro';
import { jsonBody, needId, needStr, notionRoute } from '../../../lib/notion-route.ts';
import { notShared, shareNotionPage, shareNotionSource } from '../../../lib/share-notion.ts';
import {
  notionAddComment,
  notionArchive,
  notionBlocks,
  notionComments,
  notionCreatePage,
  notionPage,
  notionSetChrome,
  notionSourceSchema,
  notionUpdateProps,
} from '../../../lib/notion.ts';

export const prerender = false;

/** Everything a page ward renders, in one round trip. `parts` trims it for a
 *  fields-only ward that has no use for 300 blocks. */
export const GET: APIRoute = ({ url, locals }) =>
  notionRoute(locals.user!.userId, 'notion page', async () => {
    const userId = locals.user!.userId;
    const id = needId(url.searchParams.get('id'), 'page id');
    if (locals.share && !(await shareNotionPage(locals.share, userId, id))) throw notShared();
    const parts = new Set((url.searchParams.get('parts') ?? 'props,blocks,comments').split(','));
    const depth = Math.min(Math.max(Number(url.searchParams.get('depth')) || 3, 0), 4);

    const page = await notionPage(userId, id);
    const [blocks, comments, schema] = await Promise.all([
      parts.has('blocks') ? notionBlocks(userId, id, depth) : Promise.resolve([]),
      parts.has('comments') ? notionComments(userId, id).catch(() => []) : Promise.resolve([]),
      // A row's editors need the column options; a standalone page has none.
      page.meta.parentType === 'data_source_id' && parts.has('props')
        ? notionSourceSchema(userId, page.meta.parentId).catch(() => null)
        : Promise.resolve(null),
    ]);
    return { ...page, blocks, comments, schema };
  });

interface PatchBody {
  id?: string;
  props?: Record<string, unknown>;
  icon?: string;
  cover?: string;
  comment?: string;
  discussionId?: string;
}

/** Property writes, page chrome, and new comments — every mutation that
 *  belongs to the page itself rather than to one of its blocks. */
export const PATCH: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion page write', async () => {
    const userId = locals.user!.userId;
    const body = await jsonBody<PatchBody>(request);
    const id = needId(body.id, 'page id');
    if (locals.share && !(await shareNotionPage(locals.share, userId, id))) throw notShared();
    let skipped: string[] = [];
    if (body.props && Object.keys(body.props).length) {
      const page = await notionPage(userId, id);
      const schema =
        page.meta.parentType === 'data_source_id' ? await notionSourceSchema(userId, page.meta.parentId).catch(() => null) : null;
      ({ skipped } = await notionUpdateProps(userId, id, body.props, schema?.types));
    }
    if (body.icon !== undefined || body.cover !== undefined) {
      await notionSetChrome(userId, id, { ...(body.icon !== undefined ? { icon: body.icon } : {}), ...(body.cover !== undefined ? { cover: body.cover } : {}) });
    }
    if (body.comment) {
      await notionAddComment(userId, body.discussionId ? { discussionId: needId(body.discussionId, 'discussion id') } : { pageId: id }, body.comment.slice(0, 2000));
    }
    return { ok: true, skipped };
  });

interface PostBody {
  sourceId?: string;
  parentPageId?: string;
  props?: Record<string, unknown>;
  title?: string;
}

export const POST: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion page create', async () => {
    const body = await jsonBody<PostBody>(request);
    if (locals.share) {
      const owner = locals.user!.userId;
      const ok = body.sourceId ? await shareNotionSource(locals.share, owner, needId(body.sourceId, 'data source id')) : body.parentPageId ? await shareNotionPage(locals.share, owner, needId(body.parentPageId, 'page id')) : false;
      if (!ok) throw notShared();
    }
    if (body.sourceId) {
      const props = body.props && Object.keys(body.props).length ? body.props : { title: needStr(body.title, 'a title', 200) };
      return notionCreatePage(locals.user!.userId, { sourceId: needId(body.sourceId, 'data source id') }, props);
    }
    return notionCreatePage(locals.user!.userId, { pageId: needId(body.parentPageId, 'parent page id') }, {
      title: needStr(body.title, 'a title', 200),
    });
  });

/** Notion's trash, not a hard delete — `?restore=1` puts it back. */
export const DELETE: APIRoute = ({ url, locals }) =>
  notionRoute(locals.user!.userId, 'notion page archive', async () => {
    const id = needId(url.searchParams.get('id'), 'page id');
    await notionArchive(locals.user!.userId, id, url.searchParams.get('restore') !== '1');
    return { ok: true };
  });
