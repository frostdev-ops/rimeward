// Delivery rendering and acknowledgement bookkeeping. Pure: no DB, no clock, no
// document mutation. Every function here takes the frozen document and the
// consumer record and returns text plus the state change the caller persists.
// Lifted from BlackIce src/lens/events.ts; the scene's four header fields
// became the source's own `meta` map.
//
// Line format:
//   [lens observation: ...]
//   d=c1:17 key   v=1842 epoch=7 ref=f-7-298 page=1/3
//   d=c1:18 delta v=1843 since=1842 epoch=7 ref=f-7-301
//   app= / window= / focus= / …one line per meta entry… / incomplete
//   = + - x,y,w,h src "text"      ~ x,y,w,h d=0.31 "interpreted" (ref f-7-298)
//   live x,y,w,h                  … N lines omitted; use lens_text {rect} or lens_look
import type { Consumer, Delivery, Diff, Dirty, Doc, Line, Rect, Region } from './types.ts';
import { DELIVERY_CAP, OBSERVATION_BANNER } from './types.ts';
import { iou, outsideLive } from './diff.ts';

export interface Rendered {
  text: string;
  kind: 'key' | 'delta';
  page: number;
  pages: number;
  truncated: boolean;
  omitted: number;
  since: number | null; // carried so claimDelivery does not have to be told again
}

export const KEY_AFTER_DELTAS = 20;
/** Header values are cut HERE and nowhere else: the gate reads them whole. */
const META_VALUE_CAP = 120;
const ID_DIGIT_RESERVE = 12; // widest delivery counter the header budget allows for

const q = (s: string): string => JSON.stringify(s);
const box = (r: Rect): string => `${Math.round(r[0])},${Math.round(r[1])},${Math.round(r[2])},${Math.round(r[3])}`;
const omittedTail = (n: number): string => `… ${n} lines omitted; use lens_text {rect} or lens_look`;

// Top-to-bottom, then left-to-right; a source without geometry keeps its own order.
const byPosition = (a: { bbox?: Rect }, b: { bbox?: Rect }): number =>
  (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0) || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0);

/** Changed-key mask: `null` renders every meta entry the document has (a keyframe). */
type Fields = string[] | null;

function metaLines(doc: Doc, only: Fields): string[] {
  const out: string[] = [];
  for (const [key, field] of Object.entries(doc.meta)) {
    if (only !== null && !only.includes(key)) continue;
    const value =
      field.value.length > META_VALUE_CAP ? `${field.value.slice(0, META_VALUE_CAP)}…` : field.value;
    out.push(`${key}=${value}`);
  }
  if (doc.incomplete) out.push('incomplete');
  return out;
}

const textLine = (sigil: '=' | '+' | '-', l: Line): string =>
  `${sigil} ${l.bbox ? `${box(l.bbox)} ` : ''}${l.src} ${q(l.text)}`;

function visualLine(d: Dirty, regions: Region[]): string {
  const base = `~ ${box(d.bbox)} d=${d.d.toFixed(2)}`;
  const region = regions.find((r) => iou(r.bbox, d.bbox) >= 0.5);
  return region ? `${base} ${q(region.interpreted)} (ref ${region.ref})` : base;
}

function header(
  id: string,
  kind: 'key' | 'delta',
  v: number,
  since: number | null,
  epoch: number,
  ref: string | null,
  page: number,
  pages: number
): string {
  let s = `d=${id} ${kind} v=${v}`;
  if (kind === 'delta' && since !== null) s += ` since=${since}`;
  s += ` epoch=${epoch}`;
  if (ref !== null) s += ` ref=${ref}`;
  if (pages > 1) s += ` page=${page}/${pages}`;
  return s;
}

// Page count must not depend on the delivery counter: page 2 is rendered after
// page 1 was claimed, so the real id is one longer some of the time. Budget the
// widest id and the widest page token instead, and every page of one frozen
// document reports the same `m`.
function headerReserve(consumer: Consumer, doc: Doc, pages: number): number {
  const id = `${consumer.id}:${'9'.repeat(ID_DIGIT_RESERVE)}`;
  return header(id, 'key', doc.v, null, doc.epoch, doc.ref, pages, pages).length;
}

function pack(meta: string[], body: string[], reserve: number): string[][] {
  const base = OBSERVATION_BANNER.length + 1 + reserve; // banner \n header
  const out: string[][] = [];
  let cur: string[] = [...meta]; // page 1 carries the metadata block
  let used = base + cur.reduce((n, l) => n + 1 + l.length, 0);
  for (const line of body) {
    if (cur.length > 0 && used + 1 + line.length > DELIVERY_CAP) {
      out.push(cur);
      cur = [];
      used = base;
    }
    cur.push(line);
    used += 1 + line.length;
  }
  out.push(cur);
  return out;
}

function paginate(consumer: Consumer, doc: Doc, meta: string[], body: string[]): string[][] {
  let pages = 1;
  for (let i = 0; i < 8; i++) {
    const out = pack(meta, body, headerReserve(consumer, doc, pages));
    if (out.length === pages) return out;
    pages = out.length; // reserve only grows with the page token, so this converges
  }
  return pack(meta, body, headerReserve(consumer, doc, pages));
}

export function renderKeyframe(doc: Doc, consumer: Consumer, opts: { page: number }): Rendered {
  const meta = metaLines(doc, null);
  const body = [
    ...[...doc.lines].sort(byPosition).map((l) => textLine('=', l)),
    ...doc.live.map((r) => `live ${box(r)}`),
  ];
  const pages = paginate(consumer, doc, meta, body);
  const page = Math.min(Math.max(1, Math.trunc(opts.page)), pages.length);
  const head = header(nextDeliveryId(consumer), 'key', doc.v, null, doc.epoch, doc.ref, page, pages.length);
  const text = [OBSERVATION_BANNER, head, ...(pages[page - 1] ?? [])].join('\n');
  return { text, kind: 'key', page, pages: pages.length, truncated: false, omitted: 0, since: null };
}

