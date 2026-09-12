import { OpenRouter } from '@openrouter/sdk';
import { cached } from '../cache.ts';
import { openrouterContext, type ModelContext } from './context.ts';
import { getSetting, setSetting } from '../settings.ts';
import { agentKey, endpointOf } from './accounts.ts';
import { isDesktop } from '../dev/runtime.ts';
import { pinnedRequest } from './shell.ts';
import { sseParser } from './stream.ts';
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


const TIMEOUT_MS = 120_000;

interface ChatMsg {
  role?: string;
  content?: unknown;
  reasoning?: string;
  refusal?: string;
  reasoningDetails?: Record<string, any>[];
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

/** Both chat transports reconstruct the same replay message, including opaque reasoning. */
function chatStream(onText?: (delta: string) => void) {
  const msg: ChatMsg = { role: 'assistant', content: '' };
  const calls = new Map<number, NonNullable<ChatMsg['toolCalls']>[number]>();
  const reasoning = new Map<string, Record<string, any>>();
  let finished = false, usage: any;
  return {
    push(chunk: any) {
      if (chunk.error) throw Error(chunk.error.message ?? JSON.stringify(chunk.error));
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const text = delta.content ?? delta.refusal;
      if (typeof text === 'string' && text) { msg.content = String(msg.content) + text; onText?.(text); }
      if (typeof delta.reasoning === 'string') msg.reasoning = (msg.reasoning ?? '') + delta.reasoning;
      if (typeof delta.refusal === 'string') msg.refusal = (msg.refusal ?? '') + delta.refusal;
      for (const tc of delta.toolCalls ?? delta.tool_calls ?? []) {
        if (!Number.isInteger(tc.index) || tc.index < 0) throw Error('Invalid streamed tool index');
        const item = calls.get(tc.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) item.id = tc.id;
        if (tc.function?.name) item.function.name += tc.function.name;
        if (tc.function?.arguments) item.function.arguments += tc.function.arguments;
        calls.set(tc.index, item);
      }
      for (const [i, detail] of (delta.reasoningDetails ?? delta.reasoning_details ?? []).entries()) {
        const key = `${detail.type}:${detail.index ?? detail.id ?? i}`;
        const old = reasoning.get(key);
        const next = { ...old, ...detail };
        for (const field of ['text', 'summary', 'data'])
          if (typeof old?.[field] === 'string' && typeof detail[field] === 'string') next[field] = old[field] + detail[field];
        reasoning.set(key, next);
      }
      const finish = choice.finishReason ?? choice.finish_reason;
      if (finish) {
        if (!['stop', 'tool_calls', 'function_call'].includes(finish)) throw Error(`Incomplete response (${finish})`);
        finished = true;
      }
    },
    result() {
      if (!finished) throw Error('response stream ended before completion');
      if (calls.size) {
        msg.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        for (const tc of msg.toolCalls) {
          if (!tc.id || !tc.function.name) throw Error('Incomplete streamed tool call');
          JSON.parse(tc.function.arguments || '{}');
        }
      }
      if (reasoning.size) msg.reasoningDetails = [...reasoning.values()];
      return { choices: [{ message: msg }], usage };
    },
  };
}

async function callOpenRouter(call: ProviderCall, retried = false): Promise<ProviderResult> {
  const key = agentKey(call.userId, 'openrouter');
  if (!key) throw new Error('openrouter: no API key — add one under Account → Agent');
  const or = new OpenRouter({ apiKey: key });
  let result: any;
  let visible = false;
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
          stream: true,
        },
      },
      // The SDK skips its own timeout once a signal is given, so both ride one.
      { timeoutMs: TIMEOUT_MS, retries: { strategy: 'none' as const }, ...(call.signal ? { fetchOptions: { signal: AbortSignal.any([call.signal, AbortSignal.timeout(TIMEOUT_MS)]) } } : {}) }
    );
    if (result?.[Symbol.asyncIterator]) {
      const stream = chatStream(delta => { visible = true; call.onTextDelta?.(delta); });
      for await (const chunk of result) { call.onProgress?.(); stream.push(chunk); }
      result = stream.result();
    }
  } catch (err) {
    if (call.signal?.aborted) throw new Error('openrouter: interrupted');
    const e = new Error(`openrouter: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    if (!visible && !call.relayRequestId && !retried && isTransient(e)) {
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
  dialect: 'openrouter',
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
  /** From supported_parameters — a union across the model's endpoints, so
   *  false is certain and true is "some endpoint does". */
  tools?: boolean;
  /** Accepts image input. */
  vision?: boolean;
  /** USD per token, as OpenRouter quotes them (strings — they are tiny). */
  pricing?: { prompt: string; completion: string };
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
          if (typeof m.id !== 'string') continue;
          const params = (m as { supportedParameters?: unknown }).supportedParameters;
          const inputs = (m as { architecture?: { inputModalities?: unknown } }).architecture?.inputModalities;
          const pricing = (m as { pricing?: { prompt?: unknown; completion?: unknown } }).pricing;
          models.push({
            id: m.id,
            name: String(m.name || m.id),
            context: openrouterContext(m),
            ...(Array.isArray(params) ? { tools: params.includes('tools') } : {}),
            ...(Array.isArray(inputs) ? { vision: inputs.includes('image') } : {}),
            ...(pricing && typeof pricing.prompt === 'string' && typeof pricing.completion === 'string' ? { pricing: { prompt: pricing.prompt, completion: pricing.completion } } : {}),
          });
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

// ---------------------------------------------------------------- OpenAI-compatible endpoints
//
// The same chat-completions dialect over a plain HTTP request to a base URL the
// user configured (Ollama, LM Studio, vLLM, a hosted OpenAI-style API). Items
// are STORED in the SDK's camelCase shape above, so one dialect's replay,
// repair and compaction serve both; the wire is snake_case both ways. The
// request is pinned (private ranges refused — loopback allowed on the desktop
// only), never follows a redirect, and carries the cancel signal to the socket.

const COMPAT_TIMEOUT_MS = 300_000;

/** Stored (camelCase) → wire (snake_case). The cache marker and our file ids never go out. */
export function toWire(item: unknown): unknown {
  const m = item as ChatMsg & { reasoningDetails?: unknown };
  if (!m || typeof m !== 'object') return item;
  const out: Record<string, unknown> = { role: m.role };
  if (m.content !== undefined && m.content !== null) {
    out.content = Array.isArray(m.content)
      ? m.content.map((c: any) => {
          if (c?.type === 'image_url') return { type: 'image_url', image_url: { url: c.imageUrl?.url ?? c.image_url?.url } };
          return { type: c?.type ?? 'text', text: c?.text ?? '' };
        })
      : m.content;
  } else if (m.role === 'assistant') out.content = '';
  if (m.reasoning !== undefined) out.reasoning = m.reasoning;
  if (m.reasoningDetails !== undefined) out.reasoning_details = m.reasoningDetails;
  if (m.refusal !== undefined) out.refusal = m.refusal;
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (Array.isArray(m.toolCalls)) out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }));
  return out;
}

/** Wire (snake_case) → stored (camelCase). Only what the loop reads back. */
export function fromWire(msg: { role?: string; content?: unknown; reasoning?: string; refusal?: string; reasoning_details?: Record<string, any>[]; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] }): ChatMsg {
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter((tc) => typeof tc?.id === 'string' && typeof tc.function?.name === 'string')
        .map((tc) => ({ id: String(tc.id), type: 'function', function: { name: String(tc.function!.name), arguments: typeof tc.function!.arguments === 'string' ? tc.function!.arguments : '{}' } }))
    : [];
  return { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : msg.refusal ?? '',
    ...(typeof msg.reasoning === 'string' ? { reasoning: msg.reasoning } : {}),
    ...(typeof msg.refusal === 'string' ? { refusal: msg.refusal } : {}),
    ...(Array.isArray(msg.reasoning_details) ? { reasoningDetails: msg.reasoning_details } : {}),
    ...(toolCalls.length ? { toolCalls } : {}) };
}

async function callCompat(endpoint: string, call: ProviderCall): Promise<ProviderResult> {
  const target = endpointOf(call.userId, endpoint);
  if (!target) throw new Error(`compat: no endpoint "${endpoint}" — add it under Account → Agent`);
  if (!call.model) throw new Error(`compat: pick a model for "${endpoint}" (list_models shows what it serves)`);
  const stream = chatStream(call.onTextDelta), decoder = new TextDecoder();
  let streaming = false;
  const parser = sseParser(payload => { if (payload !== '[DONE]') stream.push(JSON.parse(payload)); });
  const res = await pinnedRequest(`${target.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) },
    body: JSON.stringify({
      model: call.model,
      messages: [{ role: 'system', content: call.instructions }, ...call.items.map(toWire)],
      ...(call.tools.length
        ? { tools: call.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' }
        : {}),
      stream: true,
    }),
    timeoutMs: COMPAT_TIMEOUT_MS,
    signal: call.signal,
    allowLoopback: isDesktop(),
    onChunk(chunk, headers) {
      call.onProgress?.();
      if (headers['content-type']?.includes('text/event-stream')) {
        streaming = true;
        parser.push(decoder.decode(chunk, { stream: true }));
      }
    },
  }).catch((err) => {
    if (call.signal?.aborted) throw new Error('compat: interrupted');
    throw new Error(`compat (${endpoint}): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  });
  if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`compat (${endpoint}): ${res.status} ${res.text.slice(0, 300)}`), { status: res.status });
  let data: any;
  if (streaming) {
    parser.push(decoder.decode()); parser.finish(); data = stream.result();
  } else {
    try { data = JSON.parse(res.text); } catch { throw new Error(`compat (${endpoint}): response was not JSON`); }
  }
  const raw = data.choices?.[0]?.message;
  if (!raw) throw new Error(`compat (${endpoint}): empty response`);
  const msg = streaming ? raw as ChatMsg : fromWire(raw);
  const { text, calls } = readChatResponse(msg);
  if (!text && !calls.length) throw new Error(`compat (${endpoint}): empty response`);
  const input = Number(data.usage?.prompt_tokens) || 0;
  const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens) || 0;
  return { text, calls, items: [msg], ...(input ? { usage: { input, cached: cachedTokens, output: Number(data.usage?.completion_tokens) || undefined } } : {}) };
}

/** One provider object per endpoint name; the URL and key are the user's rows, read per call. */
export function compatProvider(endpoint: string): AgentProvider {
  return {
    id: 'compat',
    dialect: 'openrouter',
    endpoint,
    async run(call) {
      try {
        const result = await callCompat(endpoint, call);
        recordAgentStatus(call.userId, 'compat', true, usageLine(result.usage));
        return result;
      } catch (err) {
        if (!call.signal?.aborted) recordAgentStatus(call.userId, 'compat', false, call.relayRequestId ? `Relayed model request failed. Reference ${call.relayRequestId}.` : err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    userItem: openrouterProvider.userItem,
    toolOutputItem: openrouterProvider.toolOutputItem,
    repairItems: repairChatItems,
  };
}

/** GET {base}/models — ids only; nothing about capabilities is known or invented.
 *  Cached per endpoint REVISION (its url + key), so a renamed-in-place endpoint
 *  never serves the previous service's list. */
export function listCompatModels(userId: number, endpoint: string): Promise<{ models: ModelChoice[]; source: 'live' | 'cache'; at: number }> {
  const target = endpointOf(userId, endpoint);
  if (!target) return Promise.reject(new Error(`no endpoint "${endpoint}"`));
  const stored = `agent_models:compat:${userId}:${endpoint}:${target.revision}`;
  return cached(`compat:models:${userId}:${endpoint}:${target.revision}`, MODELS_TTL_MS, async () => {
    try {
      const res = await pinnedRequest(`${target.url}/models`, { headers: target.key ? { Authorization: `Bearer ${target.key}` } : {}, timeoutMs: 10_000, allowLoopback: isDesktop() });
      if (res.status < 200 || res.status >= 300) throw new Error(`models ${res.status}`);
      const data = JSON.parse(res.text) as { data?: { id?: unknown }[] };
      const models = (data.data ?? []).filter((m) => typeof m?.id === 'string').map((m) => ({ id: String(m.id), name: String(m.id) })).sort((a, b) => a.id.localeCompare(b.id));
      if (!models.length) throw new Error('empty model list');
      const at = Date.now();
      setSetting(stored, JSON.stringify({ at, models }));
      return { models, source: 'live' as const, at };
    } catch (err) {
      const last = JSON.parse(getSetting(stored) ?? 'null') as { at?: number; models?: ModelChoice[] } | null;
      if (!last?.models?.length) throw err;
      return { models: last.models, source: 'cache' as const, at: last.at ?? 0 };
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
