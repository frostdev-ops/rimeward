import { secret } from './secrets.ts';

/** The Google/Microsoft connect callbacks' token exchange. Login identities go
 *  through lib/identity.ts — this file is only the mail/calendar grant path. */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<{ id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: secret('GOOGLE_CLIENT_ID'),
      client_secret: secret('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export interface IdClaims {
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

/** Decode without signature verification — acceptable only because the token
 *  arrived directly from Google's token endpoint over TLS in our own
 *  server-to-server exchange, never from the browser. */
export function decodeIdToken(idToken: string): IdClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
