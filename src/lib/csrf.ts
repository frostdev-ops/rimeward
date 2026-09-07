// CSRF for form posts. Astro's own check (security.checkOrigin) compares the
// Origin header with the request URL, which behind a reverse proxy is the
// proxy's address — so it is off in astro.config.mjs and this runs instead,
// against PUBLIC_BASE_URL. Same rule Astro applies: state-changing methods
// with a form content type. A request without an Origin header (curl, a
// script) is not a browser and passes; a cross-site JSON post never gets past
// the browser's CORS preflight, which is why only form types are checked.
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/** The site's own origin and loopback (dev servers on any port), nothing else. */
export function allowedOrigin(origin: string, base = process.env.PUBLIC_BASE_URL): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
  try {
    return !!base && new URL(base).origin === o.origin;
  } catch {
    return false;
  }
}

export function csrfBlocked(request: Request): boolean {
  if (!METHODS.has(request.method)) return false;
  const url = new URL(request.url);
  if(url.pathname.startsWith('/runtime/')||url.pathname.startsWith('/api/devices/')||url.pathname.startsWith('/api/remote-desktop/')||url.pathname==='/desktop/connect'){
    const origin=request.headers.get('origin');if(!origin)return false;
    try{return process.env.PUBLIC_BASE_URL?new URL(origin).origin!==new URL(process.env.PUBLIC_BASE_URL).origin:new URL(origin).host!==(request.headers.get('host')??url.host);}catch{return true;}
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!FORM_TYPES.some((t) => type.startsWith(t))) return false;
  const origin = request.headers.get('origin');
  return !!origin && !allowedOrigin(origin);
}
