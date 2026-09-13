import { createHash } from 'node:crypto';
import { getDb } from '../db.ts';
import { sealToken, openToken } from '../crypto.ts';
import { ENDPOINT_NAME_RE } from '../wards.ts';
import { isLoopbackAddress, isPrivateAddress } from '../net-guard.ts';

// Per-user agent credentials. Deliberately NOT linked_accounts: that table's
// provider CHECK and Provider union feed the ward Connect-chip machinery,
// and codex refresh is custom anyway. Sealed at rest like everything long-lived.

export type AgentAccountProvider = 'codex' | 'openrouter' | 'openai' | 'brave' | 'exa' | `compat:${string}`;

export interface AgentAccount {
  user_id: number;
  provider: AgentAccountProvider;
  label: string;
  token_enc: string;
  access_token: string;
  meta_json: string;
}

export function getAgentAccount(userId: number, provider: AgentAccountProvider): AgentAccount | null {
  return (
    (getDb()
      .prepare('SELECT * FROM agent_accounts WHERE user_id = ? AND provider = ?')
      .get(userId, provider) as AgentAccount | undefined) ?? null
  );
}

export function storeAgentAccount(opts: {
  userId: number;
  provider: AgentAccountProvider;
  token: string;
  label?: string;
  accessToken?: string;
  meta?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_accounts (user_id, provider, label, token_enc, access_token, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         label = excluded.label,
         token_enc = excluded.token_enc,
         access_token = excluded.access_token,
         meta_json = excluded.meta_json`
    )
    .run(
      opts.userId,
      opts.provider,
      opts.label ?? '',
      sealToken(opts.token),
      opts.accessToken ?? '',
      JSON.stringify(opts.meta ?? {})
    );
}

export function deleteAgentAccount(userId: number, provider: AgentAccountProvider): void {
  getDb().prepare('DELETE FROM agent_accounts WHERE user_id = ? AND provider = ?').run(userId, provider);
}

/** For key-style providers the sealed token IS the credential. */
export function agentKey(userId: number, provider: 'openrouter' | 'openai' | 'brave' | 'exa'): string | null {
  const row = getAgentAccount(userId, provider);
  if (!row) return null;
  try {
    return openToken(row.token_enc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- OpenAI-compatible endpoints
// One agent_accounts row per endpoint, provider 'compat:<name>': the base URL in
// meta_json, the key (possibly none — a local model server) sealed in token_enc.

export interface Endpoint {
  name: string;
  url: string;
  /** Masked key, or '' when the endpoint needs none. */
  label: string;
}

/** A loopback host by name or address (any spelling) — the one place plain http may carry a key. */
export const isLoopbackHost = (hostname: string): boolean => hostname.toLowerCase() === 'localhost' || isLoopbackAddress(hostname);

/** The base URL as the user gave it: https (http only to a loopback host — a
 *  local model server), no credentials, no query or hash — the provider appends
 *  /chat/completions and /models. */
export function parseEndpointUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('endpoint URL must be a full address, e.g. https://api.example.com/v1 or http://127.0.0.1:11434/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('endpoint URL must be http or https');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new Error('a remote endpoint must be https — a key is never sent in the clear; plain http is for a local server on 127.0.0.1');
  if (url.username || url.password) throw new Error('put the key in the key field, not in the URL');
  if (url.search || url.hash) throw new Error('endpoint URL must not carry a query or fragment');
  return url.toString().replace(/\/+$/, '');
}

export function listEndpoints(userId: number): Endpoint[] {
  return (getDb().prepare("SELECT provider, label, meta_json FROM agent_accounts WHERE user_id = ? AND provider LIKE 'compat:%' ORDER BY provider").all(userId) as { provider: string; label: string; meta_json: string }[])
    .map((r) => ({ name: r.provider.slice('compat:'.length), url: String(accountMeta(r as AgentAccount).url ?? ''), label: r.label }));
}

/** The endpoint's URL and key — null when the user has no endpoint by that name;
 *  a key that will not unseal throws rather than degrading to anonymous access.
 *  `revision` changes with the URL or key, so nothing cached for the old service
 *  is ever served for the new one. */
export function endpointOf(userId: number, name: string): { url: string; key: string | null; revision: string } | null {
  if (!ENDPOINT_NAME_RE.test(name)) return null;
  const row = getAgentAccount(userId, `compat:${name}`);
  if (!row) return null;
  let key: string | null;
  try { key = openToken(row.token_enc) || null; } catch { throw new Error(`endpoint "${name}": its stored key cannot be read (TOKEN_ENC_KEY changed?) — enter it again under Account → Agent`); }
  const url = String(accountMeta(row).url ?? '');
  return { url, key, revision: createHash('sha256').update(`${url}\n${key ?? ''}`).digest('hex').slice(0, 16) };
}

/** The endpoint's base URL, normalized, WITHOUT touching its key: what a stored conversation is
 *  compared against long after the credential was rotated, removed or made unreadable. A history
 *  read must never depend on unsealing today's secret. */
export function endpointUrlOf(userId: number, name: string): string | null {
  if (!ENDPOINT_NAME_RE.test(name)) return null;
  const row = getAgentAccount(userId, `compat:${name}`);
  if (!row) return null;
  return normalizeEndpoint(String(accountMeta(row).url ?? '')) || null;
}

/** Non-secret backend identity: scheme, host, explicit port and path, case- and slash-normalized.
 *  Two endpoint names on one runtime pointing here are the same backend; the same string on ANOTHER
 *  runtime is only the same backend when the host is not machine-local (see machineLocalEndpoint). */
export function normalizeEndpoint(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    const dflt = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
    const port = u.port && u.port !== dflt ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return text.replace(/\/+$/, '');
  }
}

/** True when this URL's host does NOT establish, on its own, that two runtimes mean the same server:
 *  loopback and local-only names resolve per machine, and a private LAN address names whatever holds
 *  it on the network that runtime is attached to. This is "cannot establish the same backend", not
 *  proof of a different one — the caller refuses rather than guessing either way. A fully qualified
 *  public name is the only case that answers the same wherever it is resolved, so everything else,
 *  including an unqualified single-label name and anything unparseable, fails closed. */
export function machineLocalEndpoint(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  host = host.replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const literal = /^[0-9.]+$/.test(host) || host.includes(':');
  if (literal) return isLoopbackAddress(host) || isPrivateAddress(host);
  return !host.includes('.'); // a single-label name is resolved by the local search domain, not globally
}

export function storeEndpoint(userId: number, e: { name: string; url: string; key?: string }): void {
  const name = e.name.trim().toLowerCase();
  if (!ENDPOINT_NAME_RE.test(name)) throw new Error('endpoint name: 1-40 lowercase letters, digits or dashes');
  const url = parseEndpointUrl(e.url);
  const key = (e.key ?? '').trim();
  storeAgentAccount({ userId, provider: `compat:${name}`, token: key, label: key ? mask(key) : '', meta: { url } });
}

export function deleteEndpoint(userId: number, name: string): void {
  if (ENDPOINT_NAME_RE.test(name)) deleteAgentAccount(userId, `compat:${name}`);
}

export const mask = (v: string): string => (v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`);

export function accountMeta(row: AgentAccount): Record<string, unknown> {
  try {
    return JSON.parse(row.meta_json);
  } catch {
    return {};
  }
}
