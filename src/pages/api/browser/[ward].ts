import type { APIRoute } from 'astro';
import { browserScale } from '../../../lib/wards.ts';
import { browserWard } from '../../../lib/dashboard.ts';
import { open, runCmds, closeSession, peek, activate } from '../../../lib/browser/session.ts';
import { rtcInbound } from '../../../lib/browser/rtc.ts';
import { EXTENSION_BYTES, extensionRegistry, installExtension, changeExtension, restoreGlaze } from '../../../lib/browser/extensions.ts';
import { syncAppExtensions } from '../../../lib/browser/app-backend.ts';
import { browserPresence, routeBrowser } from '../../../lib/browser/routing.ts';
import { runBrowserAction } from '../../../lib/browser/actions.ts';
import { downloadResponse, listDownloads, removeDownload } from '../../../lib/browser/downloads.ts';

export const prerender = false;

function actionResponse(action: () => Promise<unknown>): Response {
  // Flush headers immediately: opening Chromium/navigation may outlast the relay's connection timeout.
  const encoder = new TextEncoder(); let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* disconnected */ } };
      send(' '); heartbeat = setInterval(() => send(' '), 10_000);
      void action()
        .then(value => send(JSON.stringify(value)), error => send(JSON.stringify({ error: error instanceof Error ? error.message : 'Browser action failed.' })))
        .finally(() => { clearInterval(heartbeat); try { controller.close(); } catch {} });
    },
    cancel() { clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

/** The human's input: one batch of commands (pointer, keys, text, navigation,
 *  tabs, resize) for the ward's active page. State comes back over the
 *  stream, not here — this only says whether the batch ran. */
export const POST: APIRoute = async ({ params, request, locals, url }) => {
  const userId = locals.user!.userId;
  const ward = String(params.ward);
  const cfg = browserWard(userId, ward);
  if (!cfg) return Response.json({ error: 'not a browser ward' }, { status: 400 });
  try {
    const routed = await routeBrowser(userId, ward, request);
    if (routed) return routed;
    if (url.searchParams.get('rtc') === '1') {
      // WebRTC signaling for the viewer's own connection (its id is the bearer): an answer or a
      // candidate, never input — the one POST a view-role share may make (shares.ts).
      const body = await request.json().catch(() => null) as { rtc?: { conn?: unknown } } | null;
      if (!rtcInbound(body?.rtc?.conn, body?.rtc, peek(userId, ward))) return Response.json({ error: 'bad rtc' }, { status: 400 });
      return Response.json({ ok: true });
    }
    const extensionAction = url.searchParams.get('extension');
    if (extensionAction) {
      return actionResponse(async () => {
        if (extensionAction === 'install') {
          const chunks: Uint8Array[] = []; let size = 0;
          const reader = request.body?.getReader();
          if (!reader) throw Error('Extension ZIP is required');
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if ((size += value.length) > EXTENSION_BYTES) throw Error('Extension ZIP must be at most 10 MB');
              chunks.push(value);
            }
          } finally { await reader.cancel(); }
          installExtension(userId, ward, Buffer.concat(chunks));
        } else if (extensionAction === 'glaze') {
          restoreGlaze(userId, ward);
        } else if (extensionAction === 'restart') {
          // The legacy desktop's direct CDP viewer may be running without a server session yet.
          const s = peek(userId, ward) ?? (cfg.backend === 'app' ? await open(userId, ward, cfg) : undefined);
          if (s?.operations) throw Error('Rime is using this browser. Wait for its browser action to finish before restarting.');
          if (s?.backend === 'app') {
            await syncAppExtensions(userId, ward);
            const cdp = await s.context.browser()!.newBrowserCDPSession();
            if (s.operations) { await cdp.detach(); throw Error('Rime is using this browser. Wait before restarting.'); }
            await cdp.send('Browser.close').catch(() => {});
          }
          if (s) await closeSession(s);
          // Relaunch at the restarting viewer's display scale (fixed per launch).
          const body = await request.json().catch(() => null) as { dsf?: unknown } | null;
          await open(userId, ward, cfg, { dsf: browserScale(body?.dsf) });
        } else {
          const body = await request.json();
          if (extensionAction === 'open') {
            const s = await open(userId, ward, cfg);
            const entry = extensionRegistry(userId, ward).extensions.find(e => e.id === body.id);
            if (!entry?.enabled || !entry.popup) throw Error('This extension has no settings page, or is disabled');
            const page = await s.context.newPage();
            try { await page.goto(`chrome-extension://${entry.id}/${entry.popup}`, { waitUntil: 'domcontentloaded', timeout: 15_000 }); }
            catch { await page.close(); throw Error('Extension settings are unavailable. Restart this browser to apply saved extension changes.'); }
            await activate(s, page);
          } else if (extensionAction === 'toggle' || extensionAction === 'remove') {
            changeExtension(userId, ward, body.id, body.enabled, extensionAction === 'remove', cfg.backend === 'browserbase');
          } else throw Error('Unknown extension action');
        }
        if (peek(userId, ward)?.backend === 'app' && ['install', 'toggle', 'remove'].includes(extensionAction)) await syncAppExtensions(userId, ward);
        return { ok: true };
      });
    }
    const body = await request.json().catch(() => null);
    // A share drives the page and nothing else: no downloads, snapshots or actions on the owner's behalf.
    if (locals.share && !Array.isArray(body?.cmds)) return Response.json({ error: 'not in a shared browser' }, { status: 403 });
    if (body && typeof body.action === 'string' && body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
      return actionResponse(() => runBrowserAction(userId, ward, body.action, body.args));
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
    if (url.searchParams.has('extensions')) {
      const extensions = extensionRegistry(user, ward).extensions.map(({ storage: _storage, ...entry }) => entry);
      return Response.json({ extensions, hosted: browserWard(user, ward)?.backend === 'browserbase', active: !!peek(user, ward) }, { headers: { 'cache-control': 'no-store' } });
    }
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
