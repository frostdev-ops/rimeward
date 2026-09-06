import { createHash, randomBytes } from 'node:crypto';
import { getSetting, setSetting, deleteSetting } from '../settings.ts';
import { openToken } from '../crypto.ts';
import { cached } from '../cache.ts';
import { codexContext, type ModelContext } from './context.ts';
import { getDb } from '../db.ts';
import { getAgentAccount, storeAgentAccount, deleteAgentAccount, accountMeta } from './accounts.ts';
import {
  isTransient,
  recordAgentStatus,
  usageLine,
  type AgentProvider,
  type AgentToolCall,
  type ProviderCall,
  type ProviderResult,
} from './provider.ts';

// The "codex" provider: the unofficial ChatGPT-backend Responses endpoint the
// Codex CLI uses, billed to the user's ChatGPT plan. Ported from the PMA office
// app. RISK, stated plainly: OpenAI ships this endpoint for its own tooling,
// not third parties — it may break without notice and may violate ToS. The
// openrouter provider is the supported refuge.
//
// Per-user here (unlike PMA's single auth file): tokens live sealed in
// agent_accounts, OAuth pending state under codex_oauth_pending:<uid>.

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // codex CLI public client
const CODEX_REDIRECT = 'http://localhost:1455/auth/callback';
const OAUTH_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 300_000; // a long reasoning round thinks for minutes; the relay client waits 330s, nginx 360s

class CodexError extends Error {}

export function jwtClaims(jwt: string | undefined): Record<string, unknown> | null {
  try {
    const payload = jwt!.split('.')[1];
    return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- oauth (paste flow)
// GUI sign-in without a callback server: the codex client's ONLY registered
// redirect is localhost:1455, which doesn't exist here — after signing in the
// user's browser sits on a dead localhost URL WITH the code in the address bar.
// They paste that whole address back; the server does the PKCE exchange
// (redirect_uri is just a matching string at the token endpoint).

interface PendingOauth {
  verifier: string;
  state: string;
  url: string;
  at: number;
}

const pendingKey = (userId: number) => `codex_oauth_pending:${userId}`;

export function codexOauthPending(userId: number): PendingOauth | null {
  try {
    const p = JSON.parse(getSetting(pendingKey(userId)) || 'null') as PendingOauth | null;
    return p?.verifier && Date.now() - p.at < OAUTH_TTL_MS ? p : null;
  } catch {
    return null;
  }
}

export function codexOauthStart(userId: number): PendingOauth {
  const verifier = randomBytes(64).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const url =
    'https://auth.openai.com/oauth/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_REDIRECT,
      scope: 'openid profile email offline_access',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
    }).toString();
  const pending: PendingOauth = { verifier, state, url, at: Date.now() };
  setSetting(pendingKey(userId), JSON.stringify(pending));
  return pending;
}

export function codexOauthCancel(userId: number): void {
  deleteSetting(pendingKey(userId));
}

/** Finish with the localhost URL the user pasted; returns the account email. */
export async function codexOauthFinish(userId: number, pasted: string): Promise<string> {
  const pending = codexOauthPending(userId);
  if (!pending) throw new Error('no sign-in in progress (or it expired) — click "Connect ChatGPT" again');

  const candidate = pasted.trim();
  let url: URL;
  try {
    url = new URL(candidate.includes('://') ? candidate : 'http://' + candidate);
  } catch {
    throw new Error('that does not look like an address — paste the FULL address of the localhost:1455 page');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error(url.searchParams.get('error_description') ?? 'that address has no ?code= in it — paste the whole address bar');
  }
  if (url.searchParams.get('state') !== pending.state) {
    throw new Error('this link came from an older sign-in attempt — start again and use the newest one');
  }

  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: CODEX_REDIRECT,
      code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const tok = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  if (!tok.access_token || !tok.refresh_token) throw new Error('token exchange returned no tokens');

  const claims = jwtClaims(tok.id_token) as
    | { email?: string; 'https://api.openai.com/auth'?: { chatgpt_account_id?: string } }
    | null;
  storeAgentAccount({
    userId,
    provider: 'codex',
    token: tok.refresh_token,
    label: claims?.email ?? '',
    accessToken: tok.access_token,
    meta: { account_id: claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? '', id_token: tok.id_token ?? '' },
  });
  codexOauthCancel(userId);
  return claims?.email ?? '';
}

