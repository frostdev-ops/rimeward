import type { APIRoute } from 'astro';
import { defaultAgentProvider, isAgentProvider } from '../../../lib/agent/provider.ts';
import { syncRime } from '../../../lib/agent/sync.ts';
import { knownEndpoints, modelCatalog } from '../../../lib/agent/models.ts';

export const prerender = false;

/** Model ids for the config-dialog datalist, per provider (+ endpoint), with where
 *  the list came from; `endpoints` names every OpenAI-compatible endpoint the user
 *  can reach (local and, on a paired desktop, the server's). A compat request
 *  without an endpoint lists the endpoints and no models — the pairing is explicit. */
export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user?.userId;
  if (!user) return Response.json({error:'Sign in required.'},{status:401});
  await syncRime(user);
  const raw = url.searchParams.get('provider');
  const provider = raw === 'default' || !raw ? defaultAgentProvider(user) : raw;
  if (!isAgentProvider(provider)) return Response.json({ error: 'unknown provider' }, { status: 400 });
  const endpoints = knownEndpoints(user);
  const endpoint = url.searchParams.get('endpoint') || undefined;
  if (provider === 'compat' && !endpoint) return Response.json({ models: [], endpoints, source: 'none' }, { headers: { 'cache-control': 'no-store' } });
  const catalog = await modelCatalog(user, provider, endpoint);
  if (!catalog.models.length && catalog.source === 'none') {
    return Response.json({ error: catalog.error ?? 'models unavailable', endpoints, source: catalog.source }, { status: catalog.configured ? 502 : 200, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json({ models: catalog.models.map((m) => ({ id: m.id, name: m.name })), source: catalog.source, fallback: catalog.source === 'fallback', endpoints, ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}) }, { headers: { 'cache-control': 'no-store' } });
};