/** `removals: false` is a source whose lines only ever scroll away (a terminal):
 *  the `-` lines would be noise, so they are left out of the delta. */
export function renderDelta(
  doc: Doc,
  since: Doc,
  diff: Diff,
  consumer: Consumer,
  opts: { removals?: boolean } = {}
): Rendered {
  const meta = metaLines(doc, diff.metaChanged);
  // A live region's churn is what the gate dropped; the `live` line stands in
  // for it, so the same entries stay out of the rendered delta.
  const still = <T extends { bbox?: Rect }>(items: T[]): T[] =>
    items.filter((item) => outsideLive(doc.live, item.bbox)).sort(byPosition);
  const body = [
    ...still(diff.added).map((l) => textLine('+', l)),
    ...(opts.removals === false ? [] : still(diff.removed).map((l) => textLine('-', l))),
    ...still(diff.visual).map((d) => visualLine(d, doc.regions)),
    ...doc.live.map((r) => `live ${box(r)}`),
  ];
  const head = [
    OBSERVATION_BANNER,
    header(nextDeliveryId(consumer), 'delta', doc.v, since.v, doc.epoch, doc.ref, 1, 1),
    ...meta,
  ];
  const full = [...head, ...body].join('\n');
  if (full.length <= DELIVERY_CAP) {
    return { text: full, kind: 'delta', page: 1, pages: 1, truncated: false, omitted: 0, since: since.v };
  }
  // Never slice a line: keep whole lines while the omission receipt still fits.
  const tail = 1 + omittedTail(body.length).length; // widest tail, so the real one always fits
  let used = head.reduce((n, l) => n + l.length, 0) + head.length - 1;
  const kept: string[] = [];
  for (const line of body) {
    if (used + 1 + line.length + tail > DELIVERY_CAP) break;
    kept.push(line);
    used += 1 + line.length;
  }
  const omitted = body.length - kept.length;
  const text = [...head, ...kept, omittedTail(omitted)].join('\n');
  return { text, kind: 'delta', page: 1, pages: 1, truncated: true, omitted, since: since.v };
}

export const nextDeliveryId = (consumer: Consumer): string => `${consumer.id}:${consumer.nextDelivery + 1}`;

/** Consumes the id `renderKeyframe`/`renderDelta` stamped into the header. `lastSentAt` is the caller's. */
export function claimDelivery(
  consumer: Consumer,
  rendered: Rendered,
  v: number,
  epoch: number,
  ref: string | null
): Delivery {
  consumer.nextDelivery += 1;
  const id = `${consumer.id}:${consumer.nextDelivery}`;
  consumer.delivered = {
    id,
    v,
    kind: rendered.kind,
    page: rendered.page,
    pages: rendered.pages,
    truncated: rendered.truncated,
  };
  const delivery: Delivery = {
    delivery: id,
    v,
    since: rendered.since,
    epoch,
    ref,
    kind: rendered.kind,
    text: rendered.text,
  };
  if (rendered.pages > 1) delivery.page = `${rendered.page}/${rendered.pages}`;
  if (rendered.truncated) delivery.truncated = true;
  return delivery;
}

/** `versionExists` is part of the contract's signature; the ack rules do not need it today. */
export function ack(consumer: Consumer, ackId: string, versionExists: (v: number) => boolean): 'applied' | 'ignored' {
  void versionExists;
  const d = consumer.delivered;
  if (!d || ackId !== d.id) return 'ignored';
  if (d.kind === 'delta') {
    consumer.cursor = d.v;
    if (d.truncated) consumer.baseline = { v: d.v, complete: false };
    else consumer.deltas += 1;
    consumer.delivered = null;
    return 'applied';
  }
  if (d.page >= d.pages) {
    consumer.cursor = d.v;
    consumer.baseline = { v: d.v, complete: true };
    consumer.deltas = 0;
    consumer.delivered = null;
    return 'applied';
  }
  // Acked but not finished: `pendingPage` both names the next page and marks the
  // record acknowledged, so `redeliver` stops offering the page just accepted.
  consumer.delivered = { ...d, pendingPage: d.page + 1 };
  return 'applied';
}

export function nextKind(
  consumer: Consumer,
  doc: Doc,
  versionExists: (v: number) => boolean,
  changed: { epoch: boolean; key: boolean },
  forceKey: boolean
): { kind: 'key'; page: number; v: number } | { kind: 'delta'; since: number } {
  const d = consumer.delivered;
  // Paging runs to the end on its own frozen version, newer versions or not.
  if (d && d.kind === 'key') return { kind: 'key', page: d.pendingPage ?? d.page, v: d.v };
  if (
    forceKey ||
    consumer.cursor === null ||
    !versionExists(consumer.cursor) ||
    consumer.baseline === null ||
    !consumer.baseline.complete ||
    changed.epoch ||
    changed.key ||
    consumer.deltas >= KEY_AFTER_DELTAS
  ) {
    return { kind: 'key', page: 1, v: doc.v };
  }
  return { kind: 'delta', since: consumer.cursor };
}

/** True while the last delivery is still unacknowledged: re-render it from the unchanged cursor. */
export const redeliver = (consumer: Consumer): boolean =>
  consumer.delivered !== null && consumer.delivered.pendingPage === undefined;
