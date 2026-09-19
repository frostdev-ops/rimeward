import type { APIRoute } from 'astro';
import { getDashboard } from '../../../lib/dashboard.ts';
import { lens } from '../../../lib/lens/core.ts';
import { getSetting, setSetting } from '../../../lib/settings.ts';
import type { WardInstance } from '../../../lib/wards.ts';

export const prerender = false;

// The Screen lens ward: GET is what the card draws (is the lens reading, what
// it is reading, the deliveries it last handed over), POST is the card's three
// controls. The lens only ever exists where the screen source is registered —
// the desktop app — so everything here answers 409 off it.

/** The one screen per process (plan D5): the ward reads no other source. */
const SOURCE = 'screen:local';
const OFF = 'Screen lens is not running on this computer. Open this page in the desktop app to use it.';

export function lensWard(userId: number, ward: unknown): WardInstance | null {
  return getDashboard(userId).find((w) => w.i === ward && w.type === 'lens') ?? null;
}

// Pause is runtime state, never layout config (plan D7): the engine reads this
// row on every round, so a pause survives a restart and a layout save.
const pausedKey = (userId: number): string => `lens:paused:${userId}`;
export const lensPaused = (userId: number): boolean => getSetting(pausedKey(userId)) === '1';
export const setLensPaused = (userId: number, paused: boolean): void => setSetting(pausedKey(userId), paused ? '1' : '0');

export const GET: APIRoute = ({ params, locals }) => {
  const userId = locals.user!.userId;
  if (!lensWard(userId, params.ward)) return Response.json({ error: 'not a lens ward' }, { status: 400 });
  const core = lens(userId, SOURCE);
  if (!core) return Response.json({ error: OFF }, { status: 409 });
  const s = core.status();
  const doc = core.doc();
  const meta = (key: string): string => doc.meta[key]?.value ?? '';
  return Response.json(
    {
      state: s.state,
      error: s.error,
      v: s.v,
      lines: s.lines,
      incomplete: s.incomplete,
      paused: lensPaused(userId),
      // The three dots, each read off what the core actually has: the source is
      // reading, some of the text came from accessibility, and an embedder
      // answered (the helper, or whatever stands in for it).
      dots: { screen: s.state === 'live', ax: doc.lines.some((l) => l.src === 'ax'), helper: s.embedding === true },
      head: { app: meta('app'), window: meta('window'), focus: meta('focus') },
      recent: core.history('leylines', { limit: 5 }).map((d) => ({
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
      // ponytail: the row is the whole of pause until the engine lands (B2) —
      // it is what `ensureLens` reads to stop and restart the capture.
      setLensPaused(userId, body.action === 'pause');
      return Response.json({ paused: lensPaused(userId) });
    }
    case 'captions':
    case 'overlay-clear':
      return Response.json({ error: 'Captions and the overlay are unavailable until B4.' }, { status: 409 });
    default:
      return Response.json({ error: 'bad action' }, { status: 400 });
  }
};
