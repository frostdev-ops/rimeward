import { getSetting, setSetting } from '../settings.ts';
import { getAgentAccount, agentKey } from './accounts.ts';
import { isDesktop } from '../dev/runtime.ts';
import { sharedRime, sharedModel, sharedCodexModels } from './sync.ts';
import type { ModelContext } from './context.ts';

// The provider contract. Two wire protocols, one interface: codex speaks the
// OpenAI Responses API (items replayed verbatim, encrypted reasoning included),
// openrouter speaks chat completions via @openrouter/sdk. A conversation is
// PINNED to one provider (agent_conversations.provider) — there is no
// cross-protocol failover, because each dialect's stored items are opaque to
// the other. An outage surfaces as an error + agent_last_error:<uid>.

export type AgentProviderId = 'codex' | 'openrouter';

export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export interface ProviderCall {
  userId: number;
  model: string;
  effort?: string;
  instructions: string;
  items: unknown[];
  tools: AgentToolSpec[];
  /** Routes prompt caching: requests sharing a key land on the same cache.
   *  One per conversation — that is the unit whose prefix repeats. */
  cacheKey?: string;
  /** An interrupt (core.interruptTurn) aborts the call in flight through this. */
  signal?: AbortSignal;
  onProgress?: () => void;
  /** Native relay calls retain metadata only and never retry uncertain inference. */
  relayRequestId?: string;
}

export interface ProviderResult {
  text: string;
  calls: AgentToolCall[];
  /** Raw wire items — appended verbatim to the stored conversation. */
  items: unknown[];
  /** Prompt tokens billed, and how many of them the provider served from cache. */
  usage?: { input: number; cached: number; output?: number };
}

/** The status line for a successful call — the cache hit rate is the one
 *  number that says whether the prompt is laid out right. */
export function usageLine(usage?: { input: number; cached: number }): string {
  if (!usage?.input) return 'ok';
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `ok · ${k(usage.input)} in, ${k(usage.cached)} cached (${Math.round((100 * usage.cached) / usage.input)}%)`;
}

export interface AgentProvider {
  id: AgentProviderId;
  context?(userId: number, model: string): Promise<ModelContext | undefined>;
  run(call: ProviderCall): Promise<ProviderResult>;
  /** Wire-shape user message / tool result for this protocol. */
  userItem(text: string): unknown;
  toolOutputItem(callId: string, json: string): unknown;
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

export const DEFAULT_MODELS: Record<AgentProviderId, string> = {
  codex: 'gpt-5.6-sol',
  openrouter: 'anthropic/claude-sonnet-5',
};

/** The config dialog's suggestions when the ChatGPT backend cannot be asked
 *  (no account linked yet, or its model list is down — codex.ts
 *  listCodexModels is the live source). The model field stays free text, so an
 *  id missing from here still works if you type it. */
export const CODEX_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'];

export function agentConfigured(userId: number, provider: AgentProviderId): boolean {
  const shared=sharedRime(userId);
  if(shared?.online && shared.providers[provider])return true;
  if (provider === 'openrouter') return !!agentKey(userId, 'openrouter');
  return !!getAgentAccount(userId, 'codex');
}

export function defaultAgentProvider(userId: number): AgentProviderId {
  const preferred = sharedRime(userId)?.config.provider;
  if (preferred === 'codex' || preferred === 'openrouter') return preferred;
  return agentConfigured(userId, 'codex') ? 'codex' : 'openrouter';
}

export async function getProvider(id: AgentProviderId): Promise<AgentProvider> {
  // Dynamic so a request that never chats (status ticks, watchers sweeping an
  // empty table) doesn't load the SDK or the codex machinery.
  const provider = await (id === 'codex'
    ? import('./codex.ts').then((m) => m.codexProvider)
    : import('./openrouter.ts').then((m) => m.openrouterProvider));
  return isDesktop() ? {
    ...provider,
    run: async(call) => await sharedModel(call.userId,id,call) ?? provider.run(call),
    context: async(user, model) => {
      if (id === 'codex') {
        const shared = await sharedCodexModels(user);
        if (shared) return shared.find((m) => m.id === model)?.context;
      }
      return provider.context?.(user, model);
    },
  } : provider;
}
