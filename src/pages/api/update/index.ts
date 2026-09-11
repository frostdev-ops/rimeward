import type { APIRoute } from 'astro';
import { updateState } from '../../../lib/updates.ts';

export const prerender = false;

/** The header chip's read: what is newer than this instance (server, and the
 *  desktop app when this runtime is one's), the policy and any install job.
 *  `?refresh=1` (admin) asks GitHub now instead of waiting out the 6 h cache. */
export const GET: APIRoute = async ({ url, locals }) =>
  Response.json(await updateState({ refresh: url.searchParams.has('refresh') && locals.user!.role === 'admin' }), { headers: { 'cache-control': 'no-store' } });
