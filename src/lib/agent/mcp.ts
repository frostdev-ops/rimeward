import { getDashboard } from '../dashboard.ts';
import { createHash } from 'node:crypto';
import { deleteSetting, getSetting, setSetting } from '../settings.ts';
import { openToken, sealToken } from '../crypto.ts';
import { MCP_TRUST, type McpTrust, type WardInstance } from '../wards.ts';
import { vettedFetch } from './shell.ts';
import type { ToolCtx, ToolDef } from './tools.ts';

// MCP over streamable HTTP — the CLIENT side, remote servers only. A server
// is an `mcp` ward: its url, a slug that prefixes its tools, the auth header
// and a trust level ride the ward's config; the token is sealed in a settings
// row, never in the layout and never under /work (the agent's shell reads
// /work, and with the network on that is an exfil path). Every request goes
// through vettedFetch, the same SSRF guard the sandbox's curl has — a server
// url that resolves to this box, or to anything private, is refused.
//
// No stdio servers: pm2 runs the app as root and the sandbox is an
// interpreter, not a process runner. A published server package runs
// elsewhere and is reached over HTTP.
//
// Trust: a server's tools are all one kind — read (free), write (paused under
// the ward's approvals = all) or confirm (always paused) — set per ward,
// default write. The server's own readOnlyHint annotations are ignored: a
// server can claim anything about itself.

export const MCP_PROTOCOL = '2025-06-18';

export interface McpConfig {
  /** [a-z0-9-], the tool prefix: mcp__<name>__<tool>. */
  name: string;
  url: string;
  /** The header the token rides — Authorization gets "Bearer " in front. */
  header: string;
  trust: McpTrust;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpStatus {
  ok: boolean;
  error?: string;
  tools: McpTool[];
  server?: { name?: string; version?: string };
  hasToken: boolean;
  /** unix ms of the connect (or the failure). */
  at: number;
}

type Fetch = typeof vettedFetch;

interface Session {
  signature:string;
  id?: string;
  tools: McpTool[];
  server?: { name?: string; version?: string };
  at: number;
  error?: string;
}

const SESSION_TTL = 10 * 60_000;
const FAILURE_TTL = 60_000; // a dead server must not stall every turn
const TIMEOUT_MS = 25_000;
const MAX_TOOLS = 80;

/** One live session per (user, ward), the tool list with it. */
const sessions = new Map<string, Session>();
const key = (userId: number, ward: string) => `${userId}:${ward}`;

// ---------------------------------------------------------------- config

export function mcpConfig(w: WardInstance): McpConfig {
  const c = (w.config ?? {}) as Record<string, unknown>;
  return {
    name: typeof c.name === 'string' ? c.name : 'mcp',
    url: typeof c.url === 'string' ? c.url : '',
    header: typeof c.header === 'string' && c.header.trim() ? c.header.trim() : 'Authorization',
    trust: (MCP_TRUST as readonly string[]).includes(c.trust as string) ? (c.trust as McpTrust) : 'write',
  };
}

/** The stored ward, never the client's copy. */
export function mcpWard(userId: number, ward: unknown): WardInstance | null {
  return getDashboard(userId).find((w) => w.i === ward && w.type === 'mcp') ?? null;
}

const tokenKey = (userId: number, ward: string) => `mcp_token:${userId}:${ward}`;

export function setMcpToken(userId: number, ward: string, token: string | null): void {
  if (token) setSetting(tokenKey(userId, ward), sealToken(token));
  else deleteSetting(tokenKey(userId, ward));
  sessions.delete(key(userId, ward));
}

export function hasMcpToken(userId: number, ward: string): boolean {
  return getSetting(tokenKey(userId, ward)) !== null;
}

function authHeaders(userId: number, ward: string, cfg: McpConfig): Record<string, string> {
  const sealed = getSetting(tokenKey(userId, ward));
  if (!sealed) return {};
  let token: string;
  try {
    token = openToken(sealed);
  } catch {
    return {};
  }
  return { [cfg.header]: cfg.header.toLowerCase() === 'authorization' ? `Bearer ${token}` : token };
}

// ---------------------------------------------------------------- wire

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The response to request `id` out of a body that is either one JSON
 *  message or an SSE stream of them (the server picks per request). */
export function parseRpcBody(contentType: string, text: string, id: number): RpcMessage | null {
  if (!contentType.includes('text/event-stream')) {
    if (!text.trim()) return null;
    const msg = JSON.parse(text) as RpcMessage | RpcMessage[];
    return (Array.isArray(msg) ? msg : [msg]).find((m) => m.id === id) ?? null;
  }
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcMessage;
      if (msg.id === id) return msg;
    } catch {
      /* a keepalive or a partial line — skip */
    }
  }
  return null;
}

