import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { sessionId } from '../../../../lib/auth.ts';
import { getDashboard } from '../../../../lib/dashboard.ts';
import { sharedVoice } from '../../../../lib/agent/sync.ts';
import { voiceAction, voiceBody } from '../../../../lib/agent/voice.ts';

export const prerender = false;
export const POST: APIRoute = async ({ params, locals, request, cookies }) => {
  const headers = { 'cache-control': 'no-store' };
  const user = locals.user?.userId, ward = String(params.ward);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers });
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'agent'))
    return Response.json({ error: 'Agent ward unavailable.' }, { status: 404, headers });
  try {
    const body = await voiceBody(request);
    const principal = `browser:${createHash('sha256').update(sessionId(cookies) ?? `local:${user}`).digest('hex')}`;
    const result = await sharedVoice(user, ward, body) ?? await voiceAction(user, ward, principal, body);
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Voice unavailable.' }, {
      status: (error as { status?: number }).status ?? 502, headers,
    });
  }
};
