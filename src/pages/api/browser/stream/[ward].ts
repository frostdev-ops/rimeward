import type { APIRoute } from 'astro';
import { browserWard } from '../../../../lib/dashboard.ts';
import { open, pushState, subscribe, type BrowserEvent } from '../../../../lib/browser/session.ts';
import { routeBrowser } from '../../../../lib/browser/routing.ts';
import { shareLive } from '../../../../lib/shares.ts';
import { REMOTE_FRAME_MS, remoteFrame, type FrameEvent } from '../../../../lib/browser/remote-frame.ts';
import { rtcIce, rtcIceFromRelay, rtcJoin, withRtcHeader, type RtcMessage } from '../../../../lib/browser/rtc.ts';

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
export const GET: APIRoute = async ({ params, locals, request, url }) => {
  const userId = locals.user!.userId;
  const share = locals.share;
  const ward = String(params.ward);
  const cfg = browserWard(userId, ward);
  if (!cfg) return Response.json({ error: 'not a browser ward' }, { status: 400 });
  const headers = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    // nginx must not buffer this (the vhost also sets proxy_buffering off).
    'x-accel-buffering': 'no',
  };
  // Beyond the relay (a desktop answering the server's channel): CSS-size frames, fewer of them (remote-frame.ts).
  const remote = request.headers.get('x-rimeward-relayed') === '1';
  // Who watches, for the stream's ICE: the grantee, the owner, or nobody (a link). The server
  // mints it; a request bound for a desktop carries it there (the desktop has no TURN secret).
  const viewer = share ? share.viewer : userId;
  const ice = remote ? rtcIceFromRelay(request) : rtcIce(userId, { userId: viewer });
  let s;
  try {
    const routed = await routeBrowser(userId, ward, remote ? request : withRtcHeader(request, ice));
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
  let unsub: ReturnType<typeof subscribe> | undefined;
  let rtc: ReturnType<typeof rtcJoin>;
  let ping: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frameMs = remote ? REMOTE_FRAME_MS : FRAME_MS;
  // The share is re-read a few times a minute, not on every frame.
  let checked = Date.now();
  const alive = () => { if (!share) return true; if (Date.now() - checked < 5_000) return true; checked = Date.now(); return shareLive(share, url); };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending: BrowserEvent | null = null;
      let last = 0;
      let busy = false; // one remote re-encode at a time; the latest frame waits, older ones are dropped
      const write = (ev: BrowserEvent | RtcMessage) => {
        try {
          controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* viewer gone; cancel() follows */
        }
      };
      const flush = () => {
        timer = undefined;
        if (!pending || busy) return;
        if ((controller.desiredSize ?? 0) <= 0) {
          timer = setTimeout(flush, frameMs);
          return;
        }
        const ev = pending;
        pending = null;
        last = Date.now();
        if (!remote) { write(ev); return; }
        busy = true;
        void remoteFrame(ev as FrameEvent).then(write, () => write(ev)).finally(() => {
          busy = false;
          if (pending && !timer) timer = setTimeout(flush, Math.max(0, frameMs - (Date.now() - last)));
        });
      };
      const end = () => {
        rtc?.leave(); rtc = null;
        unsub?.(); unsub = undefined;
        if (ping) clearInterval(ping);
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {}
      };
      const send = (ev: BrowserEvent) => {
        // A viewer's share revoked, expired or downgraded: the frames stop at the next one, not when they leave.
        if (ev.type === 'closed' || !alive()) { end(); return; }
        if (ev.type !== 'frame') {
          write(ev);
          return;
        }
        pending = ev;
        const wait = frameMs - (Date.now() - last);
        if (wait <= 0) flush();
        else if (!timer) timer = setTimeout(flush, wait);
      };
      const sub = unsub = subscribe(s, send);
      void pushState(s);
      // The stream, once the capture page is up: `ice` now, the page's offer next; frames stop once the peer connects.
      void (s.streamOpening ?? Promise.resolve()).then(() => { if (unsub === sub) rtc = rtcJoin(s, ice, write, on => sub.jpeg(!on)); });
      ping = setInterval(() => {
        if (share && !shareLive(share, url)) { end(); return; }
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {}
      }, 25_000);
    },
    cancel() {
      rtc?.leave(); rtc = null;
      unsub?.(); unsub = undefined;
      if (ping) clearInterval(ping);
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, { headers });
};
