import type { APIRoute } from 'astro';
import { BOOT_ID, buildInfo, getSnapshot, subscribe, type Snapshot } from '../../../lib/status.ts';
import { shareSnapshot } from '../../../lib/shares.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const encoder = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const share = locals.share;

  const stream = new ReadableStream({
    start(controller) {
      const send = (snap: Snapshot) =>
        controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(share ? { ...shareSnapshot(snap, share.wards), bootId: BOOT_ID } : { ...snap, bootId: BOOT_ID, build: buildInfo() })}\n\n`));
      const snap = getSnapshot();
      if (snap) send(snap);
      unsub = subscribe(send);
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {}
      }, 25_000);
    },
    cancel() {
      unsub();
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      // nginx must not buffer this (the vhost also sets proxy_buffering off).
      'x-accel-buffering': 'no',
    },
  });
};
