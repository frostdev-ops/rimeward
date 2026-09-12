import type { APIRoute } from 'astro';
import { getHistory } from '../../../lib/status.ts';
import { TARGETS } from '../../../lib/targets.ts';
import { HOST_SERVICE_IDS } from '../../../lib/wards.ts';
import { shareStatusScope } from '../../../lib/shares.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const service = url.searchParams.get('service') ?? '';
  const known = TARGETS.some((t) => t.id === service) || (HOST_SERVICE_IDS as readonly string[]).includes(service);
  if (!known) return Response.json({ error: 'unknown service' }, { status: 404 });
  if (locals.share) {
    const scope = shareStatusScope(locals.share.wards);
    if (!(scope.services.has(service) || (scope.host && service.startsWith('host:')))) return Response.json({ error: 'unknown service' }, { status: 404 });
  }
  const hours = Number(url.searchParams.get('hours') ?? '24') || 24;
  return Response.json(getHistory(service, hours), { headers: { 'cache-control': 'no-store' } });
};
