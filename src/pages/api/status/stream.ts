import type { APIRoute } from 'astro';
import { BOOT_ID, buildInfo, getSnapshot, subscribe, type Snapshot } from '../../../lib/status.ts';
import { shareLive, shareSnapshot } from '../../../lib/shares.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  const encoder = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const share = locals.share;

  const stream = new ReadableStream({
    start(controller) {
      // Inside a share: a revoke, an expiry or a role change ends the stream at the next tick or beat.
      const end = () => { unsub(); if (ping) clearInterval(ping); try { controller.close(); } catch {} };
      const send = (snap: Snapshot) => {
        if (share && !shareLive(share, url)) { end(); return; }
        controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(share ? { ...shareSnapshot(snap, share.wards), bootId: BOOT_ID } : { ...snap, bootId: BOOT_ID, build: buildInfo() })}\n\n`));
      };
      const snap = getSnapshot();
      if (snap) send(snap);
      unsub = subscribe(send);
      ping = setInterval(() => {
        if (share && !shareLive(share, url)) { end(); return; }
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
