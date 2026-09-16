import { config } from './app-config.ts';
// Authorize-URL builders + code exchanges for the three data providers.
// (SSO lives in google-sso.ts; this is the per-user "linked accounts" side.)
import { secret } from './secrets.ts';
import { baseUrl } from './oauth.ts';

export const GOOGLE_DATA_SCOPES = [
  'openid',
  'email',
  // modify supersedes readonly and is what read/star/archive/trash need.
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export const MS_SCOPES_FULL = 'openid profile email offline_access Mail.ReadWrite Mail.Send Calendars.Read';
export const MS_SCOPES_READONLY = 'openid profile email offline_access Mail.Read Calendars.Read';
/** The Microsoft identity endpoint's tenant segment: `common` (any account)
 *  unless the app registration is single-tenant, which only issues tokens
 *  through its own tenant id. */
export const msTenant = (): string => config('MS_TENANT_ID');

// The Teams ward (lib/comms/teams.ts) speaks as the user: chats need the
// delegated pair, team channels ChannelMessage.Read.All (admin consent in
// most tenants). Asked for only from /api/connect/microsoft?teams.
export const MS_SCOPES_TEAMS = `${MS_SCOPES_FULL} Chat.ReadWrite ChatMessage.Send ChannelMessage.Send ChannelMessage.Read.All Team.ReadBasic.All Channel.ReadBasic.All`;

// Zoho Mail: the api-console app must list this redirect URI, or the consent
// screen 400s.
export const ZOHO_SCOPES = 'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.ALL';

export function connectRedirectUri(provider: 'google' | 'microsoft' | 'notion' | 'zoho'): string {
  return `${baseUrl()}/api/connect/${provider}/callback`;
}

export function googleConnectUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: secret('GOOGLE_CLIENT_ID'),
    redirect_uri: connectRedirectUri('google'),
    response_type: 'code',
    scope: GOOGLE_DATA_SCOPES,
    // Always re-issue the refresh token — without prompt=consent Google only
    // sends one on the very first grant.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export function microsoftConnectUrl(state: string, readonly: boolean, teams = false): string {
  const p = new URLSearchParams({
    client_id: secret('MS_CLIENT_ID'),
    redirect_uri: connectRedirectUri('microsoft'),
    response_type: 'code',
    response_mode: 'query',
    scope: readonly ? MS_SCOPES_READONLY : teams ? MS_SCOPES_TEAMS : MS_SCOPES_FULL,
    state,
  });
  return `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/authorize?${p}`;
}

export function notionConnectUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: secret('NOTION_CLIENT_ID'),
    redirect_uri: connectRedirectUri('notion'),
    response_type: 'code',
    owner: 'user',
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${p}`;
}

export function zohoConnectUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: secret('ZOHO_CLIENT_ID'),
    redirect_uri: connectRedirectUri('zoho'),
    response_type: 'code',
    scope: ZOHO_SCOPES,
    access_type: 'offline',
    // Without prompt=consent a reconnect comes back with no refresh token.
    prompt: 'consent',
    state,
  });
  return `https://accounts.zoho.com/oauth/v2/auth?${p}`;
}

/** Zoho's token host follows the data centre: the callback names it in
 *  `accounts-server`, and every later refresh has to use the same one. */
export async function exchangeZohoCode(code: string, accountsBase: string): Promise<TokenResponse> {
  accountsBase = zohoAccountsBase(accountsBase);
  const res = await fetch(`${accountsBase}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: secret('ZOHO_CLIENT_ID'),
      client_secret: secret('ZOHO_CLIENT_SECRET'),
      redirect_uri: connectRedirectUri('zoho'),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  // Zoho answers a bad code with HTTP 200 and {error}, so the body decides.
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(`zoho token exchange failed: ${data.error ?? res.status}`);
  }
  return data;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export async function exchangeMicrosoftCode(code: string): Promise<TokenResponse> {
  const res = await fetch(`https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: secret('MS_CLIENT_ID'),
      client_secret: secret('MS_CLIENT_SECRET'),
      redirect_uri: connectRedirectUri('microsoft'),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ms token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export interface NotionTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}

export async function exchangeNotionCode(code: string): Promise<NotionTokenResponse> {
  const basic = Buffer.from(`${secret('NOTION_CLIENT_ID')}:${secret('NOTION_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: connectRedirectUri('notion') }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`notion token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function zohoAccountsBase(value: string): string {
  const allowed = ['https://accounts.zoho.com','https://accounts.zoho.eu','https://accounts.zoho.in','https://accounts.zoho.com.au','https://accounts.zoho.jp','https://accounts.zohocloud.ca'];
  const base = value.replace(/\/$/,'');
  if (!allowed.includes(base)) throw new Error('Unknown Zoho authorization region');
  return base;
}
