import type { APIRoute } from 'astro';
import { agentConfigured, defaultAgentProvider, isAgentProvider, AGENT_PROVIDERS, DEFAULT_MODELS, PROVIDER_NAMES } from '../../../lib/agent/provider.ts';
import { agentWardConfig } from '../../../lib/agent/ward-config.ts';
import { syncRime } from '../../../lib/agent/sync.ts';
import { knownEndpoints, modelCatalog } from '../../../lib/agent/models.ts';

export const prerender = false;

/** Model ids for the config-dialog datalist, per provider (+ endpoint), with where
 *  the list came from; `endpoints` names every OpenAI-compatible endpoint the user
 *  can reach (local and, on a paired desktop, the server's). A compat request
 *  without an endpoint lists the endpoints and no models — the pairing is explicit.
 *  `?ward=<id>` (the chat footer's pickers) lists the ward's OWN route and adds
 *  `current`, the effective config that ward runs on — inherited defaults resolved. */
export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user?.userId;
  if (!user) return Response.json({error:'Sign in required.'},{status:401});
  await syncRime(user);
  const wardId = url.searchParams.get('ward');
  const current = wardId ? agentWardConfig(user, wardId) : null;
  if (wardId && !current) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  const raw = url.searchParams.get('provider') ?? current?.provider;
  const provider = raw === 'default' || !raw ? defaultAgentProvider(user) : raw;
  if (!isAgentProvider(provider)) return Response.json({ error: 'unknown provider' }, { status: 400 });
  const endpoints = knownEndpoints(user);
  const endpoint = url.searchParams.get('endpoint') || (provider === current?.provider ? current?.endpoint : undefined) || undefined;
  const shared = {
    endpoints,
    default: defaultAgentProvider(user),
    providers: AGENT_PROVIDERS.map((p) => ({ provider: p, name: PROVIDER_NAMES[p], configured: p === 'compat' ? endpoints.some((e) => agentConfigured(user, 'compat', e)) : agentConfigured(user, p), ...(DEFAULT_MODELS[p] ? { default: DEFAULT_MODELS[p] } : {}) })),
    ...(current ? { current: { provider: current.provider, ...(current.endpoint ? { endpoint: current.endpoint } : {}), model: current.model, effort: current.effort } } : {}),
  };
  const headers = { 'cache-control': 'no-store' };
  if (provider === 'compat' && !endpoint) return Response.json({ models: [], source: 'none', ...shared }, { headers });
  const catalog = await modelCatalog(user, provider, endpoint);
  if (!catalog.models.length && catalog.source === 'none') {
    return Response.json({ error: catalog.error ?? 'models unavailable', source: catalog.source, ...shared }, { status: catalog.configured ? 502 : 200, headers });
  }
  return Response.json({ models: catalog.models.map((m) => ({ id: m.id, name: m.name, ...(m.efforts?.length ? { efforts: m.efforts } : {}) })), source: catalog.source, fallback: catalog.source === 'fallback', ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}), ...shared }, { headers });
};
