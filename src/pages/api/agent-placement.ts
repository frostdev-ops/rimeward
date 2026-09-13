import type { APIRoute } from 'astro';
import { agentPlacementAction, agentDirectoryAction, newAgentConversation } from '../../lib/dev/agent-placement.ts';
import { DevError } from '../../lib/dev/runtime.ts';

export const prerender = false;
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    if (!locals.user) throw new DevError('Sign in required.', 401);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DevError('Invalid conversation request.');
    const result = body.action === 'new' ? await newAgentConversation(locals.user.userId, body) : String(body.action).startsWith('directory-') ? await agentDirectoryAction(locals.user.userId, body) : await agentPlacementAction(locals.user.userId, body);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof DevError ? e.status : 400 }); }
};
