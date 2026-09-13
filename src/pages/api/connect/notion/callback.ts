import { deliverBroker,rejectBroker } from '../../../../lib/oauth-broker.ts';
import type { APIRoute } from 'astro';
import { takeConnectState } from '../../../../lib/oauth.ts';
import { exchangeNotionCode } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  if(pending?.brokerId && pending.userId && url.searchParams.has('error')){rejectBroker(pending.brokerId,pending.userId);return redirect('/oauth/broker?done=1&error=denied',303);}
  const code = url.searchParams.get('code');
  if (!pending || pending.provider !== 'notion' || !pending.userId || !code)
    return redirect('/account?err=notion-connect', 303);

  try {
    const tokens = await exchangeNotionCode(code);
    // Notion tokens don't expire and don't refresh: the sealed "refresh" slot
    // holds the access token itself (access_expires_at stays 0).
    if(pending.brokerId){deliverBroker(pending.brokerId,pending.userId,{...tokens,label:tokens.workspace_name??'Notion',meta:{workspace_id:tokens.workspace_id,bot_id:tokens.bot_id,rotating:!!tokens.refresh_token}});return redirect('/oauth/broker?done=1',303);}
    storeLink({
      userId: pending.userId,
      provider: 'notion',
      label: tokens.workspace_name ?? 'notion',
      refreshToken: tokens.refresh_token ?? tokens.access_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.refresh_token ? tokens.expires_in ?? 3600 : undefined,
      meta: { rotating: !!tokens.refresh_token, workspace_id: tokens.workspace_id, bot_id: tokens.bot_id },
    });
    return redirect('/dash?connected=Notion', 303);
  } catch (err) {
    if(pending.brokerId){rejectBroker(pending.brokerId,pending.userId);return redirect('/oauth/broker?done=1&error=failed',303);}
    console.error('[connect notion] token exchange failed');
    return redirect('/account?err=notion-connect', 303);
  }
};
