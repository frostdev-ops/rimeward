// Leylines over the lens. A screen change and a watch hit are PUSHES: the core
// settles, gates and delivers, and this files the firing — there is no WATCHERS
// probe to poll. `syncLensEdges` is called from the engine's watch tick with
// the user's enabled lens edges, and reconciles the consumers those edges need:
//
//   screen-changed  one `leylines` consumer on `screen:local`, whatever the
//                   number of lens wards carrying such an edge
//   watch-matched   one `edge-<edgeId>` consumer on the ward's own source, so
//                   the watch spec (which is the edge's) belongs to it alone
//
// Every delivery is acknowledged as soon as it has fired: an unacknowledged
// delivery stands, and the core would deliver nothing else to that consumer.

import { lens, peekLens } from './core.ts';
import type { LensCore } from './core.ts';
import { parseWatchSpec } from './gate.ts';
// One resolution of a terminal WARD id to the session it is showing, shared with
// the lens source itself (a `terminal:<ward id>` source resolves the same way).
import { terminalSession } from './terminal.ts';
import type { Delivery, WatchSpec } from './types.ts';
import { broadcast, enqueueFire, takeSlot } from '../logic-engine.ts';
import type { LogicEdge } from '../logic.ts';
import type { WardInstance } from '../wards.ts';

/** Screen changes a user's graph may fire on per hour. */
const SCREEN_CAP_PER_HOUR = 300;
/** Test seam: the per-user hourly window a `screen-changed` firing takes. */
export const screenWindow = new Map<number, number[]>();
/** How much observed text a firing carries into `{{screen.text}}` / `{{lens.text}}`. */
const TEXT_MAX = 4000;
/** One ward repaint per burst of scene/status events. */
const REFRESH_MS = 2000;

interface Bound {
  source: string;
  /** Drops the delivery listener. */
  off: () => void;
  /** watch-matched: the edge as it stands, re-read on every delivery so a
   *  renamed or re-pointed edge is never fired from a stale closure. */
  edge?: LogicEdge;
  /** watch-matched: the spec its watch was installed from. */
  specKey?: string;
  /** screen-changed: the edges this one consumer feeds, with the app each one
   *  filters on ('' = every app). */
  screen?: ScreenEdge[];
}

/** One `screen-changed` edge: which ward it hangs off and what its `app` filter
 *  says. The filter is matched HERE rather than by `edgeMatches`, which is exact
 *  equality against one string — the header value carries the bundle id, the
 *  name and the pid at once. */
interface ScreenEdge {
  id: string;
  ward: string;
  app: string;
}

/** `com.apple.Safari "Safari" pid=812` → its bundle id and its name. */
function appOf(header: string): { bundle: string; name: string } {
  const match = /^(\S+) "(.*)" pid=/.exec(header);
  return { bundle: match?.[1] ?? header, name: match?.[2] ?? '' };
}

/** The filter takes a bundle id (exactly) or the app's name (either case). */
function appMatches(filter: string, header: string): boolean {
  if (filter === '') return true; // no filter: every app
  const { bundle, name } = appOf(header);
  return filter === bundle || filter.toLowerCase() === name.toLowerCase();
}

/** Keyed `<user>:<consumer>`. */
const bound = new Map<string, Bound>();
const refreshers = new Map<number, { off: () => void; timer?: ReturnType<typeof setTimeout> }>();

/** The screen document's header fields plus the delivery itself: what both lens
 *  triggers put in scope. */
function screenVars(core: LensCore, d: Delivery): Record<string, string> {
  const doc = core.version(d.v) ?? core.doc();
  const meta = (key: string): string => doc.meta[key]?.value ?? '';
  return {
    'screen.app': meta('app'),
    'screen.window': meta('window'),
    'screen.title': meta('title'),
    'screen.focus': meta('focus'),
    'screen.text': d.text.slice(0, TEXT_MAX),
    'screen.v': String(d.v),
    'screen.ref': d.ref ?? '',
  };
}

/** Acknowledged through `look`, the way a monitor acknowledges: it is the one
 *  public door onto the cursor, and it renders nothing with `fields: []`. */
function ack(core: LensCore, consumer: string, d: Delivery): void {
  try {
    core.look(consumer, { ack: d.delivery, fields: [] });
  } catch {
    // The delivery is stale or the core went away; the next one re-offers it.
  }
}

