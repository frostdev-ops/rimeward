import type { APIRoute } from 'astro';
import { browserWard } from '../../../lib/dashboard.ts';
import { open, runCmds } from '../../../lib/browser/session.ts';
import { browserPresence, routeBrowser } from '../../../lib/browser/routing.ts';
import { runBrowserAction } from '../../../lib/browser/actions.ts';
import { downloadResponse, listDownloads, removeDownload } from '../../../lib/browser/downloads.ts';

export const prerender = false;

/** The human's input: one batch of commands (pointer, keys, text, navigation,
 *  tabs, resize) for the ward's active page. State comes back over the
 *  stream, not here — this only says whether the batch ran. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const ward = String(params.ward);
  const cfg = browserWard(userId, ward);
  if (!cfg) return Response.json({ error: 'not a browser ward' }, { status: 400 });
  try {
    const routed = await routeBrowser(userId, ward, request);
    if (routed) return routed;
    const body = await request.json().catch(() => null);
    if (body && typeof body.action === 'string' && body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
      // Flush headers immediately: opening Chromium/navigation may outlast the relay's connection timeout.
      const encoder = new TextEncoder(); let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* disconnected */ } };
          send(' '); heartbeat = setInterval(() => send(' '), 10_000);
          void runBrowserAction(userId, ward, body.action, body.args)
            .then(value => send(JSON.stringify(value)), error => send(JSON.stringify({ error: error instanceof Error ? error.message : 'Browser action failed.' })))
            .finally(() => { clearInterval(heartbeat); try { controller.close(); } catch {} });
        },
        cancel() { clearInterval(heartbeat); },
      });
      return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
    }
    if (!body || !Array.isArray(body.cmds)) return Response.json({ error: 'bad body' }, { status: 400 });
    const s = await open(userId, ward, cfg);
    await runCmds(s, body.cmds);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message.split('\n')[0] : 'failed' }, { status: 400 });
  }
};

export const GET: APIRoute = async ({ params, request, locals, url }) => {
  const user = locals.user!.userId, ward = String(params.ward);
  if (!browserWard(user, ward)) return Response.json({ error: 'not a browser ward' }, { status: 404 });
  try {
    const routed = await routeBrowser(user, ward, request);
    if (routed) return routed;
    if (url.searchParams.has('presence')) return Response.json(browserPresence(user, ward));
    const id = url.searchParams.get('download');
    return id ? downloadResponse(user, ward, id) : Response.json({ downloads: listDownloads(user, ward) }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Browser unavailable.' }, { status: 503 }); }
};

export const DELETE: APIRoute = async ({ params, request, locals, url }) => {
  const user = locals.user!.userId, ward = String(params.ward);
  if (!browserWard(user, ward)) return Response.json({ error: 'not a browser ward' }, { status: 404 });
  try {
    const routed = await routeBrowser(user, ward, request);
    if (routed) return routed;
    removeDownload(user, ward, url.searchParams.get('download') ?? '');
    return Response.json({ ok: true });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Download unavailable.' }, { status: 400 }); }
};