export function codexDisconnect(userId: number): void {
  deleteAgentAccount(userId, 'codex');
}

// ---------------------------------------------------------------- tokens

interface LiveTokens {
  access_token: string;
  account_id: string;
}

/** Refresh lazily — only when the access token expires within 5 minutes. */
export async function ensureFreshTokens(userId: number): Promise<LiveTokens> {
  const row = getAgentAccount(userId, 'codex');
  if (!row) throw new CodexError('codex: not connected — connect ChatGPT under Account → Agent');
  const meta = accountMeta(row);
  const accountId = String(meta.account_id ?? '');
  const exp = Number(jwtClaims(row.access_token || undefined)?.exp ?? 0);
  if (row.access_token && exp * 1000 - Date.now() > 5 * 60 * 1000) {
    return { access_token: row.access_token, account_id: accountId };
  }

  let refreshToken: string;
  try {
    refreshToken = openToken(row.token_enc);
  } catch {
    throw new CodexError('codex: stored token unreadable — reconnect under Account → Agent');
  }
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    recordAgentStatus(userId, 'codex', false, `refresh rejected (${res.status}) — reconnect under Account → Agent`);
    throw Object.assign(new CodexError(`codex: token refresh rejected (${res.status})`), { status: res.status });
  }
  const fresh = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  storeAgentAccount({
    userId,
    provider: 'codex',
    token: fresh.refresh_token ?? refreshToken,
    label: row.label,
    accessToken: fresh.access_token ?? row.access_token,
    meta: { ...meta, id_token: fresh.id_token ?? meta.id_token },
  });
  return { access_token: fresh.access_token ?? row.access_token, account_id: accountId };
}

/** 401-mid-flight recovery: blank the stored access token so the next
 *  ensureFreshTokens is forced through a refresh. */
function poisonAccessToken(userId: number): void {
  getDb()
    .prepare(`UPDATE agent_accounts SET access_token = '' WHERE user_id = ? AND provider = 'codex'`)
    .run(userId);
}

// ---------------------------------------------------------------- wire shapes

/**
 * The codex backend is stricter than the official Responses API: `input` must
 * be a LIST of typed message items, and message content must be typed parts.
 * Normalize everything to that strictest shape.
 */
export function normalizeInput(input: unknown): unknown {
  const items = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(items)) return items;
  const out: unknown[] = [];
  for (const item of items) {
    const m = item as { role?: string; content?: unknown; type?: string; encrypted_content?: unknown };
    // A reasoning item with no encrypted payload is a bare `rs_…` id the
    // store:false backend cannot resolve — it 400s the whole request. Threads
    // written before the `include` above existed still hold them, so drop them
    // here rather than let one old turn brick the conversation forever.
    if (m?.type === 'reasoning' && !m.encrypted_content) continue;
    if (typeof m?.content === 'string') {
      const type = m.role === 'assistant' ? 'output_text' : 'input_text';
      out.push({ type: 'message', role: m.role ?? 'user', content: [{ type, text: m.content }] });
      continue;
    }
    if (m?.role && Array.isArray(m.content)) {
      out.push({ type: 'message', ...m, content: m.content.map(stripLocalIds) });
      continue;
    }
    out.push(item);
  }
  return out;
}

/** `file_id` on an input_image must be an OpenAI string handle; our numeric
 *  attachment ids parked there (dehydrate/rehydrate bookkeeping) get dropped. */
function stripLocalIds(part: unknown): unknown {
  const c = part as { type?: string; file_id?: unknown };
  if (c?.type !== 'input_image' || c.file_id === undefined || typeof c.file_id === 'string') return part;
  const clean = { ...c };
  delete clean.file_id;
  return clean;
}

type OutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
};