function fireScreen(user: number, core: LensCore, entry: Bound, d: Delivery): void {
  const vars = screenVars(core, d);
  const header = vars['screen.app'] ?? '';
  // The filter first: a change in an app nobody watches must not spend the
  // hourly window, and the slot is one per change, not one per edge.
  const want = (entry.screen ?? []).filter((e) => appMatches(e.app, header));
  if (want.length > 0) {
    try {
      takeSlot(screenWindow, user, SCREEN_CAP_PER_HOUR, 'screen event');
      for (const edge of want) {
        // `onlyEdge`, because the match was made here: `edgeMatches` compares the
        // edge's own `app` param against `match.app` by equality, and a name
        // filter is not the header the bundle id came from.
        enqueueFire(user, {
          type: 'screen-changed',
          ward: edge.ward,
          match: { app: edge.app || appOf(header).bundle },
          onlyEdge: edge.id,
          extra: vars,
        });
      }
    } catch {
      // Over the hourly cap: the change is dropped, never held — holding the
      // acknowledgement would wedge the consumer for the rest of the window.
    }
  }
  ack(core, 'leylines', d);
}

function fireWatch(user: number, core: LensCore, consumer: string, entry: Bound, d: Delivery): void {
  const edge = entry.edge;
  if (edge) {
    const name = edge.source.params.name;
    enqueueFire(user, {
      type: 'watch-matched',
      ward: edge.source.ward,
      ...(typeof name === 'string' && name !== '' ? { match: { name } } : {}),
      // The watch belongs to this edge alone: a sibling edge on the same ward
      // has its own consumer and its own spec.
      onlyEdge: edge.id,
      extra: {
        'lens.text': d.text.slice(0, TEXT_MAX),
        'lens.delivery': d.delivery,
        'lens.v': String(d.v),
        ...(entry.source.startsWith('screen:') ? screenVars(core, d) : {}),
      },
    });
  }
  ack(core, consumer, d);
}

/** The `<type>:<target>` a ward's leyline reads, or null when it has none. */
function sourceOf(user: number, ward: WardInstance | undefined): string | null {
  if (!ward) return null;
  if (ward.type === 'lens') return 'screen:local';
  // One page per ward, so the ward id IS the target.
  if (ward.type === 'browser') return `browser:${ward.i}`;
  if (ward.type !== 'terminal') return null;
  const session = terminalSession(user, ward.i);
  return session ? `terminal:${session}` : null;
}

function drop(key: string, entry: Bound): void {
  bound.delete(key);
  entry.off();
  const at = key.indexOf(':');
  const user = Number(key.slice(0, at));
  try {
    // `peekLens`, never `lens`: an edge going away must not build (and connect)
    // a source nobody is reading.
    peekLens(user, entry.source)?.deleteConsumer(key.slice(at + 1));
  } catch {
    /* nothing to drop */
  }
}

function syncScreenChanged(user: number, edges: ScreenEdge[]): void {
  const key = `${user}:leylines`;
  const entry = bound.get(key);
  if (edges.length === 0) {
    if (entry) drop(key, entry);
    return;
  }
  if (entry) {
    entry.screen = edges;
    return;
  }
  const core = lens(user, 'screen:local');
  if (!core) return; // no screen source on this runtime (the server)
  const { release } = core.acquire();
  // The listener goes on FIRST: `consumer()` is what connects the source, and a
  // source that writes its header synchronously delivers inside that call.
  const off = core.on('delivery', (id, d) => {
    const held = bound.get(key);
    if (id === 'leylines' && held) fireScreen(user, core, held, d);
  });
  const held: Bound = { source: 'screen:local', off: () => { off(); release(); }, screen: edges };
  bound.set(key, held);
  core.consumer('leylines', 'edge');
  clearStale(core, 'leylines', true);
}

/** A delivery a previous process never acknowledged stalls the consumer for
 *  good — nothing else is ever rendered for it. `refire`: `look` re-renders it
 *  from the same cursor, and that re-render reaches the listener bound just
 *  above, which fires it and acknowledges it (so nothing fires it here — that
 *  would file the same change twice). Otherwise it is only acknowledged. */
function clearStale(core: LensCore, consumer: string, refire: boolean): void {
  try {
    const held = core.status().consumers.find((c) => c.id === consumer)?.delivered;
    if (!held) return;
    if (refire) core.look(consumer, { fields: [] });
    else core.look(consumer, { ack: held, fields: [], offer: false });
  } catch {
    /* nothing outstanding */
  }
}

