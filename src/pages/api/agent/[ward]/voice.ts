import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { sessionId } from '../../../../lib/auth.ts';
import { getDashboard } from '../../../../lib/dashboard.ts';
import { sharedRime, sharedVoice } from '../../../../lib/agent/sync.ts';
import { clearVoiceRoute, pinVoiceRoute, pinnedVoiceRoute, resolveProviderRoute } from '../../../../lib/agent/route.ts';
import { voiceAction, voiceBody } from '../../../../lib/agent/voice.ts';

export const prerender = false;

// A live call belongs to the installation that holds its lease, for its whole life.
//
// Start resolves the owner ONCE and records it — which installation, which server account, and the
// lease itself. Every later action is answered by that owner or by nobody: a local lease never
// stands in for a remote one, a stop is never claimed on behalf of a runtime we cannot reach, and an
// owner we do not know is reported rather than guessed.

export const POST: APIRoute = async ({ params, locals, request, cookies }) => {
  const headers = { 'cache-control': 'no-store' };
  const user = locals.user?.userId, ward = String(params.ward);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers });
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'agent'))
    return Response.json({ error: 'Agent ward unavailable.' }, { status: 404, headers });
  try {
    const body = await voiceBody(request);
    const principal = `browser:${createHash('sha256').update(sessionId(cookies) ?? `local:${user}`).digest('hex')}`;
    const local = () => voiceAction(user, ward, principal, body);
    let result: Awaited<ReturnType<typeof voiceAction>>;
    if (body.action === 'start') {
      const route = await resolveProviderRoute(user, 'codex');
      if (route.blocked) throw Object.assign(new Error(route.blocked), { status: 409 });
      if (route.via === 'server') {
        const pin = { serverId: route.server?.id, profile: route.server?.profile, runtime: route.server?.runtime, credential: route.serverCredential };
        const reply = await sharedVoice(user, ward, body, pin);
        if (!reply) throw Object.assign(new Error(`Voice runs on the connected server${route.server ? ` (${route.server.host})` : ''} for this account, and it is not available. No call was started on another account.`), { status: 503 });
        pinVoiceRoute(user, ward, { via: 'server', ...pin, ...(reply.lease ? { lease: reply.lease } : {}) });
        result = reply;
      } else {
        if (!route.credential) throw Object.assign(new Error('Connect ChatGPT on this runtime before starting voice.'), { status: 503 });
        result = await voiceAction(user, ward, principal, body, route.credential);
        pinVoiceRoute(user, ward, { via: 'local', ...(result.lease ? { lease: result.lease } : {}) });
      }
    } else {
      const owner = pinnedVoiceRoute(user, ward);
      if (!owner)
        // Unknown ownership. Answering from here would either report a call stopped that is still
        // running elsewhere, or claim a lease this runtime never held.
        throw Object.assign(new Error('This runtime has no record of where that call is running, so it was not controlled from here. It ends on its own when its heartbeat lapses; start a new call when you are ready.'), { status: 409 });
      // The lease the client names must be the one the receipt recorded: a stale tab cannot stop a
      // call that replaced the one it was looking at.
      if (owner.lease && 'lease' in body && body.lease && body.lease !== owner.lease)
        throw Object.assign(new Error('That call has already ended and another has taken its place. Nothing was stopped.'), { status: 409 });
      if (owner.via === 'server') {
        const reply = await sharedVoice(user, ward, body, owner);
        // Only a real answer from the owner clears the receipt: an unreachable owner still holds the
        // call, and forgetting it here would be a claim that it stopped.
        const held = sharedRime(user);
        if (!reply) throw Object.assign(new Error(`This call is running on the connected server${held ? ` (${new URL(held.server).host})` : ''}, which is not reachable. It was not ${body.action === 'stop' ? 'stopped' : 'answered'} from here; it ends there when its heartbeat lapses.`), { status: 503 });
        result = reply;
        if (reply.closed === true) clearVoiceRoute(user, ward);
      } else {
        result = await local();
        if (result.closed === true) clearVoiceRoute(user, ward);
      }
    }
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Voice unavailable.' }, {
      status: (error as { status?: number }).status ?? 502, headers,
    });
  }
};
