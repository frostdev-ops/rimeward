import { deliverBroker,rejectBroker } from '../../../../lib/oauth-broker.ts';
import type { APIRoute } from 'astro';
import { takeConnectState } from '../../../../lib/oauth.ts';
import { decodeIdToken } from '../../../../lib/google-sso.ts';
import { exchangeMicrosoftCode } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  if(pending?.brokerId && pending.userId && url.searchParams.has('error')){rejectBroker(pending.brokerId,pending.userId);return redirect('/oauth/broker?done=1&error=denied',303);}
  if (!pending || pending.provider !== 'microsoft' || !pending.userId)
    return redirect('/account?err=ms-connect', 303);

  // Locked-down tenants commonly deny Mail.Send: retry once automatically with
  // the read-only scope set. The compose UI hides send when 'Mail.Send' is
  // absent from the stored scopes.
  const error = url.searchParams.get('error');
  if (error) {
    return redirect('/account?err=ms-denied', 303);
  }

  const code = url.searchParams.get('code');
  if (!code) return redirect('/account?err=ms-connect', 303);

  try {
    const tokens = await exchangeMicrosoftCode(code);
    if (!tokens.refresh_token) throw new Error('missing refresh_token');
    // Same base64url JWT shape as Google's; only the email-ish claim differs.
    const claims = tokens.id_token
      ? (decodeIdToken(tokens.id_token) as { email?: string; preferred_username?: string })
      : {};
    if(pending.brokerId){deliverBroker(pending.brokerId,pending.userId,{...tokens,label:claims.email??claims.preferred_username??'Microsoft'});return redirect('/oauth/broker?done=1',303);}
    storeLink({
      userId: pending.userId,
      provider: 'microsoft',
      label: claims.email ?? claims.preferred_username ?? 'outlook',
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      scopes: tokens.scope ?? '',
    });
    return redirect('/dash?connected=Microsoft', 303);
  } catch (err) {
    if(pending.brokerId){rejectBroker(pending.brokerId,pending.userId);return redirect('/oauth/broker?done=1&error=failed',303);}
    console.error('[connect microsoft] token exchange failed');
    return redirect('/account?err=ms-connect', 303);
  }
};
