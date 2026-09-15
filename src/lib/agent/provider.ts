import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../settings.ts';
import { isDesktop } from '../dev/runtime.ts';
import { installationId, profileId } from './sync-store.ts';
import { sharedRime, sharedModel, sharedCodexModels, sharedCatalog } from './sync.ts';
import { credentialId, isRemotePin, localProviderPresent, parseRemotePin, resolveProviderRoute, routePolicy, routeReceipt, serverOffers,
  type ProviderRouteReceipt, type ResolvedProviderRoute } from './route.ts';
import type { ModelContext } from './context.ts';
import type { ThinkingProgress } from './stream.ts';
import { AGENT_PROVIDERS, isAgentProvider, type AgentProviderId } from '../wards.ts';

// The provider contract. Two wire DIALECTS, one interface: the Responses API
// (items replayed verbatim, encrypted reasoning included — codex and the OpenAI
// API) and chat completions (openrouter via @openrouter/sdk, and any
// OpenAI-compatible endpoint the user names). A conversation is PINNED to the
// provider it started on (agent_conversations.provider/endpoint) and its
// dialect (agent_conversations.dialect) — there is no cross-protocol
// failover, because each dialect's stored items are opaque to the other. An
// outage surfaces as an error + agent_last_error:<uid>.

export { AGENT_PROVIDERS, isAgentProvider, type AgentProviderId };
/** The wire dialect, named after the first provider that spoke it (the value
 *  agent_conversations.dialect stores). */
export type Dialect = 'codex' | 'openrouter';
export const dialectOf = (p: AgentProviderId): Dialect => (p === 'openrouter' || p === 'compat' ? 'openrouter' : 'codex');
/** One string for a provider + endpoint — what caches and measurements hang on. */
export const routeId = (p: AgentProviderId, endpoint?: string | null): string => (p === 'compat' ? `compat:${endpoint ?? ''}` : p);
export const providerDialect = (p: { id: AgentProviderId; dialect?: Dialect }): Dialect => p.dialect ?? dialectOf(p.id);
export const PROVIDER_NAMES: Record<AgentProviderId, string> = { codex: 'ChatGPT (codex)', openrouter: 'OpenRouter', openai: 'OpenAI API', compat: 'OpenAI-compatible endpoint' };

export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Raw text on capable Responses models; parameters retain the JSON fallback. */
  inputFormat?: 'text';
}

export interface AgentToolCall {
  call_id: string;
  name: string;
  /** JSON for function calls; exact input text when type is custom. */
  arguments: string;
  type?: 'custom';
}

export interface ProviderCall {
  userId: number;
  model: string;
  effort?: string;
  /** A child run's call — the relay keeps one slot free for the foreground. */
  child?: boolean;
  /** provider 'compat': the endpoint the call is bound to (set by the provider, rides the relay). */
  endpoint?: string;
  /** provider 'compat': the BACKEND this thread was admitted on (a normalized base URL). An endpoint
   *  NAME is a per-runtime alias that can be repointed mid-thread; when this is set the call is refused
   *  unless the name still resolves to exactly it, and it is never relayed to another runtime. Checked
   *  where the request is built, so nothing can change between the check and the send.
   *  A value prefixed `server:` means the CONNECTED SERVER's backend for that name (route.ts); such a
   *  thread is never dispatched locally, however equal the alias. */
  backend?: string;
  /** provider 'compat', relayed: the backend the SERVER attested for this endpoint name. Sent with the
   *  relayed call so the server re-checks identity where it builds the outgoing request. */
  remoteBackend?: string;
  /** The non-secret credential GENERATION this call was admitted against (route.ts credentialId).
   *  Carried into header construction and into the 401 retry, so a reconnect to another account
   *  between rounds - or between a 401 and its retry - stops the call instead of billing the new one. */
  credential?: string;
  /** Which route served this call and why - recorded with the call, never a credential. */
  route?: ProviderRouteReceipt;
  instructions: string;
  items: unknown[];
  tools: AgentToolSpec[];
  /** Routes prompt caching: requests sharing a key land on the same cache.
   *  One per conversation — that is the unit whose prefix repeats. */
  cacheKey?: string;
  /** An interrupt (core.interruptTurn) aborts the call in flight through this. */
  signal?: AbortSignal;
  onProgress?: () => void;
  onThinking?: (progress: ThinkingProgress) => void;
  /** Display-only text; replay and tools use the completed result. */
  onTextDelta?: (delta: string) => void;
  /** Native relay calls retain metadata only and never retry uncertain inference. */
  relayRequestId?: string;
}

