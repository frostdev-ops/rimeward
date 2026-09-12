import { ensureLiveStream } from './lib/live-stream.ts';
import { ensureBrowserLive } from './lib/browser/live.ts';
import { ensureDevLive } from './lib/dev/live.ts';
import { ensureNoteLive } from './lib/note-live.ts';
import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIES, getSession, sessionId } from './lib/auth.ts';
import { csrfBlocked } from './lib/csrf.ts';
import { getDb } from './lib/db.ts';
import { ensureStatusEngine } from './lib/status.ts';
import { ensureLogicEngine } from './lib/logic-engine.ts';
import { ensureBrowser } from './lib/browser/session.ts';
import { ensureTunnel } from './lib/tunnel.ts';
import { ensureRemote } from './lib/dev/remote.ts';
import { ensureDevices } from './lib/dev/devices.ts';
import { nativeRequest } from './lib/dev/native.ts';
import { routeInstance } from './lib/dev/instance-routing.ts';
import { validUserCode, CONNECT_COOKIE } from './lib/dev/device-auth.ts';
import { SHARE_TOKEN_RE, shareAllows, shareCookie, shareLocals, sharePrincipal, shareScope } from './lib/shares.ts';
import { isDesktop } from './lib/dev/runtime.ts';
import { ensureUpdateChecks } from './lib/updates.ts';
import { ensureAgentMonitors } from './lib/agent/monitors.ts';
import { ensureKnowledge } from './lib/agent/knowledge.ts';

// The status + logic engines live in-process; middleware load is the one place
// that runs exactly once per server boot (guarded against dev-HMR double-starts).
getDb(); // migrations, and the monitor registry the first status tick needs
ensureStatusEngine();
ensureLogicEngine();
ensureBrowser(); // orphan sweep + graceful close for the browser wards
(await import('./lib/comms/index.ts')).ensureComms(); // every chat ward with a token reconnects; sockets close on the way down
ensureDevices();
ensureLiveStream();
ensureBrowserLive(); // the browser wards' frame + input WebSocket
ensureDevLive(); // the terminal wards' output + input WebSocket (desktop runtime only)
ensureNoteLive(); // the notepads' collaboration WebSocket (lib/note-room.ts)
ensureRemote();
ensureTunnel(); // publishes the desktop app's upgrade handler for server.mjs / the dev hook
ensureUpdateChecks(); // the release lookup every 6 h; installs under the `install` policy
ensureAgentMonitors();
ensureKnowledge();

// Public: the splash (exact match — everything else under / is gated), login,
// the SSO endpoints, the OAuth connect callbacks (public so the provider can
// land on them; each one re-checks the session itself), and static assets.
const PUBLIC_PREFIXES = [
  '/login',
  '/api/login',
  '/api/devices/preview',
  '/api/devices/claim',
  '/api/devices/authorize',
  '/api/devices/token',
  '/api/devices/session',
  '/api/devices/navigation',
  '/api/devices/harness',
  '/api/logout', // must work with a DEAD session too, or the cookie can never be cleared
  '/api/auth/google', // covers /callback too
  '/api/connect/google/callback',
  '/api/connect/microsoft/callback',
  '/api/connect/notion/callback',
  '/api/connect/zoho/callback',
  '/_astro/',
  '/_image', // Astro's image optimizer
  '/runtime-bridge.js', // the share view's URL bridge (relayed documents get it inlined)
  '/brand/', // the favicon and the splash's art (lib/brand-files.ts)
  '/favicon', // browsers ask for /favicon.ico unprompted: a 404, not a bounce to /login
  '/apple-touch-icon',
];

const ADMIN_PREFIXES = ['/admin', '/api/users', '/api/admin'];

export const onRequest = defineMiddleware(async (context, next) => {
  const native=nativeRequest(context);
  if(native)return native;
  if(context.locals.user)return (await routeInstance(context)) ?? next();
  const { pathname } = context.url;
  if (csrfBlocked(context.request)) {
    return new Response(JSON.stringify({ error: 'forbidden origin' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (pathname === '/') return next();
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

  const cookie = sessionId(context.cookies);
  const session = getSession(cookie);
  // A share: /s/<id> or any request carrying ?share=<id> runs AS THE OWNER, restricted to
  // shareAllows (lib/shares.ts). Grantees are signed in; link holders carry the token cookie
  // the landing set; a raw token in /s/<token> goes to the page, which swaps it for that cookie.
  const shareId = pathname.startsWith('/s/') ? pathname.split('/')[2] ?? '' : context.url.searchParams.get('share') ?? '';
  const json = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
  if (isDesktop() && (shareId || pathname.startsWith('/s/'))) {
    // Shares live on the server: a joined desktop forwards the share view and every call
    // inside it (routeInstance); one that is not joined has nothing to show.
    if (!session) return pathname.startsWith('/s/') ? context.redirect('/login', 303) : json('unauthorized', 401);
    context.locals.user = session;
    return (await routeInstance(context)) ?? json('no such share', 404);
  }
  if (pathname.startsWith('/s/') && SHARE_TOKEN_RE.test(shareId)) return next();
  if (shareId) {
    const scope = shareScope(shareId, session, context.cookies.get(shareCookie(shareId))?.value);
    if (typeof scope === 'number') {
      // A grantee's link opened signed out: sign in, then find it under Add ward › Shared with me.
      if (scope === 403 && !session && pathname.startsWith('/s/')) return context.redirect('/login', 303);
      return json(scope === 404 ? 'no such share' : 'forbidden', scope);
    }
    if (!pathname.startsWith('/s/') && !shareAllows(scope, context.request.method, context.url)) return json('forbidden', 403);
    context.locals.user = sharePrincipal(scope, context.url.searchParams.get('theme') === 'mine' ? 'mine' : 'owner');
    context.locals.share = shareLocals(scope);
    return (await routeInstance(context)) ?? next();
  }
  if (!session) {
    // A cookie that no longer names a session is dead weight: an HttpOnly
    // cookie the browser keeps sending, that no script can replace, and that
    // this branch would otherwise bounce on forever.
    if (cookie) for (const name of SESSION_COOKIES) context.cookies.delete(name, { path: '/' });
    // A relayed API call (/runtime/<device>/api/…) is an API call: a desktop with a dead
    // session must see 401 JSON, not a /login redirect it would follow into its own login page.
    if (pathname.startsWith('/api/') || /^\/runtime\/[^/]+\/api\//.test(pathname)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if(pathname==='/desktop/connect') {
      const code=context.url.searchParams.get('code');
      if(validUserCode(code)) context.cookies.set(CONNECT_COOKIE,code,{path:'/',httpOnly:true,sameSite:'lax',secure:(process.env.PUBLIC_BASE_URL??'').startsWith('https:'),maxAge:600});
    }
    return context.redirect('/login', 303);
  }

  if (session.role !== 'admin' && ADMIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return context.redirect('/dash', 303);
  }

  context.locals.user = session;
  return (await routeInstance(context)) ?? next();
});
