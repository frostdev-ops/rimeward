import type { APIRoute } from 'astro';
import { peekLens } from '../../../lib/lens/core.ts';
import { allWatches, deleteWatch } from '../../../lib/lens/store.ts';

export const prerender = false;

// Every lens watch this user has, across every source, and the one way to take
// one back off: the list in the agent ward's ⚙. Watches are added from chat
// (`lens_watch`), a monitor or a leyline — none of which is a place to see what
// is still running.
//
// Not ward-scoped and not relayed: `wardDevice` finds no ward called `watches`,
// so this answers from the runtime serving the dialog, which is the runtime
// whose cores wrote the rows.
// ponytail: a joined desktop forwards every unlisted /api path to the server
// (lib/dev/instance-routing.ts), so its dialog lists the server's watches; a
// per-device relay is worth building when a second runtime's watches need
// managing from here, not before.

export const GET: APIRoute = ({ locals }) => {
  const userId = locals.user!.userId;
  return Response.json(
    {
      watches: allWatches(userId).map((w) => {
        // A live core has evaluated these; its report is the truthful mode
        // (an embedder that came up or went away re-scores in memory) and the
        // only place `unavailable`/`weak` is said.
        const report = peekLens(userId, w.source)
          ?.reports(w.consumer)
          .find((r) => r.id === w.id);
        return {
          source: w.source,
          consumer: w.consumer,
          id: w.id,
          spec: w.spec,
          mode: report?.mode ?? w.mode,
          ...(report?.evaluation ? { evaluation: report.evaluation } : {}),
          created_at: w.createdAt,
        };
      }),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  const body = (await request.json().catch(() => null)) as
    | { source?: unknown; consumer?: unknown; id?: unknown }
    | null;
  const source = typeof body?.source === 'string' ? body.source : '';
  const consumer = typeof body?.consumer === 'string' ? body.consumer : '';
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!source || !consumer || !id) return Response.json({ error: 'source, consumer and id are required' }, { status: 400 });
  // Checked against the table first: `core.watch` would otherwise CREATE the
  // consumer a wrong id names, just to remove nothing from it.
  if (!allWatches(userId).some((w) => w.source === source && w.consumer === consumer && w.id === id)) {
    return Response.json({ error: 'no such watch' }, { status: 404 });
  }
  const core = peekLens(userId, source);
  // A live core holds its consumers' watches in memory: deleting the row under
  // it would leave the watch evaluating until the next restart.
  if (core) await core.watch(consumer, { remove: [id] });
  else deleteWatch(userId, source, consumer, id);
  return Response.json({ removed: id }, { headers: { 'cache-control': 'no-store' } });
};
