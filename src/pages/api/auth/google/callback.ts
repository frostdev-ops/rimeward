import { GET as identityCallback } from '../identity/[...action].ts';
import type { APIRoute } from 'astro';
import {
  SESSION_COOKIES,
  SSO_STATE_COOKIE,
  createSession,
  sessionCookieOptions,
  afterLogin,
} from '../../../../lib/auth.ts';
import { getUserByEmail, createUser, setDisplayName, userCount } from '../../../../lib/users.ts';
import { takeState } from '../../../../lib/oauth.ts';
import { decideSsoLogin, decodeIdToken, exchangeGoogleCode, ssoRedirectUri } from '../../../../lib/google-sso.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const {url,cookies,redirect}=context;
  if(cookies.get(`identity_${url.searchParams.get('state')??''}`))return identityCallback({...context,params:{action:'google/callback'}});
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  const nonce = cookies.get(SSO_STATE_COOKIE)?.value;
  cookies.delete(SSO_STATE_COOKIE, { path: '/' });
  const pending = takeState(state);
  if (!pending || pending.provider !== 'google-sso' || !code || nonce !== state)
    return redirect('/login?err=sso', 303);

  let claims;
  try {
    const tokens = await exchangeGoogleCode(code, ssoRedirectUri());
    if (!tokens.id_token) throw new Error('no id_token');
    claims = decodeIdToken(tokens.id_token);
  } catch (err) {
    console.error('[sso] exchange failed:', err);
    return redirect('/login?err=sso', 303);
  }

  const existing = claims.email ? getUserByEmail(claims.email) : null;
  const decision = decideSsoLogin(claims, !!existing, userCount());
  if (decision.action === 'reject') return redirect('/login?err=invite', 303);

  let userId: number;
  if (decision.action === 'create') {
    userId = createUser(claims.email!, null, decision.role);
    if (claims.name) setDisplayName(userId, claims.name);
  } else {
    userId = existing!.id;
  }

  const session = createSession(userId);
  for (const name of SESSION_COOKIES) cookies.set(name, session.id, sessionCookieOptions(session.expiresAt));
  return redirect(afterLogin(cookies), 303);
};
