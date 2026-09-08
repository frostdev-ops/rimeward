import type { APIRoute } from 'astro';
import { browserWard } from '../../../../lib/dashboard.ts';
import { open, pushState, subscribe, type BrowserEvent } from '../../../../lib/browser/session.ts';
import { routeBrowser } from '../../../../lib/browser/routing.ts';

export const prerender = false;

/** Per viewer: at most one frame per FRAME_MS, latest wins. A viewer that
 *  can't keep up skips frames — it never queues them into node's heap. */
const FRAME_MS = 50;
// ponytail: the node adapter writes without waiting for socket drain, so a
// client slower than 20fps × frame size still buffers in the socket. A
// WebSocket with real backpressure is the upgrade if that ever shows.

/** The ward's live view: `frame` (jpeg base64 + the viewport it was captured
 *  at), `nav`, `tabs`, `dialog`. Connecting opens the browser if it is not
 *  already running. Same transport rules as /api/status/stream. */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const userId = locals.user!.userId;
  const ward = String(params.ward);
  const cfg = browserWard(userId, ward);
  if (!cfg) return Response.json({ error: 'not a browser ward' }, { status: 400 });
  const headers = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    // nginx must not buffer this (the vhost also sets proxy_buffering off).
    'x-accel-buffering': 'no',
  };
  let s;
  try {
    const routed = await routeBrowser(userId, ward, request);
    if (routed) return routed;
    s = await open(userId, ward, cfg);
  } catch (err) {
    // Not an error status (an EventSource cannot read one): a stream that
    // says why and ends, so the ward shows the reason ("Rimeward offline",
    // "downloading 42%") and the browser retries by itself every 5s.
    const ev: BrowserEvent = { type: 'route', online: false, detail: err instanceof Error ? err.message.split('\n')[0]! : 'browser failed to start' };
    return new Response(`retry: 5000\nevent: route\ndata: ${JSON.stringify(ev)}\n\n`, { headers });
  }

  const encoder = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending: BrowserEvent | null = null;
      let last = 0;
      const write = (ev: BrowserEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* viewer gone; cancel() follows */
        }
      };
      const flush = () => {
        timer = undefined;
        if (!pending) return;
        if ((controller.desiredSize ?? 0) <= 0) {
          timer = setTimeout(flush, FRAME_MS);
          return;
        }
        const ev = pending;
        pending = null;
        last = Date.now();
        write(ev);
      };
      const send = (ev: BrowserEvent) => {
        if (ev.type === 'closed') {
          unsub();
          if (ping) clearInterval(ping);
          if (timer) clearTimeout(timer);
          try {
            controller.close();
          } catch {}
          return;
        }
        if (ev.type !== 'frame') {
          write(ev);
          return;
        }
        pending = ev;
        const wait = FRAME_MS - (Date.now() - last);
        if (wait <= 0) flush();
        else if (!timer) timer = setTimeout(flush, wait);
      };
      unsub = subscribe(s, send);
      void pushState(s);
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {}
      }, 25_000);
    },
    cancel() {
      unsub();
      if (ping) clearInterval(ping);
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, { headers });
};
