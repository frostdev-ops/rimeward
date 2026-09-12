import type { APIRoute } from 'astro';
import { buildInfo, getSnapshot } from '../../../lib/status.ts';
import { shareSnapshot } from '../../../lib/shares.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const snap = getSnapshot();
  if (!snap) return Response.json({ error: 'warming up' }, { status: 503, headers: { 'retry-after': '5' } });
  // A share sees the services its wards show and nothing about the deploy.
  if (locals.share) return Response.json(shareSnapshot(snap, locals.share.wards), { headers: { 'cache-control': 'no-store' } });
  return Response.json({ ...snap, build: buildInfo() }, { headers: { 'cache-control': 'no-store' } });
};