let nextId = 1;

async function rpc(
  fetchImpl: Fetch,
  cfg: McpConfig,
  headers: Record<string, string>,
  session: { id?: string },
  method: string,
  params: Record<string, unknown>,
  notification = false
): Promise<unknown> {
  const id = nextId++;
  const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  const res = await fetchImpl(cfg.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL,
      ...(session.id ? { 'mcp-session-id': session.id } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
  });
  const sid = res.headers['mcp-session-id'];
  if (sid) session.id = sid;
  if (res.status === 401 || res.status === 403) throw new Error(`the server refused the credentials (${res.status})`);
  if (res.status === 404 && session.id) throw Object.assign(new Error('session expired'), { expired: true });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  if (notification) return undefined;
  const text = Buffer.from(res.body).toString('utf8');
  const msg = parseRpcBody(res.headers['content-type'] ?? '', text, id);
  if (!msg) throw new Error(`no response to ${method}`);
  if (msg.error) throw new Error(`${method}: ${msg.error.message} (${msg.error.code})`);
  return msg.result;
}

function readTools(result: unknown): McpTool[] {
  const list = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
    .slice(0, MAX_TOOLS)
    .map((t) => {
      const r = t as { name: string; description?: unknown; inputSchema?: unknown };
      const schema = r.inputSchema && typeof r.inputSchema === 'object' ? (r.inputSchema as Record<string, unknown>) : {};
      return {
        name: r.name,
        description: typeof r.description === 'string' ? r.description.slice(0, 1000) : '',
        inputSchema: schema.type === 'object' ? schema : { type: 'object', properties: {} },
      };
    });
}

/** initialize → initialized → tools/list, once per SESSION_TTL; a failure is
 *  remembered for FAILURE_TTL so a dead server costs one request a minute. */
export async function connect(userId: number, ward: string, fetchImpl: Fetch = vettedFetch): Promise<Session> {
  const k = key(userId, ward);
  const cur = sessions.get(k);
  const now = Date.now();
  const w = mcpWard(userId, ward);
  if (!w) throw new Error('not an mcp ward');
  const cfg = mcpConfig(w);
  const signature = sessionSignature(userId,w);
  if (cur?.signature === signature && now - cur.at < (cur.error ? FAILURE_TTL : SESSION_TTL)) return cur;
  if (!cfg.url) throw new Error('no server url configured');
  const headers = authHeaders(userId, ward, cfg);
  const session: Session = { tools: [], at: now,signature };
  try {
    const init = (await rpc(fetchImpl, cfg, headers, session, 'initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'rimeward', version: '1' },
    })) as { serverInfo?: { name?: string; version?: string } } | null;
    session.server = init?.serverInfo;
    await rpc(fetchImpl, cfg, headers, session, 'notifications/initialized', {}, true);
    session.tools = readTools(await rpc(fetchImpl, cfg, headers, session, 'tools/list', {}));
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err);
  }
  sessions.set(k, session);
  return session;
}

export function dropSession(userId: number, ward: string): void {
  sessions.delete(key(userId, ward));
}

