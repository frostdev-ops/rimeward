import type { APIRoute } from 'astro';
import { lens } from '../../../lib/lens/core.ts';
import { lensNativeStatus, lensPaused, lensWard, setLensPaused } from '../../../lib/lens/runtime.ts';
import { lensSetting } from '../../../lib/lens/settings.ts';

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
  if (!lensWard(userId, params.ward)) return Response.json({ error: 'not a lens ward' }, { status: 400 });
  if (!lens(userId, SOURCE)) return Response.json({ error: OFF }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  switch (body?.action) {
    case 'pause':
    case 'resume': {
      // The row survives a restart (`startLens` re-applies it); the op stops the
      // capture itself, so a paused lens produces no signals and no deliveries.
      setLensPaused(userId, body.action === 'pause');
      return Response.json({ paused: lensPaused(userId) });
    }
    case 'captions':
    case 'overlay-clear':
      return Response.json({ error: 'Captions and the overlay are not available on this computer yet.' }, { status: 409 });
    default:
      return Response.json({ error: 'bad action' }, { status: 400 });
  }
};
