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
import type { Consumer, ConsumerKind, Delivery, Diff, Dirty, Doc, KeyReason, Line, Rect, Region } from './types.ts';
import { AGENT_DELIVERY_CAP, DELIVERY_CAP, OBSERVATION_BANNER } from './types.ts';
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
/** A conversation reads its deliveries as one JSON string field, so what it
 *  costs is the ESCAPED length (`cost` below) against a tighter cap. Every
 *  other consumer reads the text raw and keeps DELIVERY_CAP — including `cli`:
 *  an MCP host is handed the text as content, not as a JSON field of a tool
 *  receipt, and the lifted fixtures are recorded against that. */
export const deliveryCap = (kind: ConsumerKind): number => (kind === 'conv' ? AGENT_DELIVERY_CAP : DELIVERY_CAP);

/** What one line costs against a delivery cap, INCLUDING the newline that
 *  joins it to the line before. Inside a JSON string every quote, backslash and
 *  newline becomes two characters, and a line of Windows paths or quoted output
 *  can be half as long again — enough for a page budgeted raw to blow the
 *  agent's output cap and be dropped whole. The separator counts too: `\n` is
 *  one character in the text and two in the field the model reads. The `- 2`
 *  drops the quotes JSON.stringify puts around the value. */
export const escapedLength = (line: string): number => JSON.stringify(line).length - 2;
export const lineCost = (line: string, escaped: boolean): number =>
  escaped ? escapedLength(line) + 2 : line.length + 1;
export const cost = (line: string, kind: ConsumerKind): number => lineCost(line, kind === 'conv');
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
    // The cut is the value's; where the field sits is printed after it, in the
    // same shape a text line's box has.
    out.push(`${key}=${value}${field.bounds ? ` bounds=${box(field.bounds)}` : ''}`);
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
  return cost(header(id, 'key', doc.v, null, doc.epoch, doc.ref, pages, pages), consumer.kind);
}

function pack(meta: string[], body: string[], reserve: number, cap: number, kind: ConsumerKind): string[][] {
  const base = cost(OBSERVATION_BANNER, kind) + reserve; // banner \n header, separators included
  const out: string[][] = [];
  let cur: string[] = [...meta]; // page 1 carries the metadata block
  let used = base + cur.reduce((n, l) => n + cost(l, kind), 0);
  for (const line of body) {
    if (cur.length > 0 && used + cost(line, kind) > cap) {
      out.push(cur);
      cur = [];
      used = base;
    }
    cur.push(line);
    used += cost(line, kind);
  }
  out.push(cur);
  return out;
}

function paginate(consumer: Consumer, doc: Doc, meta: string[], body: string[]): string[][] {
  const cap = deliveryCap(consumer.kind);
  let pages = 1;
  for (let i = 0; i < 8; i++) {
    const out = pack(meta, body, headerReserve(consumer, doc, pages), cap, consumer.kind);
    if (out.length === pages) return out;
    pages = out.length; // reserve only grows with the page token, so this converges
  }
  return pack(meta, body, headerReserve(consumer, doc, pages), cap, consumer.kind);
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
  const cap = deliveryCap(consumer.kind);
  const charge = (line: string): number => cost(line, consumer.kind);
  const full = [...head, ...body].join('\n');
  if ([...head, ...body].reduce((n, l) => n + charge(l), 0) <= cap) {
    return { text: full, kind: 'delta', page: 1, pages: 1, truncated: false, omitted: 0, since: since.v };
  }
  // Never slice a line: keep whole lines while the omission receipt still fits.
  const tail = charge(omittedTail(body.length)); // widest tail, so the real one always fits
  let used = head.reduce((n, l) => n + charge(l), 0);
  const kept: string[] = [];
  for (const line of body) {
    if (used + charge(line) + tail > cap) break;
    kept.push(line);
    used += charge(line);
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
  ref: string | null,
  reason?: KeyReason
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
    ...(reason === undefined ? {} : { reason }),
  };
  const delivery: Delivery = {
    delivery: id,
    v,
    since: rendered.since,
    epoch,
    ref,
    kind: rendered.kind,
    ...(reason === undefined ? {} : { reason }),
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
): { kind: 'key'; page: number; v: number; reason?: KeyReason } | { kind: 'delta'; since: number } {
  const d = consumer.delivered;
  // Paging runs to the end on its own frozen version, newer versions or not. A
  // whole keyframe offered again (page 1, nothing pending) is offered at the
  // newest version: the cursor it renders from is unchanged, and the reader is
  // owed what the source shows now, not the header-only version a window
  // change froze before its lines had landed.
  if (d && d.kind === 'key') {
    const page = d.pendingPage ?? d.page;
    return { kind: 'key', page, v: page > 1 ? d.v : doc.v, ...(d.reason ? { reason: d.reason } : {}) };
  }
  // In cause order: the first read of all, then what the ring no longer holds,
  // then the changes that are themselves the observation.
  if (consumer.cursor === null || consumer.baseline === null) return { kind: 'key', page: 1, v: doc.v, reason: 'first' };
  const cursor = consumer.cursor;
  const reason: KeyReason | null =
    !versionExists(cursor) ? 'evicted'
      : forceKey ? 'recovery'
      : !consumer.baseline.complete ? 'truncated'
      : changed.epoch ? 'epoch'
      : changed.key ? 'meta'
      : consumer.deltas >= KEY_AFTER_DELTAS ? 'deltas'
      : null;
  if (reason !== null) return { kind: 'key', page: 1, v: doc.v, reason };
  return { kind: 'delta', since: cursor };
}

/** True while the last delivery is still unacknowledged: re-render it from the unchanged cursor. */
export const redeliver = (consumer: Consumer): boolean =>
  consumer.delivered !== null && consumer.delivered.pendingPage === undefined;
