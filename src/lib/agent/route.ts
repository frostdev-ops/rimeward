import { getSetting, setSetting, deleteSetting } from '../settings.ts';
import { isDesktop } from '../dev/runtime.ts';
import { rimeConnection } from '../dev/remote.ts';
import { sharedRime } from './sync.ts';
import { credentialGeneration, agentKey, endpointOf, endpointUrlOf, getAgentAccount } from './accounts.ts';
import type { AgentProviderId } from '../wards.ts';
import { installationId, profileId } from './sync-store.ts';

// WHERE an AI request is served, decided once and carried.
//
// Three identities stay separate everywhere below: the ACCOUNT whose credential a form writes, the
// RUN OWNER that coordinates a conversation (lib/dev/agent-placement.ts — never the viewing browser),
// and the INFERENCE ROUTE, which is what this module resolves.
//
// Two rules give the whole thing its meaning:
//
//   1. A constraint a conversation RECORDED outranks today's preference. A thread admitted on a local
//      backend is never relayed, and a thread admitted on a server's backend is never served locally,
//      whatever the policy says now. Where the two disagree the turn is REFUSED, never redirected.
//   2. A resolved route is immutable. A turn, a child of that turn, its compaction, a voice session
//      and a one-shot each resolve once and keep that answer — including the credential generation
//      it resolved against, so a reconnect between tool rounds stops the turn instead of moving the
//      bill to another account.

export const ROUTE_POLICIES = ['automatic', 'runtime', 'server'] as const;
export type ProviderRoutePolicy = (typeof ROUTE_POLICIES)[number];
export const ROUTE_POLICY_NAMES: Record<ProviderRoutePolicy, string> = {
  automatic: 'Automatic — connected server preferred',
  runtime: 'This runtime only',
  server: 'Connected server only',
};

/**
 * A compat backend that belongs to a CONNECTED SERVER, written `server:<profile>:<url>`.
 *
 * The profile is the serving installation's own identity: two servers can both call an endpoint
 * `http://localhost:11434/v1` and they are not the same backend, so a URL alone can never be the
 * pin. The url half is empty when that server attested none (an older peer) — such a thread stays
 * server-only and is refused for continuation rather than being credited with an identity nobody
 * verified.
 */
export const REMOTE_BACKEND = 'server:';
const PROFILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const remotePin = (runtime: string, profile: string, url: string) => `${REMOTE_BACKEND}${runtime}:${profile}:${url}`;
export const isRemotePin = (value: string | null | undefined): boolean => !!value?.startsWith(REMOTE_BACKEND);
/** null when the value is not a remote pin AT ALL; `profile: ''` when it is one this build cannot
 *  read (a shape from before the profile was part of it) — unknown, and therefore never dispatched. */
export function parseRemotePin(value: string): { runtime: string; profile: string; url: string } | null {
  if (!value.startsWith(REMOTE_BACKEND)) return null;
  const rest = value.slice(REMOTE_BACKEND.length), cut = rest.indexOf(':');
  const runtime = rest.slice(0, cut), tail = rest.slice(cut + 1), split = tail.indexOf(':');
  const profile = tail.slice(0, split);
  return cut > 0 && split > 0 && PROFILE_RE.test(runtime) && PROFILE_RE.test(profile)
    ? { runtime, profile, url: tail.slice(split + 1) } : { runtime: '', profile: '', url: '' };
}

export interface ProviderServerRef {
  /** The designated pairing — never "whichever pair is first". */
  id: string;
  host: string;
  profile: string;
  runtime: string;
}
export interface ResolvedProviderRoute {
  via: 'local' | 'server';
  policy: ProviderRoutePolicy;
  /** Why, in the words the composer and the receipts show. */
  reason: string;
  server?: ProviderServerRef;
  /** compat via a server: the pin this call must be served under, `server:<profile>:<url>`. */
  remoteBackend?: string;
  /** via local: a non-secret generation for the credential this route resolved against. Re-checked
   *  immediately before every dispatch, so a reconnect mid-turn stops the turn. */
  credential?: string | null;
  /** via server: the same, for the SERVER's provider account, as that server reported it. Sent with
   *  every relayed call and verified there — an account replaced on the server between rounds stops
   *  the turn instead of billing the replacement. Absent against a server too old to report one. */
  serverCredential?: string;
  /** Set when no route can honour the conversation's recorded constraint. Dispatch raises it; a
   *  read-only surface shows it. Nothing is ever sent under a blocked route. */
  blocked?: string;
  at: number;
}
/** What a call records: the requested policy and what actually served it. No credentials. */
export interface ProviderRouteReceipt {
  policy: ProviderRoutePolicy;
  via: 'local' | 'server';
  server?: string;
  profile?: string;
  runtime?: string;
  reason: string;
}

