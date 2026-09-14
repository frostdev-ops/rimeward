import { brokerDone,deliverBroker,rejectBroker } from '../../../../lib/oauth-broker.ts';
import type { APIRoute } from 'astro';
import { takeConnectState } from '../../../../lib/oauth.ts';
import { exchangeGoogleCode, decodeIdToken } from '../../../../lib/google-sso.ts';
import { connectRedirectUri } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  if(pending?.brokerId && pending.userId && url.searchParams.has('error')){rejectBroker(pending.brokerId,pending.userId);return redirect(brokerDone(pending.brokerId,'google','denied'),303);}
  const code = url.searchParams.get('code');
  if (!pending || pending.provider !== 'google' || !pending.userId || !code)
    return redirect('/account?err=google-connect', 303);

  try {
    const tokens = await exchangeGoogleCode(code, connectRedirectUri('google'));
    if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) throw new Error('missing refresh_token/id_token');
    const claims = decodeIdToken(tokens.id_token);
    if(pending.brokerId){deliverBroker(pending.brokerId,pending.userId,{...tokens,access_token:tokens.access_token,label:claims.email??'Google'});return redirect(brokerDone(pending.brokerId,'google'),303);}
    storeLink({
      userId: pending.userId,
      provider: 'google',
      label: claims.email ?? 'google',
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      scopes: (tokens as { scope?: string }).scope ?? '',
    });
    return redirect('/dash?connected=Google', 303);
  } catch (err) {
    if(pending.brokerId){rejectBroker(pending.brokerId,pending.userId);return redirect(brokerDone(pending.brokerId,'google','failed'),303);}
    console.error('[connect google] token exchange failed');
    return redirect('/account?err=google-connect', 303);
  }
};
