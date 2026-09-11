import type { APIRoute } from 'astro';
import { rollbackServer, setUpdatePolicy, startInstall, updateState } from '../../../lib/updates.ts';

export const prerender = false;

/** Admin writes: the policy, an install (a background job — the page reloads
 *  when the server restarts), a rollback, or a check-now. JSON from the header
 *  chip; a form post from the admin page (redirects back to it). */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = request.headers.get('content-type')?.includes('form');
  const body = form ? Object.fromEntries((await request.formData()).entries()) : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  let refresh = 'refresh' in body;
  try {
    if (typeof body.policy === 'string') setUpdatePolicy(body.policy);
    if (body.install) startInstall({ version: typeof body.version === 'string' && body.version ? body.version : undefined, restart: body.restart !== false });
    if (body.rollback) rollbackServer();
    if (body.install || body.rollback) refresh = false;
  } catch (err) {
    const message = (err as Error).message;
    return form ? redirect(`/admin/users?err=${encodeURIComponent(message)}`, 303) : Response.json({ error: message }, { status: 400 });
  }
  if (form) {
    if (refresh) await updateState({ refresh: true });
    return redirect('/admin/users?ok=update', 303);
  }
  return Response.json(await updateState({ refresh }), { headers: { 'cache-control': 'no-store' } });
};
