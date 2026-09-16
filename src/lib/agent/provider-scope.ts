import os from 'node:os';
import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../settings.ts';
import { isDesktop } from '../dev/runtime.ts';
import { installationId, profileId } from './sync-store.ts';
import { credentialGeneration, deleteAgentAccount, deleteEndpoint, getAgentAccount, listEndpoints, mask, storeAgentAccount, storeEndpoint } from './accounts.ts';
import { browserbaseKey, storeBrowserbaseKey } from '../browser/browserbase.ts';
import { codexDisconnect, codexOauthPending } from './codex.ts';
import { agentRounds, parseRounds } from './provider.ts';
import { ROUTE_POLICIES, ROUTE_POLICY_NAMES, isRoutePolicy, routePolicy, setRoutePolicy, type ProviderRoutePolicy } from './route.ts';

// One installation's provider connections, as a thing a page can show and write BY NAME.
//
// The point of this module is that every read and every write names the installation it belongs to
// and the generation of that installation's identity. A form rendered against one connection cannot
// be submitted against another: the binding it was rendered with is a precondition on the write, so
// an unpair, a server switch or an account replacement rejects the stale form instead of quietly
// changing a different account's credential.

export const PROVIDER_KEYS = [
  { id: 'openrouter', name: 'OpenRouter API key', hint: 'powers the openrouter provider — openrouter.ai/keys' },
  { id: 'openai', name: 'OpenAI API key', hint: 'powers the openai provider (the OpenAI API, billed to your key) — platform.openai.com/api-keys' },
  { id: 'brave', name: 'Brave Search key', hint: 'web_search (keyword) — api.search.brave.com' },
  { id: 'exa', name: 'Exa key', hint: 'web_search (semantic) — exa.ai' },
] as const;
export type ProviderKeyId = (typeof PROVIDER_KEYS)[number]['id'];
const isKeyId = (v: unknown): v is ProviderKeyId => PROVIDER_KEYS.some((k) => k.id === v);

/** Every action that writes a CREDENTIAL. Account knobs (tool rounds, sandbox network) are
 *  deliberately not here: they are not provider connections and must not change ownership with one. */
export const CREDENTIAL_ACTIONS = ['key', 'endpoint-add', 'endpoint-remove', 'browserbase-key', 'codex-disconnect'] as const;
export type CredentialAction = (typeof CREDENTIAL_ACTIONS)[number];
export const isCredentialAction = (v: unknown): v is CredentialAction => (CREDENTIAL_ACTIONS as readonly unknown[]).includes(v);

export interface ProviderScopeStatus {
  /** The identity this card was rendered against; every write must carry it back unchanged. */
  binding: string;
  oauthBinding: string;
  kind: 'runtime' | 'server';
  runtime: 'desktop' | 'server';
  name: string;
  codex: { connected: boolean; label: string; pending: boolean };
  keys: { id: ProviderKeyId; name: string; hint: string; label: string }[];
  endpoints: { name: string; url: string; label: string }[];
  browserbase: string;
  rounds: number;
  shellNetwork: boolean;
}

/**
 * This installation's own identity generation: its installation id, the sync profile it is joined
 * to, AND a digest of the provider accounts it currently holds. The last part is what makes a form
 * stale when the ACCOUNT behind a card is replaced — installation and profile do not change when a
 * ChatGPT connection is swapped or an endpoint repointed, and a form rendered against the old one
 * must not write to the new one. The digest is over non-secret generations only (a masked label, an
 * endpoint's url+key revision, a ChatGPT account id): no key or token contributes its value.
 */
export function runtimeBinding(userId: number): string {
  const generations = [
    credentialGeneration(userId, 'codex'),
    ...PROVIDER_KEYS.map((k) => `${k.id}=${credentialGeneration(userId, k.id)}`),
    ...listEndpoints(userId).map((e) => `compat:${e.name}=${credentialGeneration(userId, `compat:${e.name}`)}`),
    `bb=${credentialGeneration(userId, 'browserbase')}`,
  ].join('\n');
  return `runtime:${installationId()}:${profileId(userId)}:${createHash('sha256').update(generations).digest('hex').slice(0, 16)}`;
}

