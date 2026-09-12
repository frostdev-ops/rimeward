import type { APIRoute } from 'astro';
import { recentIncidents } from '../../../lib/status.ts';
import { shareStatusScope } from '../../../lib/shares.ts';

export const prerender = false;

/** The last 24h of down→up spans, one scan per status tick (cached). A share
 *  without an incidents ward sees only the services its wards show. */
export const GET: APIRoute = async ({ locals }) => {
  let spans = await recentIncidents();
  if (locals.share) {
    const scope = shareStatusScope(locals.share.wards);
    if (!scope.incidents) spans = spans.filter((s) => scope.services.has(s.service));
  }
  return Response.json({ hours: 24, spans }, { headers: { 'cache-control': 'no-store' } });
};
