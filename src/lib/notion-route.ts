// The one auth/error wrapper every Notion API route uses. Without it each
// route repeats the same not-linked / ReconnectError / 502 ladder, and they
// drift — which is how a ward ends up showing "Connect Notion" for a
// mistyped page id.

import { getLink, reconnectResponse } from './linked-accounts.ts';
import { notionIdFrom } from './wards.ts';

const noStore = { 'cache-control': 'no-store' };

export async function notionRoute(userId: number, tag: string, run: () => Promise<unknown>): Promise<Response> {
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  try {
    const body = await run();
    return Response.json(body ?? { ok: true }, { headers: noStore });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    const status = (err as { status?: number }).status;
    // Notion's own 4xx is the caller's fault (bad id, bad value) and its
    // message is the useful part; anything else is an upstream failure.
    const code = status === 403 ? 403 : status && status >= 400 && status < 500 ? 400 : 502;
    if (code === 502) console.error(`[${tag}]`, err);
    return Response.json({ error: (err as Error).message }, { status: code });
  }
}

/** A Notion id from untrusted input, or throw — never interpolate a raw
 *  path segment into the Notion URL. */
export function needId(v: unknown, what = 'id'): string {
  const id = notionIdFrom(v);
  if (!id) throw Object.assign(new Error(`a valid Notion ${what} is required`), { status: 400 });
  return id;
}

export function needStr(v: unknown, what: string, max = 2000): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw Object.assign(new Error(`${what} is required`), { status: 400 });
  return s.slice(0, max);
}

export async function jsonBody<T>(request: Request): Promise<T> {
  const body = (await request.json().catch(() => null)) as T | null;
  if (!body || typeof body !== 'object') throw Object.assign(new Error('a JSON body is required'), { status: 400 });
  return body;
}
