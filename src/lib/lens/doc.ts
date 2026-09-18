// The document: one mutable working copy of what a source currently shows, plus
// a ring of frozen versions a consumer can diff against. Pure — no I/O, no
// timers, no `Date.now()`. The source owns `epoch` and `seq`; this file obeys
// them. Lifted from BlackIce src/lens/scene.ts minus `apply(signal)`, which is
// the one screen-shaped part: each source translates its own signals into
// `epoch`/`meta`/`replace` calls.
//
// `live`, `regions`, `dirty` and `at` on the working copy belong to the source
// (the gate's own outputs and the source's clock); frozen versions are immutable.

import type { Diff, Doc, Line, Rect } from './types.ts';
import { VERSION_RING } from './types.ts';
import { diffDocs, sameRect } from './diff.ts';

/** One incoming line. `key` defaults to the normalised text; a source with its
 *  own identity (a terminal row) passes its own. */
export interface Draft {
  text: string;
  src: string;
  key?: string;
  bbox?: Rect;
  conf?: number;
}

/** Which existing lines a replacement claims. Absent = the whole document. */
export type Claims = (line: Line) => boolean;

export interface ReplaceResult {
  /** `none` nothing a consumer can see, `moved` applied with no version bump,
   *  `bump` starts or extends the settle window. */
  changed: 'none' | 'moved' | 'bump';
  added: Line[];
  removed: Line[];
  moved: Line[];
}

export class DocState {
  #ringSize: number;
  #ring = new Map<number, Doc>();
  #doc: Doc = blank();
  #ids = 0;
  #seq = 0;
  #metaSeq = new Map<string, number>();

  constructor(opts: { ring?: number } = {}) {
    this.#ringSize = opts.ring ?? VERSION_RING;
  }

  current(): Doc {
    return this.#doc;
  }

  version(v: number): Doc | undefined {
    return this.#ring.get(v);
  }

  /** The highest `seq` applied, for status and the gap boundary rule. */
  lastSeq(): number {
    return this.#seq;
  }

  markIncomplete(): void {
    this.#doc.incomplete = true;
  }

  /** Open a new epoch: everything the old one produced goes. An epoch that is
   *  not newer is ignored, which is how a signal from a window nobody is
   *  looking at is discarded. */
  epoch(epoch: number, seq: number): boolean {
    const doc = this.#doc;
    if (epoch <= doc.epoch) return false;
    doc.epoch = epoch;
    doc.meta = {};
    doc.lines = [];
    doc.regions = [];
    doc.dirty = [];
    doc.live = [];
    doc.ref = null;
    doc.incomplete = false;
    this.#metaSeq.clear();
    this.#seq = seq;
    return true;
  }

  /** Set (or, with `undefined`, drop) one header value. A write older than the
   *  last one for that key is discarded; the return says whether it changed. */
  meta(key: string, value: string | undefined, seq: number): boolean {
    const was = this.#metaSeq.get(key);
    if (was !== undefined && seq < was) return false;
    this.#metaSeq.set(key, seq);
    this.#seq = Math.max(this.#seq, seq);
    const doc = this.#doc;
    if (doc.meta[key] === value) return false;
    if (value === undefined) delete doc.meta[key];
    else doc.meta[key] = value;
    return true;
  }

  /** Replace the claimed lines with `drafts`. Stale: a read that finishes after
   *  a newer one covering the same lines cannot overwrite it. */
  replace(drafts: Draft[], seq: number, claims?: Claims): ReplaceResult {
    const doc = this.#doc;
    const keep: Line[] = [];
    const hit: Line[] = [];
    for (const line of doc.lines) ((claims ? claims(line) : true) ? hit : keep).push(line);

    if (hit.some((line) => seq <= line.seq)) return { changed: 'none', added: [], removed: [], moved: [] };
    this.#seq = Math.max(this.#seq, seq);

    const { lines, added, moved, gone } = this.#adopt(hit, drafts, seq);
    doc.lines = order([...keep, ...lines]);
    const changed = added.length || gone.length ? 'bump' : moved.length ? 'moved' : 'none';
    return { changed, added, removed: gone, moved };
  }

