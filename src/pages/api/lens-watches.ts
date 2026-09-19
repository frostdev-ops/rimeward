import type { APIRoute } from 'astro';
import { peekLens } from '../../lib/lens/core.ts';
import { allWatches, deleteWatch } from '../../lib/lens/store.ts';

export const prerender = false;

// Every lens watch this user has, across every source, and the one way to take
// one back off: the list in the agent ward's ⚙. Watches are added from chat
// (`lens_watch`), a monitor or a leyline — none of which is a place to see what
// is still running.
//
// NOT under /api/lens/, which is the ward route's shape (`/api/lens/<ward>`): a
// ward whose id is `watches` is a legal id, and it would shadow this. It is
// local on a joined desktop too (`localPaths` in lib/dev/instance-routing.ts) —
// a screen core only ever exists on the runtime that owns the screen, so the
// list has to be that runtime's own.
// ponytail: one runtime's watches at a time; a per-device relay is worth
// building when a second runtime's watches need managing from here.

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
  // A leyline's or a monitor's watch is written by the thing that owns it and
  // rewritten on its next sync: removing it here would come straight back.
  const managed = consumer.startsWith('edge-') ? 'leyline' : consumer.startsWith('mon-') ? 'monitor' : '';
  if (managed) return Response.json({ error: `This watch belongs to a ${managed}; remove the ${managed} instead.` }, { status: 409 });
  const core = peekLens(userId, source);
  // A live core holds its consumers' watches in memory: deleting the row under
  // it would leave the watch evaluating until the next restart.
  if (core) await core.watch(consumer, { remove: [id] });
  else deleteWatch(userId, source, consumer, id);
  return Response.json({ removed: id }, { headers: { 'cache-control': 'no-store' } });
};
