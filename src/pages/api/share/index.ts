import type { APIRoute } from 'astro';
import { createShare, linksEnabled, listShares, sharedWithMe, type CreateShare } from '../../../lib/shares.ts';

export const prerender = false;

// A user's shares. GET = what they shared (`?incoming=1`: what was shared WITH
// them); POST = share a ward or page with a person (by email) or with anyone
// holding the link (no email; the token comes back exactly once).

const view = (s: { id: string; kind: string; target: string; role: string; expiresAt: string | null; grantee: number | null }) =>
  ({ id: s.id, kind: s.kind, target: s.target, role: s.role, expiresAt: s.expiresAt, link: s.grantee === null });

export const GET: APIRoute = ({ url, locals }) => {
  if (locals.share) return Response.json({ error: 'forbidden' }, { status: 403 });
  const user = locals.user!.userId;
  const body = url.searchParams.has('incoming') ? { shares: sharedWithMe(user) } : { shares: listShares(user), links: linksEnabled() };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (locals.share) return Response.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Partial<CreateShare> | null;
  if (!body || typeof body.target !== 'string') return Response.json({ error: 'bad body' }, { status: 400 });
  try {
    const { share, token } = createShare(locals.user!.userId, {
      kind: body.kind === 'page' ? 'page' : 'ward',
      target: body.target,
      email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : undefined,
      role: body.role === 'edit' ? 'edit' : 'view',
      expiresIn: Number(body.expiresIn) || 0,
    });
    // The link is the SERVER's address: a desktop forwards this call here, and its own origin is a loopback port.
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `${request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.slice(0, -1)}://${request.headers.get('host') ?? new URL(request.url).host}`;
    return Response.json({ share: view(share), ...(token ? { token, url: `${base}/s/${token}` } : {}) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) console.error('[share]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'could not share' }, { status });
  }
};
