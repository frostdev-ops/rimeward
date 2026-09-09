import type { APIRoute } from 'astro';
import { setSetting } from '../../../lib/settings.ts';
import { storeAgentAccount, deleteAgentAccount, storeEndpoint, deleteEndpoint, mask } from '../../../lib/agent/accounts.ts';
import { codexOauthStart, codexOauthFinish, codexOauthCancel, codexDisconnect } from '../../../lib/agent/codex.ts';
import { parseRounds } from '../../../lib/agent/provider.ts';
import { storeBrowserbaseKey } from '../../../lib/browser/browserbase.ts';

export const prerender = false;

/** Per-user agent credentials + knobs. Form POST-back, account-page style. */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const userId = locals.user!.userId;
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const back = (q: string) => redirect(`/account?${q}#agent`, 303);

  if (action === 'openrouter-key' || action === 'openai-key' || action === 'brave-key' || action === 'exa-key') {
    const provider = action.replace('-key', '') as 'openrouter' | 'openai' | 'brave' | 'exa';
    const key = String(form.get('key') ?? '').trim();
    if (!key) {
      deleteAgentAccount(userId, provider);
      return back(`ok=agent-cleared`);
    }
    storeAgentAccount({ userId, provider, token: key, label: mask(key) });
    return back(`ok=agent-key`);
  }

  // An OpenAI-compatible endpoint: a name, a base URL (https, or http to this
  // machine), an optional key — sealed like every other credential.
  if (action === 'endpoint-add') {
    try {
      storeEndpoint(userId, { name: String(form.get('name') ?? ''), url: String(form.get('url') ?? ''), key: String(form.get('key') ?? '') });
      return back('ok=agent-key');
    } catch (err) {
      return back(`err=${encodeURIComponent(err instanceof Error ? err.message : 'bad endpoint')}`);
    }
  }
  if (action === 'endpoint-remove') {
    deleteEndpoint(userId, String(form.get('name') ?? ''));
    return back('ok=agent-cleared');
  }

  if (action === 'browserbase-key') {
    storeBrowserbaseKey(userId, String(form.get('key') ?? '').trim());
    return back('ok=agent-key');
  }

  if (action === 'codex-start') {
    codexOauthStart(userId);
    return back('ok=codex-start');
  }
  if (action === 'codex-cancel') {
    codexOauthCancel(userId);
    return back('ok=agent-cleared');
  }
  if (action === 'codex-finish') {
    try {
      const email = await codexOauthFinish(userId, String(form.get('pasted') ?? ''));
      return back(`connected=${encodeURIComponent(`ChatGPT${email ? ` (${email})` : ''}`)}`);
    } catch (err) {
      return back(`err=${encodeURIComponent(err instanceof Error ? err.message : 'sign-in failed')}`);
    }
  }
  if (action === 'codex-disconnect') {
    codexDisconnect(userId);
    return back('ok=agent-cleared');
  }

  if (action === 'shell-network') {
    setSetting(`agent_shell_network:${userId}`, form.get('enabled') === 'on' ? 'true' : 'false');
    return back('ok=agent-saved');
  }
  if (action === 'rounds') {
    // 0 = unlimited. A blank or junk field leaves the current value alone —
    // parseRounds is the same check the reader uses, so the two cannot drift.
    const n = parseRounds(form.get('rounds'));
    if (n !== null) setSetting(`agent_rounds:${userId}`, String(n));
    return back('ok=agent-saved');
  }

  return back('err=unknown-action');
};
