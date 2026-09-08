import type { APIRoute } from 'astro';
import { readWardContext, validateWardMentions } from '../../lib/agent/ward-context.ts';

export const prerender = false;

// ?ward= uses the same authenticated instance routing as the ward itself.
export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const [ward] = validateWardMentions(locals.user!.userId, [url.searchParams.get('ward')]);
    return Response.json(await readWardContext(locals.user!.userId, ward!, url.searchParams.get('agent') ?? ''), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Ward unavailable' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
};