export function oauthRuntimeBinding(user: number): string {
  return `oauth:${installationId()}:${profileId(user)}:${credentialGeneration(user, 'codex')}`;
}
export const oauthServerBinding = (pair: string, profile: string, binding: string) =>
  `server:${pair}:${profile}:${binding}`;

export function providerScopeStatus(userId: number): ProviderScopeStatus {
  const codex = getAgentAccount(userId, 'codex');
  return {
    binding: runtimeBinding(userId),
    oauthBinding: oauthRuntimeBinding(userId),
    kind: 'runtime',
    runtime: isDesktop() ? 'desktop' : 'server',
    name: isDesktop() ? os.hostname() : 'Rimeward server',
    codex: { connected: !!codex, label: codex?.label || (codex ? 'connected' : ''), pending: !codex && !!codexOauthPending(userId) },
    keys: PROVIDER_KEYS.map((k) => ({ ...k, label: getAgentAccount(userId, k.id)?.label ?? '' })),
    endpoints: listEndpoints(userId),
    browserbase: (() => { const key = browserbaseKey(userId); return key ? mask(key) : ''; })(),
    rounds: agentRounds(userId),
    shellNetwork: getSetting(`agent_shell_network:${userId}`) === 'true',
  };
}

export interface ProviderWrite {
  action: string;
  provider?: unknown;
  key?: unknown;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
  rounds?: unknown;
  policy?: unknown;
}

/**
 * Apply one provider-management write to THIS installation. The caller has already established who
 * the destination is; this never looks at pairing, routing or connectivity, so a write admitted for
 * one installation cannot be redirected inside it.
 */
export function applyProviderWrite(userId: number, body: ProviderWrite): string {
  const text = (v: unknown) => String(v ?? '').trim();
  switch (body.action) {
    case 'key': {
      if (!isKeyId(body.provider)) throw new Error('Unknown credential.');
      const key = text(body.key);
      if (!key) { deleteAgentAccount(userId, body.provider); return 'Cleared.'; }
      storeAgentAccount({ userId, provider: body.provider, token: key, label: mask(key) });
      return 'Saved.';
    }
    case 'endpoint-add':
      storeEndpoint(userId, { name: text(body.name), url: text(body.url), key: text(body.key) });
      return 'Endpoint saved.';
    case 'endpoint-remove':
      deleteEndpoint(userId, text(body.name));
      return 'Endpoint removed.';
    case 'browserbase-key':
      storeBrowserbaseKey(userId, text(body.key));
      return text(body.key) ? 'Saved.' : 'Cleared.';
    case 'codex-disconnect':
      // Only this installation's ChatGPT connection. Nothing is unpaired, no session ends, no CLI
      // login is revoked, and the other installation's connection is untouched.
      codexDisconnect(userId);
      return 'Disconnected.';
    case 'shell-network':
      setSetting(`agent_shell_network:${userId}`, body.enabled === true || body.enabled === 'on' ? 'true' : 'false');
      return 'Saved.';
    case 'rounds': {
      const n = parseRounds(body.rounds);
      if (n !== null) setSetting(`agent_rounds:${userId}`, String(n));
      return 'Saved.';
    }
    default:
      throw new Error('Unknown provider operation.');
  }
}

/** The account's model-access preference, with the names the page shows. Stored at the run-owning
 *  runtime and never synced: "this runtime only" names nothing on another installation. */
export function policyState(userId: number): { policy: ProviderRoutePolicy; options: { id: ProviderRoutePolicy; name: string }[] } {
  return { policy: routePolicy(userId), options: ROUTE_POLICIES.map((id) => ({ id, name: ROUTE_POLICY_NAMES[id] })) };
}
export function setPolicy(userId: number, raw: unknown): string {
  if (!isRoutePolicy(raw)) throw new Error('Unknown model-access preference.');
  setRoutePolicy(userId, raw);
  return 'Model access preference saved.';
}
