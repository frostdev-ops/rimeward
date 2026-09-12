// The hook endpoint a Rime-launched CLI's lifecycle hooks call (lib/dev/cli-bridge.ts).
// Public in the middleware sense only: loopback plus the per-session bearer decide access.
import type { APIRoute } from 'astro';
import { authenticateCli, handleCliHook } from '../../../../lib/dev/cli-bridge.ts';
import { handleCliMcp } from '../../../../lib/dev/cli-mcp.ts';
import { workDb } from '../../../../lib/dev/runtime.ts';
import { DevError, isDesktop } from '../../../../lib/dev/runtime.ts';
import { isLoopbackAddress } from '../../../../lib/net-guard.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const POST: APIRoute = async ({ params, request, clientAddress }) => {
  if (!isDesktop() || !['hook', 'mcp'].includes(params.action ?? '')) return json({ error: 'Not found' }, 404);
  if (!isLoopbackAddress(clientAddress)) return json({ error: 'Loopback only' }, 403);
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const session = params.session ?? '';
  const text = await request.text();
  if (params.action === 'mcp') {
    // The CLI's MCP client (lib/dev/cli-mcp.ts). Same loopback + per-session bearer; JSON replies only.
    if (text.length > 262144) return json({ error: 'Payload too large' }, 413);
    if (!authenticateCli(session, token)) return json({ error: 'Unknown session' }, 401);
    const row = workDb().prepare('SELECT user_id FROM terminal_sessions WHERE id=?').get(session) as { user_id: number } | undefined;
    if (!row) return json({ error: 'Unknown session' }, 401);
    const out = await handleCliMcp(row.user_id, session, text);
    return out.body === undefined ? new Response(null, { status: out.status }) : json(out.body, out.status);
  }
  if (text.length > 65536) return json({ error: 'Payload too large' }, 413);
  let payload: unknown;
  try { payload = JSON.parse(text || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
  try {
    const out = await handleCliHook(session, token, payload);
    return Object.keys(out).length ? json(out) : new Response(null, { status: 204 });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'hook failed' }, e instanceof DevError ? e.status : 400);
  }
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405);
