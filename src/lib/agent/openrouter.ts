import { OpenRouter } from '@openrouter/sdk';
import { cached } from '../cache.ts';
import { openrouterContext, type ModelContext } from './context.ts';
import { getSetting, setSetting } from '../settings.ts';
import { agentKey } from './accounts.ts';
import {
  isTransient,
  recordAgentStatus,
  usageLine,
  type AgentProvider,
  type AgentToolCall,
  type ProviderCall,
  type ProviderResult,
} from './provider.ts';

// The OpenRouter provider: official @openrouter/sdk, chat-completions dialect.
// Items are stored in the SDK's own (camelCase) message shapes — assistant
// messages carry toolCalls[{id, function:{name, arguments}}], tool results are
// {role:'tool', toolCallId, content} — so a stored conversation round-trips
// through chat.send verbatim.
//
// stream:false on purpose: turns are tool-loop dominated and the ward streams
// step events, not tokens. ponytail: flip to stream:true + accumulate deltas
// if slow models ever hit proxy idle timeouts.

const TIMEOUT_MS = 120_000;

interface ChatMsg {
  role?: string;
  content?: unknown;
  toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}

/** Display text + pending calls from a chat-completions assistant message. */
export function readChatResponse(msg: ChatMsg): { text: string; calls: AgentToolCall[] } {
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
        : '';
  const calls: AgentToolCall[] = (msg.toolCalls ?? []).map((tc) => ({
    call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments || '{}',
  }));
  return { text, calls };
}

/** Chat-dialect pair repair — see AgentProvider.repairItems. Every assistant
 *  toolCall needs a following {role:'tool'} message; every tool message needs
 *  its call. keepOpen calls stay deliberately unanswered (parked confirm). */
export function repairChatItems(items: unknown[], keepOpen: Set<string>): unknown[] {
  const answered = new Set<string>();
  for (const it of items) {
    const m = it as ChatMsg;
    if (m?.role === 'tool' && m.toolCallId) answered.add(m.toolCallId);
  }
  const called = new Set<string>();
  const out: unknown[] = [];
  for (const it of items) {
    const m = it as ChatMsg;
    if (m?.role === 'tool' && m.toolCallId && !called.has(m.toolCallId)) continue;
    out.push(it);
    if (m?.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        called.add(tc.id);
        if (!answered.has(tc.id) && !keepOpen.has(tc.id)) {
          out.push({
            role: 'tool',
            toolCallId: tc.id,
            content: JSON.stringify({
              interrupted: true,
              note: 'This call never ran — the user moved on, or the server restarted while it waited to be confirmed. Nothing was done. Offer it again if it is still wanted.',
            }),
          });
        }
      }
    }
  }
  return out;
}

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * A cache breakpoint on the last message. Anthropic-style providers cache the
 * prefix up to a marker and look back from it for hits, so with the marker
 * riding the newest message every round re-reads the whole thread from cache
 * and pays full price only for what is new. OpenRouter translates the marker
 * per provider (OpenAI-style ones cache the prefix on their own). The stored
 * items are never touched — this is a copy for the wire.
 */
export function markLast(items: unknown[]): unknown[] {
  const last = items[items.length - 1] as ChatMsg | undefined;
  if (!last) return items;
  let content: unknown;
  if (typeof last.content === 'string') content = [{ type: 'text', text: last.content, cacheControl: EPHEMERAL }];
  else if (Array.isArray(last.content)) {
    const parts = [...(last.content as Record<string, unknown>[])];
    const i = parts.map((c) => c?.type).lastIndexOf('text');
    if (i < 0) return items; // nothing a marker can sit on
    parts[i] = { ...parts[i], cacheControl: EPHEMERAL };
    content = parts;
  } else return items; // an assistant turn that is only toolCalls
  return [...items.slice(0, -1), { ...last, content }];
}