const policyKey = (user: number) => `agent_route_policy:${user}`;
export const isRoutePolicy = (v: unknown): v is ProviderRoutePolicy => (ROUTE_POLICIES as readonly unknown[]).includes(v);
/** Stored at the RUN-OWNING runtime, never synced: "this runtime only" names nothing on another
 *  installation. A runtime with no server to prefer has nothing to choose between, so a value left
 *  behind by an import cannot make a server refuse its own providers. */
export function routePolicy(user: number): ProviderRoutePolicy {
  if (!isDesktop()) return 'automatic';
  const raw = getSetting(policyKey(user));
  return isRoutePolicy(raw) ? raw : 'automatic';
}
export function setRoutePolicy(user: number, policy: ProviderRoutePolicy): void {
  setSetting(policyKey(user), policy);
}

type Shared = NonNullable<ReturnType<typeof sharedRime>>;
/** Does the connected server offer this provider — from the capabilities it last reported. Only
 *  meaningful together with `reachable`, which is what says those capabilities still describe the
 *  connection we actually have. */
export function serverOffers(shared: Shared | null, provider: AgentProviderId, endpoint?: string | null): boolean {
  if (!shared) return false;
  return provider === 'compat' ? !!endpoint && (shared.endpoints ?? []).includes(endpoint) : !!shared.providers[provider];
}
/** A credential present on THIS installation. No shared state, no network. */
export function localProviderPresent(user: number, provider: AgentProviderId, endpoint?: string | null): boolean {
  if (provider === 'compat') return !!endpoint && !!endpointOf(user, endpoint);
  if (provider === 'openrouter' || provider === 'openai') return !!agentKey(user, provider);
  return !!getAgentAccount(user, 'codex');
}
/**
 * A non-secret generation for the local credential a route is bound to. It changes when the account
 * behind it is replaced — a different ChatGPT account, a re-entered key, a repointed endpoint — and
 * not when a refresh token merely rotates, so an ordinary refresh does not interrupt a running turn
 * while a reconnect to another account does. Never a token, never a key.
 */
export function credentialId(user: number, provider: AgentProviderId, endpoint?: string | null): string | null {
  const key = provider === 'compat' ? (endpoint ? `compat:${endpoint}` as const : null) : provider;
  return key && getAgentAccount(user, key) ? credentialGeneration(user, key) : null;
}

const hostOf = (server: string) => { try { return new URL(server).host; } catch { return server; } };

export interface RouteOptions {
  /** The backend this conversation RECORDED (agent_conversations.endpoint_url). It outranks the
   *  policy: the route either honours it or the turn is blocked. */
  recorded?: string | null;
  /** A compat conversation with history that recorded nothing. Unknown history is not evidence of
   *  local identity, so it is only served where relaying was never possible. */
  unpinned?: boolean;
}