function syncWatch(user: number, consumer: string, edge: LogicEdge, source: string, spec: WatchSpec): void {
  const core = lens(user, source);
  if (!core) return;
  const key = `${user}:${consumer}`;
  let entry = bound.get(key);
  if (!entry) {
    const { release } = core.acquire();
    const off = core.on('delivery', (id, d) => {
      const held = bound.get(key);
      if (id === consumer && held) fireWatch(user, core, consumer, held, d);
    });
    entry = { source, off: () => { off(); release(); } };
    bound.set(key, entry);
  }
  entry.edge = edge;
  const specKey = JSON.stringify(spec);
  if (entry.specKey === specKey) return;
  entry.specKey = specKey;
  const held = core.consumer(consumer, 'edge');
  // An outstanding delivery was rendered under the spec the LAST process
  // installed. If that is still this edge's spec, it is a hit nobody filed and
  // it fires now; if the edge has been edited since, the delivery answers a
  // question nobody is asking any more, so it is acknowledged and not fired —
  // the consumer would otherwise stall on it for good.
  const unchanged = held.watches.length === 1 && JSON.stringify(held.watches[0]!.spec) === specKey;
  clearStale(core, consumer, unchanged);
  void core.watch(consumer, { add: [spec], remove: held.watches.map((w) => w.id) }).catch(() => {
    const again = bound.get(key);
    if (again) again.specKey = undefined; // re-install on the next tick
  });
}

/** One repaint of the lens ward per burst: the card renders the core's status
 *  and its last deliveries, and neither is worth an event of its own. */
function syncRefresh(user: number, layout: WardInstance[]): void {
  const held = refreshers.get(user);
  if (!layout.some((w) => w.type === 'lens')) {
    if (held) {
      held.off();
      clearTimeout(held.timer);
      refreshers.delete(user);
    }
    return;
  }
  if (held) return;
  const core = lens(user, 'screen:local');
  if (!core) return;
  const entry: { off: () => void; timer?: ReturnType<typeof setTimeout> } = { off: () => {} };
  const bump = (): void => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      broadcast(user, 'refresh', { type: 'lens' });
    }, REFRESH_MS);
    entry.timer.unref?.();
  };
  const offScene = core.on('scene', bump);
  const offStatus = core.on('status', bump);
  entry.off = (): void => {
    offScene();
    offStatus();
  };
  refreshers.set(user, entry);
}

/** Reconcile one user's lens consumers with the ENABLED lens edges among those
 *  given (a disabled edge is the same as a deleted one here). Called on
 *  every engine watch tick, so a disabled, deleted or re-pointed edge drops its
 *  consumer within one tick. */
export function syncLensEdges(user: number, edges: LogicEdge[], layout: WardInstance[]): void {
  const wardOf = (id: string): WardInstance | undefined => layout.find((w) => w.i === id);

  syncScreenChanged(
    user,
    edges
      .filter((e) => e.enabled && e.source.trigger === 'screen-changed' && wardOf(e.source.ward)?.type === 'lens')
      .map((e) => ({ id: e.id, ward: e.source.ward, app: typeof e.source.params.app === 'string' ? e.source.params.app : '' }))
  );

  const want = new Map<string, { edge: LogicEdge; source: string; spec: WatchSpec }>();
  for (const edge of edges) {
    if (!edge.enabled || edge.source.trigger !== 'watch-matched') continue;
    const source = sourceOf(user, wardOf(edge.source.ward));
    if (!source) continue;
    const params = edge.source.params;
    const regex = typeof params.regex === 'string' ? params.regex : '';
    // The gate reads `for` BEFORE `regex` (gate.ts watchMode), so a spec
    // carrying both would never test the pattern: a leyline that gives a
    // pattern is watching for it, and `for` stays as the plain-words label.
    let spec: WatchSpec;
    try {
      // `triage: false` on the pattern: a leyline that names a pattern means
      // that pattern, not a model's opinion of it. A `for` watch still ends in
      // triage, and reads `unavailable` until a decider is installed (track D).
      spec = parseWatchSpec(regex ? { regex, triage: false } : { for: String(params.for ?? '') });
    } catch {
      continue; // an unusable spec is an inert edge, never a thrown tick
    }
    want.set(`edge-${edge.id}`, { edge, source, spec });
  }

  for (const [key, entry] of [...bound]) {
    if (!key.startsWith(`${user}:edge-`)) continue;
    const next = want.get(key.slice(String(user).length + 1));
    if (!next || next.source !== entry.source) drop(key, entry);
  }
  for (const [consumer, w] of want) syncWatch(user, consumer, w.edge, w.source, w.spec);

  syncRefresh(user, layout);
}
