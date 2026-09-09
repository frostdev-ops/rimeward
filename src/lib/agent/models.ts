import { CODEX_MODELS, DEFAULT_MODELS, PROVIDER_NAMES, AGENT_PROVIDERS, agentConfigured, isAgentProvider, type AgentProviderId } from './provider.ts';
import { listEndpoints } from './accounts.ts';
import { sharedCatalog, sharedCodexModels, sharedRime } from './sync.ts';
import { AGENT_EFFORTS, type AgentEffort } from '../wards.ts';
import type { ModelContext } from './context.ts';

// The model catalog, one shape over every provider: what the ward's ⚙ picker
// lists, what list_models browses, and what a selection (a ward's config, a
// child's spawn, set_model) is checked against. The lists themselves are the
// providers' own cached helpers (codex, openrouter, openai, compat) — this
// only fetches through them and says where the answer came from.

export interface CatalogModel {
  provider: AgentProviderId;
  endpoint?: string;
  id: string;
  name: string;
  /** Reasoning efforts the model accepts (codex reports them; others are unknown). */
  efforts?: string[];
  context?: ModelContext;
  /** Function calling: true/false when the catalog says, absent when it does not. */
  tools?: boolean;
  vision?: boolean;
  pricing?: { prompt: string; completion: string };
}

export interface Catalog {
  provider: AgentProviderId;
  endpoint?: string;
  configured: boolean;
  /** live = fetched within the hour · cache = the last good answer, older · fallback = the hand-kept list · none = nothing to show. */
  source: 'live' | 'cache' | 'fallback' | 'none';
  /** When the list was fetched, where the helper says. */
  fetchedAt?: string;
  models: CatalogModel[];
  error?: string;
}

/** The codex/openrouter helpers mark staleness on each model's context. */
const sourceOf = (models: { context?: ModelContext }[]): 'live' | 'cache' =>
  models.some((m) => m.context?.source === 'cache') ? 'cache' : 'live';
const stamp = (at: number) => (at ? { fetchedAt: new Date(at).toISOString() } : {});

/** One provider's models. Never throws: an unconfigured or unreachable provider
 *  is a catalog with `source` saying so. */