export async function resolveProviderRoute(
  user: number,
  provider: AgentProviderId,
  endpoint?: string | null,
  options: RouteOptions = {},
): Promise<ResolvedProviderRoute> {
  const at = Date.now(), policy = routePolicy(user);
  const local = (reason: string, blocked?: string): ResolvedProviderRoute => ({
    via: 'local', policy, reason, credential: credentialId(user, provider, endpoint), at, ...(blocked ? { blocked } : {}),
  });
  if (!isDesktop()) {
    const pin = options.recorded ? parseRemotePin(options.recorded) : null;
    return pin && (pin.runtime !== installationId() || pin.profile !== profileId(user) || !pin.url)
      ? local('source unavailable', 'This conversation belongs to a different or unidentified serving installation.')
      : local('this server');
  }

  const shared = sharedRime(user);
  const offers = serverOffers(shared, provider, endpoint);
  let connection: { id: string } | undefined;
  try { connection = await rimeConnection(user); } catch { connection = undefined; }
  const server: ProviderServerRef | undefined = connection && shared
    ? { id: connection.id, host: hostOf(shared.server), profile: shared.profile, runtime: shared.runtime ?? '' } : undefined;
  // Reachability of the SERVER ITSELF, and separately whether its identity is the one we expect: a
  // note that will not sync is not an outage, and a profile that does not match is not an outage
  // either - it is a different account, and its capabilities are not eligible at all.
  const usable = shared?.reachable === true && shared.authority !== false;
  const generation = shared?.generations?.[provider === 'compat' && endpoint ? `compat:${endpoint}` : provider];
  const onServer = (reason: string, pin?: string): ResolvedProviderRoute =>
    ({ via: 'server', policy, reason, ...(server ? { server } : {}), ...(pin ? { remoteBackend: pin } : {}),
      ...(generation ? { serverCredential: generation } : {}), at,
      ...(!server?.runtime || (shared?.caps?.routePin ?? 0) < 2 || !generation ||
          (provider === 'compat' && (!pin || !parseRemotePin(pin)?.url))
        ? { blocked: 'Update the connected server to support account-bound model access. No request was sent elsewhere.' } : {}) });

  // ---- 1. a recorded constraint decides, whatever the policy prefers today
  const recorded = options.recorded ?? null;
  if (recorded) {
    const pin = parseRemotePin(recorded);
    if (pin) {
      if (!pin.profile)
        return local('pinned to a connected server', 'This conversation recorded a connected-server backend this version cannot identify. Start a new chat on this endpoint instead.');
      if (policy === 'runtime')
        return local('pinned to a connected server', `This conversation was admitted on the connected server's "${endpoint}" endpoint. Model access is set to this runtime only, so it is not served here and nothing was sent anywhere else.`);
      if (!server || !shared)
        return onServer('pinned to a connected server', recorded);
      if (shared.profile !== pin.profile || shared.runtime !== pin.runtime)
        return { ...onServer('pinned to another server account'), blocked: `This conversation ran on a different server account than the one connected now. It is not continued here, and nothing was sent to the new one.` };
      if (!offers)
        return { ...onServer('pinned to a connected server'), blocked: `The connected server no longer offers an endpoint named "${endpoint}". This conversation is not moved to a local endpoint of that name.` };
      if (!pin.url) return { ...onServer('unidentified backend'), blocked: 'This conversation never recorded its server backend. Start a new chat.' };
      return onServer('pinned to the connected server that admitted this conversation', recorded);
    }
    // A LOCAL url. It was admitted here and is never relayed - the paired server's endpoint of the
    // same name is a different backend, and relaying would send this thread's context to it.
    if (policy === 'server')
      return { ...local('pinned to a local backend'), blocked: `This conversation was admitted on this runtime's "${endpoint}" endpoint. Model access is set to the connected server only, so it is not served and its context was not sent there.` };
    return local('pinned to the backend this conversation recorded');
  }

  // ---- 2. a compat conversation with history that recorded nothing
  if (options.unpinned) {
    // Safe only where relaying was never possible: this runtime has never joined a server, so no
    // earlier turn of it can have run anywhere but here.
    if (!shared && !server) return local('this runtime has never been connected to a server');
    return { ...local('source not recorded'), blocked: `This conversation did not record which backend served it, and this runtime has been connected to a server, so there is no way to establish that "${endpoint}" here is the same one. Start a new chat on the endpoint as it stands, or continue it where it ran.` };
  }

  // ---- 3. an ordinary new selection
  const pinFor = () => (provider === 'compat' && endpoint && shared ? remotePin(shared.runtime ?? '', shared.profile, shared.backends?.[endpoint] ?? '') : undefined);
  if (policy === 'runtime') return local('this runtime only');
  if ((connection || shared) && (!shared || (!usable && shared.failure !== 'transport')))
    return local('server authority unavailable', 'The connected server identity or protocol is not verified. Repair the connection or explicitly select this runtime; billing was not switched automatically.');
  if (policy === 'server')
    return {
      ...onServer('connected server only', pinFor()),
      ...(!server ? { blocked: 'Model access is set to the connected server only, and no server is designated. Nothing was sent anywhere else.' }
        : !offers ? { blocked: 'Model access is set to the connected server only, and it does not offer this provider. Nothing was sent anywhere else.' }
        : !usable ? { blocked: `Model access is set to the connected server only (${server.host}), and it is not available. Nothing was sent anywhere else.` } : {}),
    };
  if (server && offers && usable) return onServer('automatic — connected server', pinFor());
  return local(!server ? 'automatic — no connected server'
    : !offers ? 'automatic — the connected server does not offer this provider'
    : 'automatic — the connected server is unavailable');
}