export interface ProviderResult {
  text: string;
  calls: AgentToolCall[];
  /** Raw wire items — appended verbatim to the stored conversation. */
  items: unknown[];
  /** Prompt tokens billed, and how many of them the provider served from cache. */
  usage?: { input: number; cached?: number; cacheWrite?: number; output?: number };
}

/** The status line for a successful call — the cache hit rate is the one
 *  number that says whether the prompt is laid out right. */
export function usageLine(usage?: ProviderResult['usage']): string {
  if (!usage) return 'ok';
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `ok · ${k(usage.input)} in, ${usage.cached === undefined ? 'cache read unreported' : `${k(usage.cached)} cached (${usage.input ? Math.round((100 * usage.cached) / usage.input) : 0}%)`}${usage.cacheWrite === undefined ? '' : `, ${k(usage.cacheWrite)} cache write`}`;
}

export interface AgentProvider {
  id: AgentProviderId;
  /** The inference route this instance is pinned to, once resolved. One provider object per turn,
   *  voice session or one-shot, so every round of a tool loop is billed to the same installation. */
  readonly route?: ResolvedProviderRoute;
  /** Absent on a bare test double: the id's own dialect then. */
  dialect?: Dialect;
  /** compat only: the endpoint this instance is bound to. */
  endpoint?: string;
  context?(userId: number, model: string): Promise<ModelContext | undefined>;
  run(call: ProviderCall): Promise<ProviderResult>;
  /** Wire-shape user message / tool result for this protocol. */
  userItem(text: string): unknown;
  toolOutputItem(callId: string, json: string, type?: AgentToolCall['type']): unknown;
  /**
   * Per-protocol pairToolCalls repair — MANDATORY before every model call.
   * Synthesizes an "interrupted" output for any unanswered call (except those
   * in keepOpen — a parked confirm is unanswered on purpose) and drops any
   * output whose call is missing; either half missing kills the whole thread.
   */
  repairItems(items: unknown[], keepOpen: Set<string>): unknown[];
}

/** Worth one quiet retry: rate limits, upstream 5xx, timeouts, dropped sockets. */
export function isTransient(err: Error): boolean {
  return /\b(429|500|502|503|504)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(
    err.message
  );
}

// ---------------------------------------------------------------- status

export interface ProviderStatus {
  ok: boolean;
  reason: string;
  at: string;
}

/** Last call result per provider, plus a sticky last-error (a later success
 *  must not erase the evidence of a failure the user should know about). */
export function recordAgentStatus(userId: number, provider: AgentProviderId, ok: boolean, reason: string): void {
  let all: Record<string, ProviderStatus> = {};
  try {
    all = JSON.parse(getSetting(`agent_status:${userId}`) ?? '{}');
  } catch {}
  const at = new Date().toISOString();
  all[provider] = { ok, reason: reason.slice(0, 300), at };
  setSetting(`agent_status:${userId}`, JSON.stringify(all));
  if (!ok) {
    setSetting(`agent_last_error:${userId}`, JSON.stringify({ provider, reason: reason.slice(0, 300), at }));
    console.error(`[agent] ${provider} failed for user ${userId}: ${reason}`);
  } else if (reason !== 'ok') {
    console.log(`[agent] ${provider} user ${userId}: ${reason}`); // the cache evidence, greppable in pm2 logs
  }
}

export function agentStatus(userId: number): Record<string, ProviderStatus> {
  try {
    return JSON.parse(getSetting(`agent_status:${userId}`) ?? '{}');
  } catch {
    return {};
  }
}

