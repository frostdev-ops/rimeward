import type { APIRoute } from 'astro';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { rimeConnection } from '../../../lib/dev/remote.ts';
import { sharedRime } from '../../../lib/agent/sync.ts';
import { applyProviderWrite, isCredentialAction, runtimeBinding } from '../../../lib/agent/provider-scope.ts';

export const prerender = false;

/** Per-user agent credentials + knobs, as the server's own Account page posts them. Form POST-back,
 *  account-page style — the same writes /api/account/provider applies, through one implementation.
 *
 *  On a desktop joined to a server this page's HTML is the SERVER's (lib/dev/instance-routing.ts), so
 *  a credential post arriving here means the page was rendered while the server was unreachable. Which
 *  account it meant is then genuinely ambiguous, so it is refused and sent to the scoped page where
 *  the destination is named. Account knobs are not credentials and stay local. */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const userId = locals.user!.userId;
  const form = await request.formData();
  const raw = String(form.get('action') ?? '');
  const back = (q: string) => redirect(`/account?${q}#agent`, 303);
  const action = /^(openrouter|openai|brave|exa)-key$/.test(raw) ? 'key' : raw;
  const provider = action === 'key' ? raw.replace('-key', '') : undefined;

  if (isCredentialAction(action) && isDesktop()) {
    if (request.headers.has('x-rimeward-native-token') || request.headers.get('x-rimeward-relayed') === '1')
      return new Response('Open provider settings on this desktop directly.', { status: 403 });
    const connection = await rimeConnection(userId).catch(() => undefined);
    if (connection && sharedRime(userId))
      return back(`err=${encodeURIComponent('This desktop is connected to a server. Choose which connection to change on the provider page.')}`);
  }
  let result: string;
  if (isCredentialAction(action) && form.get('binding') !== runtimeBinding(userId))
    return back(`err=${encodeURIComponent('This provider form is stale or from an older client. Reload Account or open Provider connections before changing a credential.')}`);
  try {
    result = applyProviderWrite(userId, { action, provider, key: form.get('key'), name: form.get('name'), url: form.get('url'), enabled: form.get('enabled'), rounds: form.get('rounds') });
  } catch (err) {
    return back(`err=${encodeURIComponent(err instanceof Error ? err.message : 'unknown-action')}`);
  }
  return back(/Cleared|removed|Disconnected/.test(result) ? 'ok=agent-cleared'
    : action === 'shell-network' || action === 'rounds' ? 'ok=agent-saved' : 'ok=agent-key');
};