export function routeReceipt(route: ResolvedProviderRoute): ProviderRouteReceipt {
  return {
    policy: route.policy, via: route.via, reason: route.reason,
    runtime: route.server?.runtime ?? installationId(),
    ...(route.server ? { server: route.server.host, profile: route.server.profile } : {}),
  };
}
/** "Model access via …" — the composer's one line about where this conversation is billed. */
export function routeLabel(route: ResolvedProviderRoute): string {
  if (route.blocked) return 'unavailable';
  if (route.via === 'server') return route.server ? `Connected server · ${route.server.host}` : 'Connected server';
  return isDesktop() ? 'This desktop' : 'This server';
}

/**
 * Is the backend a conversation RECORDED still what this endpoint NAME means here? Null when it is;
 * a reason when it is not. One check for every caller that moves a conversation (child resume,
 * History → Continue here). A remote pin is answered from the connected server's own profile and
 * attestation — never from a local endpoint that happens to share the name, and never by crediting an
 * unattested pin with an identity.
 */
export function recordedBackendCheck(user: number, endpoint: string, recorded: string): string | null {
  const pin = parseRemotePin(recorded);
  if (pin) {
    if (!isDesktop() && pin.runtime === installationId() && pin.profile === profileId(user) && pin.url)
      return endpointUrlOf(user, endpoint) === pin.url ? null : 'the recorded endpoint changed on this installation';
    const shared = isDesktop() ? sharedRime(user) : null;
    if (!pin.profile) return 'it recorded a connected-server backend this version cannot identify';
    if (!shared) return `it ran on a connected server's endpoint "${endpoint}", and this runtime has none`;
    if (shared.profile !== pin.profile || shared.runtime !== pin.runtime) return 'it ran on a different serving installation or account';
    if (!(shared.endpoints ?? []).includes(endpoint)) return `the connected server no longer offers an endpoint named "${endpoint}"`;
    if (!pin.url) return `the server did not attest which backend "${endpoint}" served, so its identity was never established`;
    const attested = shared.backends?.[endpoint];
    if (!attested) return `the connected server cannot confirm which backend "${endpoint}" serves — update it`;
    if (attested !== pin.url) return `the connected server's "${endpoint}" now points at ${attested}, not ${pin.url}`;
    return null;
  }
  const here = endpointUrlOf(user, endpoint);
  return here === recorded ? null : `endpoint "${endpoint}" now points at ${here ?? 'nothing'}, not ${recorded}`;
}

// ---------------------------------------------------------------- voice sessions
//
// A call keeps the owner it started on. The receipt names the installation, its profile and the LEASE
// itself, so a heartbeat or stop is answered by the runtime that actually holds that call — never by
// a local lease standing in for a remote one, and never by guessing when the owner is unknown.

export interface VoiceReceipt {
  via: 'local' | 'server';
  serverId?: string;
  profile?: string;
  runtime?: string;
  credential?: string;
  lease?: string;
}
const voiceKey = (user: number, ward: string) => `voice:route:${user}:${ward}`;
export function pinVoiceRoute(user: number, ward: string, receipt: VoiceReceipt): void {
  setSetting(voiceKey(user, ward), JSON.stringify(receipt));
}
export function pinnedVoiceRoute(user: number, ward: string): VoiceReceipt | null {
  const raw = getSetting(voiceKey(user, ward));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as VoiceReceipt;
    return value?.via === 'local' || value?.via === 'server' ? value : null;
  } catch { return null; }
}
export function clearVoiceRoute(user: number, ward: string): void {
  deleteSetting(voiceKey(user, ward));
}
