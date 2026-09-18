// The difference between two frozen documents, by line id. Pure, and the only
// place the event renderer and the gate get their candidate sets from.
// Lifted from BlackIce src/lens/diff.ts; the four scene booleans became
// `epoch` plus the changed meta keys.

import type { Diff, Dirty, Doc, Line, Rect } from './types.ts';

export function diffDocs(from: Doc | null, to: Doc): Diff {
  const before = new Map<string, Line>();
  for (const line of from?.lines ?? []) before.set(line.id, line);
  const after = new Set(to.lines.map((line) => line.id));

  const added: Line[] = [];
  const removed: Line[] = [];
  const moved: Line[] = [];

  for (const line of to.lines) {
    const was = before.get(line.id);
    if (!was) added.push(line);
    else if (was.key !== line.key) {
      // Cannot happen while ids are only reused on a key match; treated as a
      // replacement rather than silently dropped.
      removed.push(was);
      added.push(line);
    } else if (!sameRect(was.bbox, line.bbox)) moved.push(line);
  }
  for (const line of from?.lines ?? []) if (!after.has(line.id)) removed.push(line);

  // A dirty rectangle with a text change inside it is already explained by
  // that change; only the rest is a visual candidate.
  const centres = [...added, ...removed].flatMap((line) => (line.bbox ? [centre(line.bbox)] : []));
  const visual: Dirty[] = to.dirty.filter((d) => !centres.some((point) => inside(d.bbox, point)));

  return {
    from: from?.v ?? null,
    to: to.v,
    epoch: from === null || from.epoch !== to.epoch,
    metaChanged: metaChanged(from, to),
    added,
    removed,
    moved,
    visual,
  };
}

/** Keys whose VALUE differs, `to`'s insertion order first, then keys only
 *  `from` had. A field that only moved does not count as changed. */
function metaChanged(from: Doc | null, to: Doc): string[] {
  const out: string[] = [];
  for (const [key, field] of Object.entries(to.meta)) if (from?.meta[key]?.value !== field.value) out.push(key);
  for (const key of Object.keys(from?.meta ?? {})) if (!(key in to.meta)) out.push(key);
  return out;
}

export function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** True when the rectangle's centre sits outside every live region, and always
 *  true for a line with no geometry. The gate and the delta renderer share this
 *  so a live region's churn is dropped in both places the same way. */
export function outsideLive(live: Rect[], bbox: Rect | undefined): boolean {
  if (!bbox) return true;
  const point = centre(bbox);
  return !live.some((r) => inside(r, point));
}

export function iou(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function centre(rect: Rect): [number, number] {
  return [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
}

function inside(rect: Rect, point: [number, number]): boolean {
  return (
    point[0] >= rect[0] && point[0] <= rect[0] + rect[2] && point[1] >= rect[1] && point[1] <= rect[1] + rect[3]
  );
}
