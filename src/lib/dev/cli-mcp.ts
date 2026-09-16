// The MCP server one Rime-launched CLI talks to: streamable HTTP, JSON-RPC 2.0, JSON replies
// only (no SSE), four tools, no SDK — the shapes mirror what lib/agent/mcp.ts reads as a client.
// Auth and the session are settled by the route; everything here is scoped to that session.
import { askStrategy } from './cli-ask.ts';
import { cliContext, cliReport, cliStatus } from './cli-bridge.ts';

const VERSIONS = ['2025-06-18', '2025-03-26'];
const strings = (v: unknown, max: number, each: number) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && x.length <= each) ? (v as string[]) : null;
const TOOLS = [
  { name: 'rime_status', description: 'Report progress worth knowing (a milestone, a blocker, a change of plan) to Rime. Not for every step.', inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 2000 } }, required: ['message'], additionalProperties: false } },
  { name: 'rime_ask', description: 'Ask Rime a clarifying question or for a decision. Blocks until Rime answers (up to 30 minutes); ask once, with the options you see.', inputSchema: { type: 'object', properties: { question: { type: 'string', maxLength: 4000 }, options: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, required: ['question'], additionalProperties: false } },
  { name: 'rime_report', description: 'Report the task complete or blocked, exactly once: what changed and what was checked. Completion without this report does not count.', inputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 4000 }, changed_files: { type: 'array', items: { type: 'string' }, maxItems: 100 }, checks: { type: 'array', items: { type: 'string' }, maxItems: 50 } }, required: ['summary'], additionalProperties: false } },
  { name: 'rime_context', description: 'The task, assignment, project and permission mode this session was started with.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

async function call(user: number, session: string, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'rime_status': {
      if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 2000) throw Error('message: a string of at most 2000 characters');
      await cliStatus(session, args.message.trim()); return 'Noted.';
    }
    case 'rime_ask': {
      if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 4000) throw Error('question: a string of at most 4000 characters');
      const options = args.options === undefined ? undefined : strings(args.options, 8, 200);
      if (args.options !== undefined && !options) throw Error('options: at most 8 strings');
      return askStrategy.ask({ user, session, question: args.question.trim(), options: options ?? undefined });
    }
    case 'rime_report': {
      if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 4000) throw Error('summary: a string of at most 4000 characters');
      const files = args.changed_files === undefined ? [] : strings(args.changed_files, 100, 500), checks = args.checks === undefined ? [] : strings(args.checks, 50, 500);
      if (!files || !checks) throw Error('changed_files: at most 100 strings; checks: at most 50 strings');
      await cliReport(session, args.summary.trim(), files, checks); return 'Reported to Rime.';
    }
    case 'rime_context': return cliContext(session);
    default: throw Error(`Unknown tool: ${name}`);
  }
}

const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message (already authenticated) → { status, body }. Notifications get 202/no body. */
export async function handleCliMcp(user: number, session: string, text: string): Promise<{ status: number; body?: unknown }> {
  let msg: Record<string, unknown>;
  try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0; msg = parsed; } catch { return { status: 400, body: error(null, -32700, 'Parse error') }; }
  const { id, method, params } = msg;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return { status: 400, body: error(id, -32600, 'Invalid request') };
  if (id === undefined || method.startsWith('notifications/')) return { status: 202 }; // notification (or a response we never asked for)
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  switch (method) {
    case 'initialize': return ok({ protocolVersion: VERSIONS.includes(p.protocolVersion as string) ? p.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'rime', version: '1' }, instructions: 'Rime coordinates this session: report progress with rime_status, ask with rime_ask, finish with rime_report.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      if (typeof p.name !== 'string') return { status: 400, body: error(id, -32602, 'tools/call needs name') };
      const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
      try { return ok({ content: [{ type: 'text', text: await call(user, session, p.name, args) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : 'tool failed' }], isError: true }); }
    }
    default: return { status: 200, body: error(id, -32601, `Method not found: ${method}`) };
  }
}
