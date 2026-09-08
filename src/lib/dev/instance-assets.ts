import type { APIRoute } from 'astro';
import { getSession, sessionId } from '../auth.ts';
import { isDesktop, DevError } from './runtime.ts';
import { localOwner } from './native.ts';
import { instanceRequest, rimeConnection } from './remote.ts';

// Astro serves bundled files before routes. A connected Account/Admin page can
// reference newer content-hashed assets; missing ones belong to that server.
export const GET: APIRoute = async ({ request, url, cookies, params, locals }) => {
  const asset = params.asset ?? '';
  if (!isDesktop() || !/^[\w./-]+$/.test(asset) || asset.split('/').some(p => !p || p === '.' || p === '..'))
    return new Response(null, { status: 404 });
  const user = locals.user ?? getSession(sessionId(cookies));
  if (!user || user.userId !== localOwner()) return new Response(null, { status: 401 });
  try {
    if (!await rimeConnection(user.userId)) return new Response(null, { status: 404 });
    return await instanceRequest(user.userId, url.pathname + url.search, request);
  } catch (error) {
    return new Response(error instanceof DevError ? error.message : 'Connected server unavailable.',
      { status: error instanceof DevError ? error.status : 503, headers: { 'cache-control': 'no-store' } });
  }
};
