import type { APIRoute } from 'astro';
import { terminalPlacementAction } from '../../lib/dev/terminal-placement.ts';
import { DevError } from '../../lib/dev/runtime.ts';

export const prerender = false;
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    if (!locals.user) throw new DevError('Sign in required.', 401);
    const raw = await request.text(); if (raw.length > 128 * 1024) throw new DevError('Terminal metadata exceeds limit.', 413);
    const body: unknown = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DevError('Invalid terminal metadata.');
    return Response.json(await terminalPlacementAction(locals.user.userId, body as Record<string, unknown>), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof DevError ? error.status : 400 }); }
};