export async function modelCatalog(userId: number, provider: AgentProviderId, endpoint?: string | null): Promise<Catalog> {
  const ep = provider === 'compat' ? endpoint ?? undefined : undefined;
  const base = { provider, ...(ep ? { endpoint: ep } : {}), configured: agentConfigured(userId, provider, ep) };
  const tag = (models: Omit<CatalogModel, 'provider' | 'endpoint'>[]): CatalogModel[] => models.map((m) => ({ provider, ...(ep ? { endpoint: ep } : {}), ...m }));
  try {
    if (provider === 'codex') {
      const shared = await sharedCodexModels(userId);
      if (shared) return { ...base, source: sourceOf(shared), models: tag(shared) };
      if (!base.configured) return { ...base, source: 'fallback', models: tag(CODEX_MODELS.map((id) => ({ id, name: id }))) };
      const { listCodexModels } = await import('./codex.ts');
      const list = await listCodexModels(userId);
      return { ...base, source: sourceOf(list), models: tag(list) };
    }
    if (provider === 'openrouter') {
      const { listOpenRouterModels } = await import('./openrouter.ts');
      const list = await listOpenRouterModels();
      return { ...base, source: sourceOf(list), models: tag(list) };
    }
    if (provider === 'openai') {
      const shared = await sharedCatalog(userId, 'openai');
      if (shared) return { ...base, source: shared.source, ...(shared.fetchedAt ? { fetchedAt: shared.fetchedAt } : {}), models: tag(shared.models) };
      if (!base.configured) return { ...base, source: 'none', models: [], error: 'no OpenAI API key — Account → Agent' };
      const { listOpenAIModels } = await import('./codex.ts');
      const list = await listOpenAIModels(userId);
      return { ...base, source: list.source, ...stamp(list.at), models: tag(list.models) };
    }
    if (!ep) return { ...base, source: 'none', models: [], error: `name one of your endpoints: ${listEndpoints(userId).map((e) => e.name).join(', ') || '(none configured — Account → Agent)'}` };
    const shared = await sharedCatalog(userId, 'compat', ep);
    if (shared) return { ...base, source: shared.source, ...(shared.fetchedAt ? { fetchedAt: shared.fetchedAt } : {}), models: tag(shared.models) };
    if (!base.configured) return { ...base, source: 'none', models: [], error: `no endpoint "${ep}" — Account → Agent` };
    const { listCompatModels } = await import('./openrouter.ts');
    const list = await listCompatModels(userId, ep);
    return { ...base, source: list.source, ...stamp(list.at), models: tag(list.models) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (provider === 'codex') return { ...base, source: 'fallback', models: tag(CODEX_MODELS.map((id) => ({ id, name: id }))), error: message };
    return { ...base, source: 'none', models: [], error: message };
  }
}

export interface Browse {
  provider?: AgentProviderId;
  endpoint?: string;
  query?: string;
  cursor?: number;
  limit?: number;
}

/** Every OpenAI-compatible endpoint this user can reach: local rows and, on a
 *  paired desktop, the server's. */
export function knownEndpoints(userId: number): string[] {
  const shared = sharedRime(userId);
  return [...new Set([...listEndpoints(userId).map((e) => e.name), ...(shared?.online ? shared.endpoints ?? [] : [])])];
}

/** What list_models answers: the providers as they stand, then one page of
 *  models matching the query — every provider when none is named. */
export async function browseModels(userId: number, b: Browse) {
  const endpoints = knownEndpoints(userId);
  const providers = AGENT_PROVIDERS.map((p) => ({
    provider: p,
    name: PROVIDER_NAMES[p],
    configured: p === 'compat' ? endpoints.some((e) => agentConfigured(userId, 'compat', e)) : agentConfigured(userId, p),
    ...(p === 'compat' ? { endpoints } : {}),
    ...(DEFAULT_MODELS[p] ? { default: DEFAULT_MODELS[p] } : {}),
  }));
  const wanted: { provider: AgentProviderId; endpoint?: string }[] = b.provider
    ? b.provider === 'compat'
      ? (b.endpoint ? [b.endpoint] : endpoints).map((endpoint) => ({ provider: 'compat' as const, endpoint }))
      : [{ provider: b.provider }]
    : [...(['codex', 'openrouter', 'openai'] as const).map((provider) => ({ provider })), ...endpoints.map((endpoint) => ({ provider: 'compat' as const, endpoint }))];
  const catalogs = await Promise.all(wanted.filter((w) => w.provider === 'compat' || agentConfigured(userId, w.provider) || b.provider === w.provider).map((w) => modelCatalog(userId, w.provider, w.endpoint)));
  const q = (b.query ?? '').trim().toLowerCase();
  const all = catalogs.flatMap((c) => c.models).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  const cursor = Math.max(0, Math.floor(b.cursor ?? 0));
  const limit = Math.min(Math.max(1, Math.floor(b.limit ?? 25)), 100);
  const page = all.slice(cursor, cursor + limit);
  return {
    providers,
    sources: catalogs.map((c) => ({ provider: c.provider, ...(c.endpoint ? { endpoint: c.endpoint } : {}), source: c.source, ...(c.fetchedAt ? { fetchedAt: c.fetchedAt } : {}), ...(c.error ? { error: c.error } : {}) })),
    models: page,
    total: all.length,
    next: cursor + page.length,
    complete: cursor + page.length >= all.length,
  };
}

export interface Selection {
  provider: AgentProviderId;
  endpoint?: string;
  model: string;
  effort?: AgentEffort;
  /** The catalog could not be asked and the id was not seen — it is used as typed. */
  unverified?: boolean;
}

/**
 * Check a chosen provider/model before a run starts on it. An exact id the
 * catalog lists passes, as does one the catalog cannot vouch for (stale, the
 * hand-kept fallback, or none at all — a stale list is never authoritative, so
 * a newly valid id is used as typed and marked unverified); an id a LIVE
 * catalog does not know, a model without tool support, an effort the model
 * does not advertise, or an unconfigured provider is refused — nothing is ever
 * substituted. An inherited effort the model does not offer falls back to its
 * advertised default; the model id itself never changes.
 */
export async function validateSelection(userId: number, raw: { provider?: unknown; endpoint?: unknown; model?: unknown; effort?: unknown }, fallback: { provider: AgentProviderId; endpoint?: string; model: string; effort: AgentEffort }): Promise<Selection> {
  const provider = raw.provider === undefined || raw.provider === '' ? fallback.provider : raw.provider;
  if (!isAgentProvider(provider)) throw new Error(`provider must be one of ${AGENT_PROVIDERS.join(', ')}`);
  const endpoint = provider === 'compat' ? (typeof raw.endpoint === 'string' && raw.endpoint ? raw.endpoint : provider === fallback.provider ? fallback.endpoint : undefined) : undefined;
  if (provider === 'compat' && !endpoint) throw new Error(`name the endpoint: ${listEndpoints(userId).map((e) => e.name).join(', ') || '(none configured)'}`);
  if (!agentConfigured(userId, provider, endpoint)) throw new Error(`${PROVIDER_NAMES[provider]}${endpoint ? ` "${endpoint}"` : ''} is not configured — Account → Agent`);
  const typed = typeof raw.model === 'string' ? raw.model.trim() : '';
  const model = typed || (provider === fallback.provider && (endpoint ?? null) === (fallback.endpoint ?? null) ? fallback.model : DEFAULT_MODELS[provider]);
  if (!model) throw new Error(`${PROVIDER_NAMES[provider]} has no default model — name one (list_models)`);
  if (model.length > 100) throw new Error('model id too long');
  const explicit = raw.effort !== undefined && raw.effort !== '';
  let effort = explicit ? raw.effort : fallback.effort;
  if (!(AGENT_EFFORTS as readonly unknown[]).includes(effort)) throw new Error(`effort must be one of ${AGENT_EFFORTS.join(', ')}`);
  const catalog = await modelCatalog(userId, provider, endpoint);
  const known = catalog.models.find((m) => m.id === model);
  if (!known && catalog.source === 'live') {
    throw new Error(`${PROVIDER_NAMES[provider]}${endpoint ? ` "${endpoint}"` : ''} does not list a model "${model}" — list_models shows the exact ids`);
  }
  if (known?.tools === false) throw new Error(`"${model}" does not support tool calls — a Rime run needs them`);
  if (known?.efforts?.length && !known.efforts.includes(String(effort))) {
    if (explicit) throw new Error(`"${model}" offers efforts ${known.efforts.join(', ')} — not "${String(effort)}"`);
    effort = known.efforts.includes('medium') ? 'medium' : known.efforts[0]!;
  }
  return { provider, ...(endpoint ? { endpoint } : {}), model, effort: effort as AgentEffort, ...(known ? {} : { unverified: true }) };
}