async function callOpenRouter(call: ProviderCall, retried = false): Promise<ProviderResult> {
  const key = agentKey(call.userId, 'openrouter');
  if (!key) throw new Error('openrouter: no API key — add one under Account → Agent');
  const or = new OpenRouter({ apiKey: key });
  let result: any;
  try {
    result = await or.chat.send(
      {
        chatRequest: {
          model: call.model,
          // Two breakpoints: the instructions (static per ward — a hit even on a
          // fresh thread) and the newest message (the growing thread).
          messages: [
            { role: 'system', content: [{ type: 'text', text: call.instructions, cacheControl: EPHEMERAL }] },
            ...(markLast(call.items) as any[]),
          ],
          ...(call.tools.length
            ? {
                tools: call.tools.map((t) => ({
                  type: 'function' as const,
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
                toolChoice: 'auto' as const,
                parallelToolCalls: true, // independent calls in one round — core.ts runs the batch concurrently
              }
            : {}),
          ...(call.effort ? { reasoning: { effort: call.effort as any } } : {}),
          ...(call.cacheKey ? { promptCacheKey: call.cacheKey } : {}),
          stream: false,
        },
      },
      // The SDK skips its own timeout once a signal is given, so both ride one.
      { timeoutMs: TIMEOUT_MS, ...(call.relayRequestId ? { retries: { strategy: 'none' as const } } : {}), ...(call.signal ? { fetchOptions: { signal: AbortSignal.any([call.signal, AbortSignal.timeout(TIMEOUT_MS)]) } } : {}) }
    );
  } catch (err) {
    if (call.signal?.aborted) throw new Error('openrouter: interrupted');
    const e = new Error(`openrouter: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    if (!call.relayRequestId && !retried && isTransient(e)) {
      await new Promise((r) => setTimeout(r, 1200));
      return callOpenRouter(call, true);
    }
    throw e;
  }
  const msg = result?.choices?.[0]?.message as ChatMsg | undefined;
  if (!msg) throw new Error('openrouter: empty response');
  const { text, calls } = readChatResponse(msg);
  if (!text && !calls.length) throw new Error('openrouter: empty response');
  // Store the assistant message verbatim (reasoningDetails included) so the
  // next request replays exactly what the model said.
  const input = Number(result?.usage?.promptTokens) || 0;
  const cached = Number(result?.usage?.promptTokensDetails?.cachedTokens) || 0;
  return { text, calls, items: [{ ...msg, role: 'assistant' }], ...(input ? { usage: { input, cached, output: result?.usage?.completionTokens } } : {}) };
}

export const openrouterProvider: AgentProvider = {
  id: 'openrouter',
  context: async(_user, model) => (await listOpenRouterModels()).find((m) => m.id === model)?.context,
  async run(call) {
    try {
      const result = await callOpenRouter(call);
      recordAgentStatus(call.userId, 'openrouter', true, usageLine(result.usage));
      return result;
    } catch (err) {
      // A Stop from the user is not a provider failure: no sticky last-error, no log line.
      if (!call.signal?.aborted) recordAgentStatus(call.userId, 'openrouter', false, call.relayRequestId ? `Relayed model request failed. Reference ${call.relayRequestId}.` : err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
  userItem: (text) => ({ role: 'user', content: text }),
  toolOutputItem: (callId, json) => ({ role: 'tool', toolCallId: callId, content: json }),
  repairItems: repairChatItems,
};

export interface ModelChoice {
  id: string;
  name: string;
  context?: ModelContext;
}

const MODELS_TTL_MS = 3600_000;
const MODELS_KEY = 'agent_models:openrouter';

/**
 * Model ids for the model picker. Two caches on purpose: `cached()` bounds the
 * calls to once an hour per process, and a settings row keeps the last good
 * list across restarts — the picker is a search box over 300+ models, and an
 * empty one because OpenRouter blinked (or because pm2 just reloaded) is worse
 * than an hour-stale one. The list is public data, so it is shared, not
 * per-user.
 */
export function listOpenRouterModels(): Promise<ModelChoice[]> {
  return cached('agent:models', MODELS_TTL_MS, async () => {
    try {
      // No apiKey: the catalog is public, and this list is shared by every
      // user, so it must not depend on whose key happens to be configured.
      const or = new OpenRouter();
      const pages = await or.models.list();
      const models: ModelChoice[] = [];
      for await (const page of pages) {
        for (const m of page.result?.data ?? []) {
          if (typeof m.id === 'string') models.push({ id: m.id, name: String(m.name || m.id), context: openrouterContext(m) });
        }
      }
      if (!models.length) throw new Error('empty model list');
      models.sort((a, b) => a.name.localeCompare(b.name));
      setSetting(MODELS_KEY, JSON.stringify({ at: Date.now(), models }));
      return models;
    } catch (err) {
      const stale = readStoredModels();
      if (stale.length) {
        console.error('[agent models] live list failed, serving the stored one:', err);
        return stale.map((m) => ({ ...m, ...(m.context ? { context: { ...m.context, source: 'cache' as const } } : {}) }));
      }
      throw err;
    }
  });
}

/** The last list that came back, from an earlier process if need be. */
function readStoredModels(): ModelChoice[] {
  try {
    const raw = getSetting(MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { models?: ModelChoice[] };
    return Array.isArray(parsed.models) ? parsed.models.filter((m) => typeof m?.id === 'string') : [];
  } catch {
    return [];
  }
}