/** tools/call. An expired session reconnects once. */
export async function callTool(userId: number, ward: string, tool: string, args: Record<string, unknown>, fetchImpl: Fetch = vettedFetch, expected?:string): Promise<unknown> {
  let revision = expected;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await connect(userId, ward, fetchImpl);
    if (session.error) throw new Error(`MCP server not connected: ${session.error}`);
    const w = mcpWard(userId, ward);
    if (!w || session.signature !== sessionSignature(userId,w)) throw Error('MCP credentials or trust changed; search and propose the call again.');
    const cfg = mcpConfig(w);
    const definition = session.tools.find(t => t.name === tool);
    if (!definition) throw Error('MCP tool definition is no longer available; search again.');
    revision ??= definitionRevision(session.signature,definition);
    try {
      session.tools = readTools(await rpc(fetchImpl,cfg,authHeaders(userId,ward,cfg),session,'tools/list',{}));
      const current = mcpWard(userId,ward), fresh = session.tools.find(t => t.name === tool);
      if (!current || session.signature !== sessionSignature(userId,current) || !fresh || revision !== definitionRevision(session.signature,fresh)) {
        throw Error('MCP schema, credentials or trust changed since discovery; search and propose the call again.');
      }
      return await rpc(fetchImpl, cfg, authHeaders(userId, ward, cfg), session, 'tools/call', { name: tool, arguments: args });
    } catch (err) {
      if ((err as { expired?: boolean }).expired && attempt === 0) {
        dropSession(userId, ward);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

/** The text of a tools/call result — content parts joined, images noted. */
export function toolText(result: unknown): string {
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: boolean } | null;
  const parts = Array.isArray(r?.content) ? r!.content : [];
  const text = parts
    .map((p) => {
      const c = p as { type?: string; text?: string; mimeType?: string };
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image' || c.type === 'audio') return `[${c.type} ${c.mimeType ?? ''} omitted]`;
      return JSON.stringify(c);
    })
    .join('\n');
  const structured = r?.structuredContent !== undefined ? `\n${JSON.stringify(r!.structuredContent)}` : '';
  return `${r?.isError ? 'ERROR: ' : ''}${text}${structured}`.trim();
}

export async function mcpStatus(userId: number, ward: string, fresh = false, fetchImpl: Fetch = vettedFetch): Promise<McpStatus> {
  if (fresh) dropSession(userId, ward);
  const hasToken = hasMcpToken(userId, ward);
  try {
    const s = await connect(userId, ward, fetchImpl);
    return { ok: !s.error, error: s.error, tools: s.tools, server: s.server, hasToken, at: s.at };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [], hasToken, at: Date.now() };
  }
}

// ---------------------------------------------------------------- the splice

/** Provider tool names are [A-Za-z0-9_-]{1,64}; MCP names are anything. */
export const safeToolName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
const sessionSignature = (user:number,w:WardInstance) => JSON.stringify([w.i,mcpConfig(w),getSetting(`mcp_token:${user}:${w.i}`)]);
const definitionRevision = (signature:string,t:McpTool) => createHash('sha256').update(JSON.stringify([signature,t])).digest('hex');

/** Every configured MCP server's tools as registry entries, keyed
 *  mcp__<server>__<tool>. Servers that fail to connect contribute nothing
 *  this turn (the ward shows why). */
export async function mcpToolDefs(userId: number, fetchImpl: Fetch = vettedFetch): Promise<Record<string, ToolDef>> {
  for (const w of getDashboard(userId)) {
    if (w.type === 'mcp' && mcpConfig(w).url) await connect(userId, w.i, fetchImpl);
  }
  return mcpToolDefsSync(userId, fetchImpl);
}

/** The same, from sessions already open — no network. For resuming a parked
 *  confirm: the connect that produced the call is at most SESSION_TTL old. */
export function mcpToolDefsSync(userId: number, fetchImpl: Fetch = vettedFetch): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};
  for (const w of getDashboard(userId)) {
    if (w.type !== 'mcp') continue;
    const cfg = mcpConfig(w);
    const session = sessions.get(key(userId, w.i));
    if (!cfg.url || !session || session.error || session.signature !== sessionSignature(userId,w)) continue;
    for (const t of session.tools) {
      const name = `mcp__${cfg.name}__${safeToolName(t.name)}`.slice(0, 64);
      if (out[name]) continue;
      const revision = definitionRevision(session.signature,t);
      out[name] = {
        revision,
        kind: cfg.trust,
        description: `[${cfg.name} MCP server] ${t.description || t.name}`,
        parameters: t.inputSchema,
        run: async (args: Record<string, unknown>, ctx: ToolCtx) => {
          await connect(ctx.userId,w.i,fetchImpl);
          const current = mcpToolDefsSync(ctx.userId,fetchImpl)[name];
          if (!current || current.revision !== revision) throw Error('MCP definition or permissions changed since discovery; search and propose the call again.');
          const { reason: _reason, ...rest } = args;
          const result = await callTool(ctx.userId, w.i, t.name, rest, fetchImpl,current.revision);
          return { text: toolText(result) };
        },
      };
    }
  }
  return out;
}
