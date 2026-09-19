import type { APIRoute } from 'astro';
import { captionsFor } from '../../../lib/lens/captions.ts';
import { lens } from '../../../lib/lens/core.ts';
import { lensOverlay } from '../../../lib/lens/screen.ts';
import { lensNativeStatus, lensPaused, lensWard, setLensPaused } from '../../../lib/lens/runtime.ts';
import { lensSetting } from '../../../lib/lens/settings.ts';
import { OVERLAY_OFF } from '../../../lib/lens/tools.ts';

export const prerender = false;

// The Screen lens ward: GET is what the card draws (is the lens reading, what
// it is reading, the deliveries it last handed over), POST is the card's three
// controls. The lens only ever exists where the screen source is registered —
// the desktop app — so everything here answers 409 off it.

/** The one screen per process (plan D5): the ward reads no other source. */
const SOURCE = 'screen:local';
const OFF = 'Screen lens is not running on this computer. Open this page in the desktop app to use it.';

export const GET: APIRoute = async ({ params, locals }) => {
  const userId = locals.user!.userId;
  if (!lensWard(userId, params.ward)) return Response.json({ error: 'not a lens ward' }, { status: 400 });
  // Reading the card never subscribes: `lens()` builds the core without
  // connecting (only a consumer does that), and paused stays paused.
  const core = lens(userId, SOURCE);
  if (!core) return Response.json({ error: OFF }, { status: 409 });
  const s = core.status();
  const doc = core.doc();
  // What the app itself is doing, which a core that simply never went offline
  // cannot tell: consent withdrawn, or Screen Recording revoked, stops the
  // capture without anything reaching this document.
  const native = await lensNativeStatus();
  const meta = (key: string): string => doc.meta[key]?.value ?? '';
  return Response.json(
    {
      state: s.state,
      error: s.error,
      v: s.v,
      lines: s.lines,
      incomplete: s.incomplete,
      paused: lensPaused(userId),
      consented: lensSetting('consented'),
      // The three dots: the lens is consented to, granted and capturing and the
      // document is live; some of the text came from accessibility; an embedder
      // answered (the helper, or whatever stands in for it).
      dots: {
        screen:
          lensSetting('consented') && native !== null && native.screen && native.state !== 'stopped' && s.state === 'live',
        ax: doc.lines.some((l) => l.src === 'ax'),
        helper: s.embedding === true,
      },
      head: { app: meta('app'), window: meta('window'), focus: meta('focus') },
      // What the overlay is drawing and what the captions are doing: both are
      // the app's own state, never the document's.
      overlay: lensOverlay(),
      captions: captionsFor(core).state(),
      // Read, never subscribe: `history` would make the card a consumer of its
      // own and connect the source behind it.
      recent: core.recent('leylines', 5).map((d) => ({
        delivery: d.delivery,
        v: d.v,
        kind: d.kind,
        // The banner and the d= header are the first two lines of every
        // delivery; what changed starts after them.
        line: (d.text.split('\n').slice(2).find((l) => l.trim() !== '') ?? '').slice(0, 200),
      })),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const ward = lensWard(userId, params.ward);
  if (!ward) return Response.json({ error: 'not a lens ward' }, { status: 400 });
  const core = lens(userId, SOURCE);
  if (!core) return Response.json({ error: OFF }, { status: 409 });
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; on?: unknown; from?: unknown; to?: unknown }
    | null;
  switch (body?.action) {
    case 'pause':
    case 'resume': {
      // The row survives a restart (`startLens` re-applies it); the op stops the
      // capture itself, so a paused lens produces no signals and no deliveries.
      setLensPaused(userId, body.action === 'pause');
      return Response.json({ paused: lensPaused(userId) });
    }
    case 'captions': {
      // Captions are drawn on the overlay, so the ward's knob governs this door
      // exactly as it governs the lens_captions tool.
      if (body.on === true && (ward.config as Record<string, unknown> | undefined)?.overlay === false)
        return Response.json({ error: OVERLAY_OFF }, { status: 409 });
      // Nothing can be recognised, translated or drawn over a screen nothing is
      // reading, and turning them on would store the pair as if it had worked.
      const status = core.status();
      if (body.on === true && status.state === 'offline')
        return Response.json({ error: status.error ?? OFF }, { status: 409 });
      // A blank box is "whatever the stored pair says", never an empty code.
      const from = typeof body.from === 'string' && body.from !== '' ? body.from : undefined;
      const to = typeof body.to === 'string' && body.to !== '' ? body.to : undefined;
      const state = await captionsFor(core).set({
        on: body.on === true,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
      return Response.json(state);
    }
    case 'overlay-clear':
      // `unavailable` is a build with no overlay pool, which the card says
      // rather than failing as a server error.
      try {
        await captionsFor(core).clear();
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
      }
      return Response.json({ cleared: 'all' });
    default:
      return Response.json({ error: 'bad action' }, { status: 400 });
  }
};
