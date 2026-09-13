import type { APIRoute } from 'astro';
import { mintState } from '../../../lib/oauth.ts';
import { googleConnectUrl, microsoftConnectUrl, notionConnectUrl, zohoConnectUrl } from '../../../lib/connect.ts';
import { secret, type SecretKey } from '../../../lib/secrets.ts';

export const prerender = false;

const CREDS: Record<string, [SecretKey, SecretKey]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET'],
  notion: ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'],
  zoho: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'],
};

export const GET: APIRoute = async ({ params, url, locals, redirect }) => {
  const provider = params.provider ?? '';
  const creds = CREDS[provider];
  if(creds && !url.searchParams.has('legacy'))return redirect(`/account?connect=${provider}${url.searchParams.has('readonly')?'&readonly=1':''}${url.searchParams.has('teams')?'&teams=1':''}#accounts`,303);
  if (!creds) return redirect('/account?err=unknown-provider', 303);
  if (!secret(creds[0]) || !secret(creds[1])) return redirect(`/account?err=${provider}-unconfigured`, 303);

  const userId = locals.user!.userId;
  if (provider === 'google') return redirect(googleConnectUrl(mintState('google', userId)), 303);
  if (provider === 'notion') return redirect(notionConnectUrl(mintState('notion', userId)), 303);
  if (provider === 'zoho') return redirect(zohoConnectUrl(mintState('zoho', userId)), 303);
  const readonly = url.searchParams.has('readonly');
  // ?teams widens the consent to the Teams scopes (the chat ward's link).
  return redirect(microsoftConnectUrl(mintState('microsoft', userId, { readonly }), readonly, url.searchParams.has('teams')), 303);
};