  /** Rebuild from a source's own snapshot. Ids survive wherever the text did,
   *  so a consumer that was up to date sees no churn. */
  snapshot(next: {
    epoch: number;
    seq: number;
    meta: Record<string, string>;
    lines: Draft[];
    live?: Rect[];
    ref?: string | null;
  }): void {
    const doc = this.#doc;
    doc.epoch = next.epoch;
    this.#seq = Math.max(this.#seq, next.seq);
    doc.meta = {};
    this.#metaSeq.clear();
    for (const [key, value] of Object.entries(next.meta)) {
      doc.meta[key] = value;
      this.#metaSeq.set(key, next.seq);
    }
    doc.regions = [];
    doc.dirty = [];
    doc.live = next.live ?? [];
    if (next.ref !== undefined) doc.ref = next.ref;
    doc.lines = order(this.#adopt(doc.lines, next.lines, next.seq).lines);
    doc.incomplete = false;
  }

  /** Bump the version, pin what this version was captured against, and push a
   *  deep-frozen copy into the ring. The frozen copy keeps the dirty rectangles
   *  that arrived since the previous version; the working copy starts afresh. */
  freeze(ref?: string | null): Doc {
    const doc = this.#doc;
    doc.v += 1;
    if (ref !== undefined) doc.ref = ref;
    const frozen = deepFreeze(structuredClone(doc));
    doc.dirty = [];
    this.#ring.set(frozen.v, frozen);
    while (this.#ring.size > this.#ringSize) {
      const oldest = this.#ring.keys().next();
      if (oldest.done) break;
      this.#ring.delete(oldest.value);
    }
    return frozen;
  }

  /** `from` outside the ring is the same as `from === null`: everything added,
   *  which is what makes the core send a keyframe. */
  diff(from: number | null, to: number): Diff {
    const target = this.#resolve(to);
    if (!target) throw new Error(`lens: version ${to} is neither current nor in the ring`);
    return diffDocs(from === null ? null : (this.#resolve(from) ?? null), target);
  }

  #resolve(v: number): Doc | undefined {
    return this.#ring.get(v) ?? (this.#doc.v === v ? this.#doc : undefined);
  }

  /** Give each incoming line the id of the same-key previous line with the
   *  nearest bbox centre, so duplicate labels survive as separate ids and a
   *  line that only shifted is `moved`, not removed-and-added.
   *  Greedy nearest-centre, O(n*m) per key group: exact enough for a screen's
   *  worth of lines, and a real assignment solver only matters if duplicates
   *  ever move past each other in one step. */
  #adopt(
    previous: Line[],
    incoming: Draft[],
    seq: number
  ): { lines: Line[]; added: Line[]; moved: Line[]; gone: Line[] } {
    const pool = new Map<string, Line[]>();
    for (const line of previous) {
      const group = pool.get(line.key);
      if (group) group.push(line);
      else pool.set(line.key, [line]);
    }

    const lines: Line[] = [];
    const added: Line[] = [];
    const moved: Line[] = [];
    for (const next of incoming) {
      const key = next.key ?? normalizeKey(next.text);
      const group = pool.get(key);
      let match: Line | undefined;
      if (group && group.length > 0) {
        let at = -1;
        let best = Infinity;
        for (const [index, candidate] of group.entries()) {
          const d = centreDistance(candidate.bbox, next.bbox);
          if (d < best) {
            best = d;
            at = index;
            match = candidate;
          }
        }
        if (at >= 0) group.splice(at, 1);
      }
      const line: Line = {
        id: match?.id ?? `t${++this.#ids}`,
        text: next.text,
        src: next.src,
        key,
        seq,
        ...(next.bbox === undefined ? {} : { bbox: next.bbox }),
        ...(next.conf === undefined ? {} : { conf: next.conf }),
      };
      lines.push(line);
      if (!match) added.push(line);
      else if (!sameRect(match.bbox, line.bbox)) moved.push(line);
    }

    const gone: Line[] = [];
    for (const group of pool.values()) gone.push(...group);
    return { lines, added, moved, gone };
  }
}

function blank(): Doc {
  return {
    v: 0,
    at: 0,
    epoch: 0,
    incomplete: false,
    meta: {},
    lines: [],
    regions: [],
    dirty: [],
    live: [],
    ref: null,
  };
}

/** The identity key: whitespace-normalised, trimmed text. */
export function normalizeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Reading order, so a keyframe renders top to bottom. A source without
 *  geometry compares equal throughout, which leaves its own order alone. */
function order(lines: Line[]): Line[] {
  return lines.sort((a, b) => (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0) || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0));
}

function centreDistance(a: Rect | undefined, b: Rect | undefined): number {
  if (!a || !b) return 0;
  const dx = a[0] + a[2] / 2 - (b[0] + b[2] / 2);
  const dy = a[1] + a[3] / 2 - (b[1] + b[3] / 2);
  return Math.hypot(dx, dy);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
}
