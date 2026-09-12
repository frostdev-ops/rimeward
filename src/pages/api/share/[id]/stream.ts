import type { APIRoute } from 'astro';
import { subscribeLogic } from '../../../../lib/logic-engine.ts';
import { joinPresence, shareEvent, type ShareScope } from '../../../../lib/shares.ts';
import { getTimers } from '../../../../lib/timers.ts';

export const prerender = false;

// The share view's live feed: the OWNER's per-user events, filtered to the shared
// wards (lib/shares.ts shareEvent), plus who is looking (`presence`). Only reachable
// inside the share (middleware sets locals.share); never the owner's whole stream.
export const GET: APIRoute = ({ params, locals }) => {
  const share = locals.share;
  if (!share || share.id !== params.id) return Response.json({ error: 'forbidden' }, { status: 403 });
  const owner = locals.user!.userId;
  const scope: ShareScope = { share: { id: share.id, owner, kind: share.kind, target: share.target, grantee: share.viewer, role: share.role, expiresAt: null, createdAt: '', tokenHash: null }, wards: share.wards, viewer: null };
  const encoder = new TextEncoder();
  let unsub = () => {};
  let leave = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      const shared = new Set(share.wards.map((w) => w.i));
      for (const t of getTimers(owner)) if (shared.has(t.ward)) send('timer', t);
      unsub = subscribeLogic(owner, (event, data) => {
        const out = shareEvent(scope, event, data);
        if (out) send(out.event, out.data);
      });
      leave = joinPresence(scope, share.viewerName ?? 'Guest', (data) => send('presence', data));
      ping = setInterval(() => { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch {} }, 25_000);
    },
    cancel() {
      unsub();
      leave();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
};
