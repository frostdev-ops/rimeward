import { zohoAccountsBase } from '../../../lib/connect.ts';
import { disconnectBrokerConnection } from '../../../lib/broker-client.ts';
import type { APIRoute } from 'astro';
import { getLink, deleteLink, getMeta, type Provider } from '../../../lib/linked-accounts.ts';
import { openToken } from '../../../lib/crypto.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const provider = String(form.get('provider')) as Provider;
  if (!['google', 'microsoft', 'notion', 'zoho', 'mailbox', 'icloud'].includes(provider))
    return redirect('/account?err=unknown-provider', 303);

  const userId = locals.user!.userId;
  const link = getLink(userId, provider);

  // Best-effort revoke; the row is deleted regardless.
  if (link && provider === 'google') {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: openToken(link.refresh_token_enc) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }
  if (link && provider === 'zoho') {
    try {
      const base = zohoAccountsBase(String(getMeta(link).accounts_base ?? 'https://accounts.zoho.com'));
      await fetch(`${base}/oauth/v2/token/revoke?token=${encodeURIComponent(openToken(link.refresh_token_enc))}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }

  if(link && getMeta(link).broker) await disconnectBrokerConnection(userId,provider).catch(()=>{});
  deleteLink(userId, provider);
  return redirect('/account?ok=disconnected', 303);
};