export function agentLastError(userId: number): { provider: string; reason: string; at: string } | null {
  try {
    const raw = getSetting(`agent_last_error:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- config

export { AGENT_EFFORTS, type AgentEffort } from '../wards.ts';

/** Tool rounds one turn may take before it parks itself with a "continue"
 *  prompt. Per user, 1..∞ — 0 means no cap at all. Lives here, not in core.ts,
 *  so the account page can read it without pulling in the tool registry. */
export const ROUND_DEFAULT = 24;

/** One parse, shared by the stored setting and the form that writes it.
 *  Returns null for anything that is not a whole count — critically for the
 *  EMPTY string, which Number() would turn into 0, and 0 is the sentinel for
 *  "no cap at all". A cleared field must never be able to uncap the agent. */
export function parseRounds(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Math.floor(Number(text));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function agentRounds(userId: number): number {
  return parseRounds(getSetting(`agent_rounds:${userId}`)) ?? ROUND_DEFAULT;
}

/** '' = no default: the OpenAI API and a custom endpoint list their own models
 *  and a run must name one (list_models / the ward's ⚙) — nothing is invented. */
export const DEFAULT_MODELS: Record<AgentProviderId, string> = {
  codex: 'gpt-5.6-sol',
  openrouter: 'anthropic/claude-sonnet-5',
  openai: '',
  compat: '',
};

/** The config dialog's suggestions when the ChatGPT backend cannot be asked
 *  (no account linked yet, or its model list is down — codex.ts
 *  listCodexModels is the live source). The model field stays free text, so an
 *  id missing from here still works if you type it. */
export const CODEX_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'];

/** Can a run on this provider actually be admitted HERE, under the account's route preference? The
 *  server half needs the server reachable (not merely a healthy sync), and "this runtime only" never
 *  counts a server credential as configured. */
export function agentConfigured(userId: number, provider: AgentProviderId, endpoint?: string | null): boolean {
  const policy = routePolicy(userId);
  const shared = policy === 'runtime' ? null : sharedRime(userId);
  // Reachable AND answering as the account we are joined to: capabilities stored from another
  // profile describe a connection we do not have, and must not count as configured.
  if (shared?.reachable && shared.authority !== false && serverOffers(shared, provider, endpoint)) return true;
  if (policy === 'server') return false;
  return localProviderPresent(userId, provider, endpoint);
}

export function defaultAgentProvider(userId: number): AgentProviderId {
  // A runtime-only ward does not inherit the server's provider default: that default names a
  // credential this runtime is not allowed to use.
  const preferred = routePolicy(userId) === 'runtime' ? undefined : sharedRime(userId)?.config.provider;
  if (isAgentProvider(preferred) && preferred !== 'compat') return preferred;
  for (const p of ['codex', 'openrouter', 'openai'] as const) if (agentConfigured(userId, p)) return p;
  return 'openrouter';
}

/** On a paired desktop, child runs share three relay slots and WAIT for one
 *  rather than being refused — the server keeps its fourth for the foreground. */
const CHILD_SLOTS = 3;
let childSlotsBusy = 0;
const childSlotQueue: (() => void)[] = [];
/** A cancelled call leaves the queue and never reaches inference. */
async function withChildSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('interrupted before the model call');
  if (childSlotsBusy >= CHILD_SLOTS) {
    await new Promise<void>((resolve, reject) => {
      const grant = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { const i = childSlotQueue.indexOf(grant); if (i >= 0) childSlotQueue.splice(i, 1); reject(new Error('interrupted while waiting for a model slot')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      childSlotQueue.push(grant);
    });
  }
  childSlotsBusy++;
  let released = false;
  const release = () => { if (!released) { released = true; childSlotsBusy--; childSlotQueue.shift()?.(); } };
  signal?.addEventListener('abort', release, { once: true });
  try {
    if (signal?.aborted) throw new Error('interrupted before the model call');
    return await fn();
  } finally { signal?.removeEventListener('abort', release); release(); }
}

/** Enforce the lifetime independently of SDK/fetch cancellation. Late output cannot re-enter a turn. */
export async function runModel(provider: AgentProvider, call: ProviderCall): Promise<ProviderResult> {
  call.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
  const timeoutMs = !isDesktop() && provider.id === 'openrouter' ? 120_000 : 330_000;
  const timer = setTimeout(() => controller.abort(new DOMException('Model response timed out.', 'TimeoutError')), timeoutMs);
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  let active = true;
  const record: Record<string, unknown> = { id: call.relayRequestId ?? crypto.randomUUID(), provider: provider.id, model: call.model, conversation: call.cacheKey, startedAt: Date.now(), state: 'running',
    // The route receipt rides the existing bounded call record - requested policy and actual source,
    // no credentials, no prompts.
    ...(call.route ? { route: call.route } : {}), ...(call.endpoint ? { endpoint: call.endpoint } : {}) };
  record.instructionsHash = createHash('sha256').update(call.instructions).digest('hex');
  record.toolsHash = createHash('sha256').update(JSON.stringify(call.tools)).digest('hex');
  const startedAt = Date.now();
  const save = () => {
    try {
      const route = call.route ?? (provider.route ? routeReceipt(provider.route) : undefined);
      if (route) record.route = route;
      const key = `agent_model_calls:${call.userId}`;
      const rows = JSON.parse(getSetting(key) ?? '[]');
      setSetting(key, JSON.stringify([...(Array.isArray(rows) ? rows.filter(r => r.id !== record.id).slice(-39) : []), record]));
    } catch { /* Diagnostic metadata must never block a model call. */ }
  };
  save();
  try {
    const result = await Promise.race([provider.run({
      ...call, signal,
      onTextDelta: delta => { if (active && !signal.aborted) { record.firstTextMs ??= Date.now() - startedAt; call.onTextDelta?.(delta); } },
      onProgress: () => { if (active && !signal.aborted) call.onProgress?.(); },
      onThinking: progress => { if (active && !signal.aborted) { record.firstThinkingMs ??= Date.now() - startedAt; record.thinking = { tokens: progress.tokens, estimated: progress.estimated }; call.onThinking?.(progress); } },
    }), cancelled]);
    record.state = 'completed';
    record.usage = result.usage;
    return result;
  } catch (error) {
    record.state = call.signal?.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'failed';
    throw error;
  } finally {
    active = false;
    record.durationMs = Date.now() - startedAt;
    save();
    clearTimeout(timer);
    signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}

/**
 * One provider instance, pinned to ONE inference route. Pass the route when the caller already
 * resolved it (a turn stamps its conversation before the first call); otherwise it is resolved on
 * first use and then frozen for the life of this object - so a tool loop, its compaction and a
 * child run cannot each pick a different installation.
 */
export async function getProvider(id: AgentProviderId, endpoint?: string | null, pinned?: ResolvedProviderRoute): Promise<AgentProvider> {
  // Dynamic so a request that never chats (status ticks, watchers sweeping an
  // empty table) doesn't load the SDK or the codex machinery.
  const provider = await (id === 'codex' || id === 'openai'
    ? import('./codex.ts').then((m) => (id === 'codex' ? m.codexProvider : m.openaiProvider))
    : import('./openrouter.ts').then((m) => (id === 'openrouter' ? m.openrouterProvider : m.compatProvider(endpoint ?? ''))));
  let resolved = pinned;
  const routeFor = async (userId: number) => (resolved ??= await resolveProviderRoute(userId, id, endpoint));
  const name = () => `${PROVIDER_NAMES[id]}${endpoint ? ` "${endpoint}"` : ''}`;
  return {
    ...provider,
    get route() { return resolved; },
    // The bound endpoint rides the typed call, so a server-only endpoint is
    // offered to the relay and a local one reaches the local provider.
    run: async(call) => {
      const route = await routeFor(call.userId);
      // Nothing is sent under a route that cannot honour what this conversation recorded.
      if (route.blocked) throw new Error(route.blocked);
      if (call.credential && route.via === 'local' && call.credential !== route.credential)
        throw new Error('The admitted provider connection changed before dispatch; nothing was sent on the replacement.');
      // The RECORDED constraint outranks the route, and a disagreement is refused rather than
      // reconciled. Today's attestation is never substituted for a pin the thread already holds.
      if (call.backend) {
        const pin = parseRemotePin(call.backend);
        const servedHere = pin && pin.runtime === installationId() && pin.profile === profileId(call.userId) && !!pin.url;
        if (pin && route.via !== 'server' && !servedHere)
          throw new Error(`This conversation was admitted on a connected server's "${call.endpoint ?? provider.endpoint ?? ''}" endpoint. A local endpoint of the same name is a different backend, so nothing was sent to it.`);
        if (pin && route.server && (route.server.profile !== pin.profile || route.server.runtime !== pin.runtime))
          throw new Error('This conversation was admitted on a different server account than the one connected now. Nothing was sent to it.');
        if (!pin && route.via !== 'local')
          throw new Error(`This conversation was admitted on this runtime's own "${call.endpoint ?? provider.endpoint ?? ''}" endpoint, so its context is not sent to the connected server. Set Model access to this runtime for it, or start a new chat on the server's endpoint.`);
      }
      // The pin this call must be served under: the one the thread recorded, else this route's own.
      // The url half is the only part the relay sends; an empty one means the server attested none,
      // and an unattested pin is carried as "remote, identity not established" rather than invented.
      const attested = parseRemotePin(call.backend && isRemotePin(call.backend) ? call.backend : route.remoteBackend ?? '')?.url || undefined;
      const routed: ProviderCall = { ...call, ...(provider.endpoint ? { endpoint: provider.endpoint } : {}), route: routeReceipt(route),
        ...(route.via === 'server' && attested ? { remoteBackend: attested } : {}),
        ...(route.via === 'local' && route.credential ? { credential: route.credential } : {}) };
      if (route.via === 'local' && call.backend && isRemotePin(call.backend))
        routed.backend = parseRemotePin(call.backend)!.url;
      const go = async () => {
        if (route.via === 'server') {
          const result = await sharedModel(call.userId, id, routed, route);
          if (result) return result;
          // The route was fixed when this turn was admitted. A server that has since gone away is a
          // failure, never a quiet switch to another account's credential.
          throw new Error(`${name()} runs on the connected server${route.server ? ` (${route.server.host})` : ''} for this conversation, and it is not available. Nothing was sent anywhere else. ${route.policy === 'server' ? 'Change Model access on the provider page to use this runtime.' : 'Try again when it is reachable, or connect this provider here.'}`);
        }
        // The credential generation this turn was admitted against must still be the one here: a
        // reconnect between tool rounds is a stop, not a change of billing account.
        if (route.credential !== undefined) {
          const now = credentialId(call.userId, id, provider.endpoint ?? endpoint ?? null);
          if (now !== route.credential)
            throw new Error(`The ${name()} connection on this runtime changed while this turn was running. Nothing was sent to the replacement — send the message again to use it.`);
        }
        // Absence was compared too. The concrete provider reports a missing credential; keeping
        // that responsibility there also preserves injectable/offline providers without weakening
        // the check against credentials appearing after this turn's admission.
        return provider.run(routed);
      };
      return call.child && isDesktop() ? withChildSlot(go, call.signal) : go();
    },
    context: async(user, model) => {
      const route = await routeFor(user);
      if (route.blocked) return undefined;
      // A source-bound answer: a server route reads the server's catalog and nothing else, and a
      // runtime-only route never reads it at all. A cached remote list is not evidence that a local
      // credential can serve a model.
      if (route.via === 'server') {
        const shared = id === 'codex' ? await sharedCodexModels(user, route) : await sharedCatalog(user, id, endpoint, route);
        return shared?.models.find((m) => m.id === model)?.context;
      }
      if (route.credential !== credentialId(user, id, endpoint)) throw Error('Provider connection changed during context lookup.');
      const context = await provider.context?.(user, model);
      if (route.credential !== credentialId(user, id, endpoint)) throw Error('Provider connection changed during context lookup.');
      return context;
    },
  };
}
