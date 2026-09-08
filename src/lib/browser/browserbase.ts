import { chromium, type BrowserContext } from 'playwright-core';
import { openToken, sealToken } from '../crypto.ts';
import { deleteSetting, getSetting, setSetting } from '../settings.ts';
import { createHash } from 'node:crypto';
import { extensionRegistry, extensionZip, cleanExtensions } from './extensions.ts';

// The hosted backend: a Browserbase session per ward, connected over CDP, so
// everything above session.ts (screencast, input, tools) is untouched. Logins
// persist through a Browserbase *context* — one per ward, created on first
// use and remembered in settings. The key is per-user and sealed at rest like
// the other agent credentials (settings, not agent_accounts: that table's
// provider CHECK would need a migration for one more row).

const API = 'https://api.browserbase.com/v1';
const keyOf = (userId: number) => `agent_browserbase:${userId}`;
const ctxOf = (userId: number, ward: string) => `browserbase_ctx:${userId}:${ward}`;

export function browserbaseKey(userId: number): string | null {
  const sealed = getSetting(keyOf(userId));
  if (!sealed) return null;
  try {
    return openToken(sealed);
  } catch {
    return null;
  }
}

/** '' clears. */
export function storeBrowserbaseKey(userId: number, key: string): void {
  if (key) setSetting(keyOf(userId), sealToken(key));
  else deleteSetting(keyOf(userId));
}

async function api<T>(key: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'x-bb-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Browserbase ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function connectBrowserbase(userId: number, ward: string): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const key = browserbaseKey(userId);
  if (!key) throw new Error('no Browserbase key — add one under Account → Agent');
  cleanExtensions(userId, ward);
  let ctxId = getSetting(ctxOf(userId, ward));
  if (!ctxId) {
    ctxId = (await api<{ id: string }>(key, '/contexts', {})).id;
    setSetting(ctxOf(userId, ward), ctxId);
  }
  const session = await api<{ connectUrl: string }>(key, '/sessions', {
    extensionId: await browserbaseExtension(userId, ward, key),
    browserSettings: { context: { id: ctxId, persist: true } },
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // Disconnecting ends the session on their side (no keepAlive requested).
  return { context, close: () => browser.close() };
}

async function browserbaseExtension(user: number, ward: string, key: string): Promise<string | undefined> {
  const enabled = extensionRegistry(user, ward).extensions.filter(e => e.enabled);
  if (enabled.length > 1) throw Error('Browserbase supports one enabled extension. Disable the others in Extensions.');
  if (!enabled[0]) return;
  const zip = extensionZip(user, ward, enabled[0].id);
  const cacheKey = `browserbase_extension:${user}:${createHash('sha256').update(key).update(zip).digest('hex')}`;
  const cached = getSetting(cacheKey);
  if (cached) return cached;
  const body = new FormData();
  body.set('file', new Blob([zip], { type: 'application/zip' }), 'extension.zip');
  const response = await fetch(API + '/extensions', { method: 'POST', headers: { 'x-bb-api-key': key }, body, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Error(`Browserbase extension upload failed (${response.status})`);
  const result = await response.json();
  if (typeof result.id !== 'string') throw Error('Browserbase did not return an extension ID');
  setSetting(cacheKey, result.id);
  return result.id;
}

/** Forget the ward's context pointer. */
// ponytail: the remote context itself is left behind (DELETE /v1/contexts/{id}
// if that ever matters — it holds cookies, so it arguably should).
export function dropBrowserbase(userId: number, ward: string): void {
  deleteSetting(ctxOf(userId, ward));
}