/** Split raw Responses output items into display text + pending function calls. */
export function readItems(items: OutputItem[]): { text: string; calls: AgentToolCall[] } {
  let text = '';
  const calls: AgentToolCall[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) text += part.text;
      }
    } else if (item.type === 'function_call' && item.name) {
      calls.push({ call_id: item.call_id ?? '', name: item.name, arguments: item.arguments ?? '{}' });
    }
  }
  return { text, calls };
}

/** Responses-dialect pair repair — see AgentProvider.repairItems. */
export function repairResponsesItems(items: unknown[], keepOpen: Set<string>): unknown[] {
  const answered = new Set<string>();
  for (const it of items) {
    const o = it as { type?: string; call_id?: string };
    if (o?.type === 'function_call_output' && o.call_id) answered.add(o.call_id);
  }
  const called = new Set<string>();
  const out: unknown[] = [];
  for (const it of items) {
    const o = it as { type?: string; call_id?: string };
    // An output whose call was truncated away is as fatal as the reverse.
    if (o?.type === 'function_call_output' && o.call_id && !called.has(o.call_id)) continue;
    out.push(it);
    if (o?.type === 'function_call' && o.call_id) {
      called.add(o.call_id);
      if (!answered.has(o.call_id) && !keepOpen.has(o.call_id)) {
        out.push({
          type: 'function_call_output',
          call_id: o.call_id,
          output: JSON.stringify({
            interrupted: true,
            note: 'This call never ran — the user moved on, or the server restarted while it waited to be confirmed. Nothing was done. Offer it again if it is still wanted.',
          }),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the call

async function callCodex(call: ProviderCall, retriedAuth = false, retriedTransient = false): Promise<ProviderResult> {
  const tokens = await ensureFreshTokens(call.userId);

  let res: Response;
  try {
    res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify({
        model: call.model,
        reasoning: { effort: call.effort ?? 'medium' },
        // MANDATORY with store:false. Reasoning models emit `reasoning` items
        // carrying only an `rs_…` id; replaying that id on the next round is a
        // 400 ("Item with id 'rs_…' not found. Items are not persisted when
        // store is set to false") which then poisons every later turn of the
        // thread. Asking for the encrypted payload is what makes the verbatim
        // replay this whole design rests on actually stateless.
        include: ['reasoning.encrypted_content'],
        instructions: call.instructions,
        input: normalizeInput(call.items),
        tools: call.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        tool_choice: 'auto',
        parallel_tool_calls: true, // independent calls in one round — core.ts runs the batch concurrently
        // Cache routing, keyed per conversation like the Codex CLI keys per
        // session. The backend caches an exact prefix on its own; the key only
        // steers requests with that prefix to the same cache.
        prompt_cache_key: call.cacheKey,
        store: false,
        stream: true, // required by this backend; parsed whole below, nothing streams onward
      }),
      signal: call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (call.signal?.aborted) throw new CodexError('codex: interrupted');
    const e = new CodexError(`codex: network (${err instanceof Error ? err.message : err})`, { cause: err });
    if (!call.relayRequestId && !retriedTransient && isTransient(e)) {
      await new Promise((r) => setTimeout(r, 1200));
      return callCodex(call, retriedAuth, true);
    }
    throw e;
  }

  if (res.status === 401 && !retriedAuth) {
    poisonAccessToken(call.userId);
    return callCodex(call, true, retriedTransient);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const err = Object.assign(new CodexError(`codex: ${res.status} ${body}`), { status: res.status });
    if (!call.relayRequestId && !retriedTransient && isTransient(err)) {
      await new Promise((r) => setTimeout(r, 1200));
      return callCodex(call, retriedAuth, true);
    }
    throw err;
  }

  // SSE, parsed after the fact: response.completed carries the authoritative
  // output list; per-item response.output_item.done events are the fallback.
  // The body drains for as long as the model thinks, so a reset HERE is just
  // as transient as one during connect. Direct calls may retry; relayed calls never do.
  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    const e = new CodexError(`codex: stream (${err instanceof Error ? err.message : err})`, { cause: err });
    if (!call.relayRequestId && !retriedTransient && isTransient(e)) {
      await new Promise((r) => setTimeout(r, 1200));
      return callCodex(call, retriedAuth, true);
    }
    throw e;
  }
  type Completed = { output?: OutputItem[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
  const streamed: OutputItem[] = [];
  let completed: Completed | null = null;
  let failure: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev: { type?: string; item?: OutputItem; response?: unknown };
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_item.done' && ev.item) streamed.push(ev.item);
    else if (ev.type === 'response.completed') completed = ev.response as Completed;
    else if (ev.type === 'response.failed') failure = JSON.stringify(ev.response ?? '').slice(0, 200);
  }
  if (failure !== null) {
    // A rate limit or upstream 5xx delivered as an SSE event is the same
    // hiccup as one delivered as a status code.
    const err = new CodexError(`codex: response failed ${failure}`);
    if (!call.relayRequestId && !retriedTransient && isTransient(err)) {
      await new Promise((r) => setTimeout(r, 1200));
      return callCodex(call, retriedAuth, true);
    }
    throw err;
  }
  const items = completed?.output?.length ? completed.output : streamed;
  const { text, calls } = readItems(items);
  if (!text && !calls.length) throw new CodexError('codex: empty response');
  const u = completed?.usage;
  return { text, calls, items, ...(u?.input_tokens ? { usage: { input: u.input_tokens, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens } } : {}) };
}

/** The backend's model list. It is gated on the CLI version it thinks it is
 *  talking to (older versions get an empty list), hence the constant; models
 *  the backend marks hidden (its own review model, unreleased ones) are left
 *  out. Cached an hour per user; throws when it cannot be asked, and the
 *  models route falls back to provider.ts CODEX_MODELS. */
const CODEX_CLIENT_VERSION = '3.0.0';

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  /** Reasoning efforts the model accepts, in the backend's order. */
  efforts: string[];
  context?: ModelContext;
}

export function listCodexModels(userId: number): Promise<CodexModel[]> {
  return cached(`codex:models:${userId}`, 60 * 60_000, async () => {
    try {
      const tokens = await ensureFreshTokens(userId);
      const res = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'chatgpt-account-id': tokens.account_id, originator: 'codex_cli_rs' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`codex models ${res.status}`);
      const data = (await res.json()) as {
        models?: {
          slug: string;
          display_name?: string;
          description?: string;
          visibility?: string;
          priority?: number;
          supported_reasoning_levels?: { effort: string }[];
          context_window?: number;
          max_context_window?: number;
          effective_context_window_percent?: number;
          auto_compact_token_limit?: number;
        }[];
      };
      const list = (data.models ?? [])
        .filter((m) => m.slug && m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((m) => ({
          id: m.slug,
          name: m.display_name || m.slug,
          ...(m.description ? { description: m.description } : {}),
          efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
          context: codexContext(m),
        }));
      if (!list.length) throw new Error('codex models: empty list');
      setSetting(`agent_models:codex:${userId}`, JSON.stringify(list));
      return list;
    } catch (err) {
      const stored = JSON.parse(getSetting(`agent_models:codex:${userId}`) ?? '[]') as CodexModel[];
      if (!stored.length) throw err;
      return stored.map((m) => ({ ...m, ...(m.context ? { context: { ...m.context, source: 'cache' as const } } : {}) }));
    }
  });
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  context: async(user, model) => (await listCodexModels(user)).find((m) => m.id === model)?.context,
  async run(call) {
    try {
      const result = await callCodex(call);
      recordAgentStatus(call.userId, 'codex', true, usageLine(result.usage));
      return result;
    } catch (err) {
      // A Stop from the user is not a provider failure: no sticky last-error, no log line.
      if (!call.signal?.aborted) recordAgentStatus(call.userId, 'codex', false, call.relayRequestId ? `Relayed model request failed. Reference ${call.relayRequestId}.` : err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
  userItem: (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
  toolOutputItem: (callId, json) => ({ type: 'function_call_output', call_id: callId, output: json }),
  repairItems: repairResponsesItems,
};
