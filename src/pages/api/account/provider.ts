import type { APIRoute } from 'astro';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { instanceRequestOn, primaryServer, rimeConnection, setPrimaryServer, type Pair } from '../../../lib/dev/remote.ts';
import { sharedRime, syncRime } from '../../../lib/agent/sync.ts';
import { applyProviderWrite, policyState, providerScopeStatus, runtimeBinding, oauthServerBinding, setPolicy, type ProviderScopeStatus } from '../../../lib/agent/provider-scope.ts';

export const prerender = false;

// Destination-bound provider management.
//
// Every request NAMES the installation it acts on — `runtime` (the one serving this request) or
// `server` (the designated shared server, over the pairing this desktop already holds). Nothing is
// inferred: a missing or unrecognized target is refused rather than defaulted, and every operation
// carries the binding its form was rendered with, so a stale form after an unpair, a server switch
// or an account replacement is rejected instead of applied to whatever is current now.
//
// No client-supplied server address, user id or bearer token is ever accepted, and the connection a
// request validates is the connection it is sent on: the transport is handed that resolved pairing
// rather than looking the designated server up again between the check and the send.

const headers = { 'cache-control': 'no-store' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const fail = (message: string, status = 400) => json({ error: message }, status);

/** The server card's binding: the pairing, the shared profile, and the server's own runtime binding.
 *  All three must still hold, and the last is re-checked by the server itself. */
const serverBinding = (pairId: string, profile: string, remote: string) => `server:${pairId}:${profile}:${remote}`;

/** The designated server AND the shared record that describes it, or a reason there is none. One
 *  resolution, reused for the whole operation. */
async function destination(user: number): Promise<{ pair?: Pair; shared?: NonNullable<ReturnType<typeof sharedRime>>; error?: string }> {
  if (!isDesktop()) return { error: 'This installation has no connected server.' };
  const pair = await rimeConnection(user).catch(() => undefined);
  const shared = sharedRime(user) ?? undefined;
  if (!pair || !shared) return { error: 'No designated server is connected. Nothing was changed.' };
  if ((shared.caps?.providerScope ?? 0) < 2 || shared.authority !== true || shared.pair !== pair.id)
    return { error: `Update ${new URL(shared.server).host} to manage its provider connections from here. Its own Account → Agent page still works.` };
  return { pair, shared };
}

async function serverScope(user: number): Promise<{ card?: ProviderScopeStatus & { host: string }; error?: string }> {
  const { pair, shared, error } = await destination(user);
  if (!pair || !shared) return error && isDesktop() && sharedRime(user) ? { error } : {};
  try {
    const response = await instanceRequestOn(pair, user, '/api/account/provider', new Request('https://rimeward.invalid/api/account/provider'));
    if (!response.ok) return { error: 'The connected server did not answer. Its connections are unchanged.' };
    const body = await response.json() as { runtime?: ProviderScopeStatus };
    if (!body.runtime?.binding) return { error: 'The connected server did not answer with a provider scope.' };
    if (!body.runtime.oauthBinding) return { error: 'Update the connected server before managing sign-in here.' };
    return { card: { ...body.runtime, kind: 'server', host: new URL(shared.server).host,
      binding: serverBinding(pair.id, shared.profile, body.runtime.binding),
      oauthBinding: oauthServerBinding(pair.id, shared.profile, body.runtime.oauthBinding) } };
  } catch {
    return { error: 'The connected server is not reachable. Its connections are unchanged.' };
  }
}

/** Local credential management belongs to the person sitting at this desktop, not to a relayed or
 *  native-token caller — the same refusal the OAuth route already applies. */
const relayed = (request: Request) =>
  isDesktop() && (request.headers.has('x-rimeward-native-token') || request.headers.get('x-rimeward-relayed') === '1');

export const GET: APIRoute = async ({ request, locals }) => {
  if (relayed(request)) return fail('Open provider settings on this desktop directly.', 403);
  const user = locals.user!.userId;
  const runtime = providerScopeStatus(user);
  if (!isDesktop()) return json({ runtime, server: null, ...policyState(user), pairs: [], primary: null, designated: false, connection: null });
  await syncRime(user).catch(() => {});
  const { card, error } = await serverScope(user);
  const primary = await primaryServer(user).catch(() => ({ id: null, pairs: [], designated: false }));
  const shared = sharedRime(user);
  return json({
    runtime, server: card ?? null, ...(error ? { serverError: error } : {}),
    ...policyState(user),
    pairs: primary.pairs, primary: primary.id, designated: primary.designated,
    // Reachability, identity and sync health are three facts and are shown as three.
    connection: shared ? { host: new URL(shared.server).host, reachable: shared.reachable, authority: shared.authority, synced: shared.online, error: shared.error } : null,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (relayed(request)) return fail('Open provider settings on this desktop directly.', 403);
  const user = locals.user!.userId;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return fail('Expected JSON.'); }
  // An unnamed destination is a refusal, never a default: choosing one here is exactly the mistake
  // this endpoint exists to remove.
  if (body.target !== 'runtime' && body.target !== 'server')
    return fail('Name the connection this change is for. Reload the provider page and try again.', 400);
  const target = body.target;
  const binding = typeof body.binding === 'string' ? body.binding : '';
  if (!binding) return fail('This change carried no connection identity. Reload the provider page and try again.', 409);
  try {
    if (body.action === 'policy' || body.action === 'primary') {
      // Both are properties of THIS runtime: they say where its own runs go and which server holds
      // account authority for it. Neither is ever forwarded.
      if (target !== 'runtime') return fail('Model access and the designated server are set on the runtime that owns the run.', 400);
      if (binding !== runtimeBinding(user)) return fail('This page was showing a different installation or account. Reload it.', 409);
      if (!isDesktop()) return fail('This runtime has no other connection to choose between.', 400);
      if (body.action === 'policy') return json({ ok: setPolicy(user, body.policy), ...policyState(user) });
      await setPrimaryServer(user, String(body.id ?? ''));
      return json({ ok: 'Designated server saved.' });
    }
    if (target === 'server') {
      const { pair, shared, error } = await destination(user);
      if (!pair || !shared) return fail(error ?? 'No designated server is connected. Nothing was changed.', error?.startsWith('Update') ? 426 : 409);
      const parts = binding.split(':');
      const remote = parts.slice(3).join(':');
      if (parts[0] !== 'server' || parts[1] !== pair.id || parts[2] !== shared.profile || !remote)
        return fail('This form was rendered for a different server connection. Reload the page.', 409);
      // The binding travels with the write: the server re-checks its own generation where it applies
      // it, and the request goes on the connection that was just validated, not a fresh lookup.
      const response = await instanceRequestOn(pair, user, '/api/account/provider', new Request('https://rimeward.invalid/api/account/provider', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, target: 'runtime', binding: remote }),
      }));
      const value = await response.json().catch(() => ({ error: 'The connected server did not answer.' }));
      return json(value, response.ok ? 200 : response.status);
    }
    if (binding !== runtimeBinding(user))
      return fail('This form was rendered against a different installation or account. Reload the page.', 409);
    return json({ ok: applyProviderWrite(user, body as never), runtime: providerScopeStatus(user) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Provider update failed.', (e as { status?: number }).status ?? 400);
  }
};
