import type { APIRoute } from 'astro';
import { resolveShare, revokeShare, setShareRole, shareOwnerName, shareTitle, shareWards, type ShareRole } from '../../../lib/shares.ts';

export const prerender = false;

// One share. GET = what it is (for the owner, its grantee, or a viewer inside it);
// PATCH = its role; DELETE = revoke. Only the owner changes it.

export const GET: APIRoute = ({ params, locals }) => {
  const share = resolveShare(params.id);
  const me = locals.user!.userId;
  if (!share || !(locals.share?.id === share.id || share.owner === me || share.grantee === me)) return Response.json({ error: 'no such share' }, { status: 404 });
  const wards = shareWards(share);
  if (!wards.length) return Response.json({ error: 'no such share' }, { status: 404 });
  const target = wards.find((w) => w.i === share.target);
  return Response.json({
    id: share.id, kind: share.kind, target: share.target, role: share.role, title: shareTitle(share, wards),
    type: share.kind === 'ward' ? target?.type ?? 'ward' : 'page', size: target?.size ?? null,
    owner: shareOwnerName(share.owner), expiresAt: share.expiresAt,
  }, { headers: { 'cache-control': 'no-store' } });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  if (locals.share) return Response.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  if (body?.role !== 'view' && body?.role !== 'edit') return Response.json({ error: 'bad role' }, { status: 400 });
  try {
    const share = setShareRole(locals.user!.userId, String(params.id), body.role as ShareRole);
    return Response.json({ id: share.id, role: share.role });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'could not change the share' }, { status: (err as { status?: number }).status ?? 500 });
  }
};

export const DELETE: APIRoute = ({ params, locals }) => {
  if (locals.share) return Response.json({ error: 'forbidden' }, { status: 403 });
  return revokeShare(locals.user!.userId, String(params.id)) ? Response.json({ ok: true }) : Response.json({ error: 'no such share' }, { status: 404 });
};
