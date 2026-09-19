// The lens core: a source's feed in, deliveries out. It owns the settle window,
// the consumer records, the waiters and gap recovery. Everything time-based
// rides on the injected `Clock`; the source is the only thing that talks to the
// outside world. Lifted from BlackIce src/lens/core.ts minus the screen-only
// reads (`text`/`crop`/`describe`/`#frame`) and the direct `#desk` channel:
// what was a wire signal is now a `Feed` call, and the source's own snapshot is
// what gap recovery asks for.

import { DocState } from './doc.ts';
import type { Claims, Draft } from './doc.ts';
import { diffDocs, iou, outsideLive } from './diff.ts';
import { ack as applyAck, claimDelivery, nextKind, renderDelta, renderKeyframe } from './events.ts';
import {
  DESCRIBE_PROMPT,
  DESCRIBE_SCHEMA,
  SETTLE_CAP_MS,
  calibrateCommand,
  calibration,
  candidates,
  describeTarget,
  evaluate,
  gateDefaults,
  liveRegions,
  readDescription,
  watchEvaluation,
  watchMode,
  watchText,
} from './gate.ts';
import type { DescribeQuery, GateDeps, TriageQuery, WatchReport } from './gate.ts';
import { sqliteStore } from './store.ts';
import type { Store } from './store.ts';
import type {
  Consumer,
  ConsumerKind,
  Delivery,
  Dirty,
  Doc,
  Line,
  MetaField,
  Rect,
  Region,
  Watch,
  WatchMode,
  WatchSpec,
} from './types.ts';

/** How much frame history the live-region detector needs. */
const FRAME_HISTORY_MS = 3000;
/** Interpreted regions kept on the working copy within one epoch. */
const REGION_CAP = 16;
/** Dirty rectangles kept on the working copy between two versions. */
const DIRTY_CAP = 32;

/** Injected everywhere time is read, so tests never wait. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The two knobs a ward carries; everything else the gate derives. */
export interface LensSettings {
  settleMs: number;
  minLines: number;
}

export const LENS_SETTINGS: LensSettings = { settleMs: 750, minLines: 1 };

/** What can judge a change, when anything can (D6 fills this in on track D). */
export interface Decider {
  embedderId?: string;
  embed?: (texts: string[]) => Promise<number[][] | null>;
  triage?: (q: TriageQuery) => Promise<{ yes: boolean } | { error: string }>;
  describe?: (q: DescribeQuery) => Promise<{ json: unknown } | { error: string }>;
  cloudTriage?: (q: TriageQuery) => Promise<{ yes: boolean } | { error: string }>;
}

/** What a source writes into the document. Every call is ordered by `seq`; the
 *  core owns the implementation, so a source never touches `DocState`. */
export interface Feed {
  /** Open a new epoch: everything the old one produced goes. */
  epoch(epoch: number, seq: number): void;
  /** Set (or, with `undefined`, drop) one header field. */
  meta(key: string, value: string | undefined, seq: number, bounds?: Rect): void;
  /** Replace the claimed lines (all of them, without `claims`). */
  replace(drafts: Draft[], seq: number, claims?: Claims): void;
  /** One rectangle that repainted, and when: the live detector's input. */
  dirty(d: Dirty, at: number): void;
  /** The regions the source itself knows are churning (a spinner row). */
  live(rects: Rect[]): void;
  /** Signals `from`..`to` will never arrive: recover from `snapshot()`. */
  gap(from: number, to: number): void;
  /** What the next version is pinned to (a frame ref, a stream offset). */
  ref(ref: string | null): void;
  /** The source cannot read any more; reported by `status()`. */
  offline(error: string): void;
  /** The source can read again. A source that recovers on its own (a screen
   *  lens started again after consent came back) says so here rather than
   *  leaving every bound consumer on a core that can never be live again. */
  online(): void;
}

export interface SourceSnapshot {
  epoch: number;
  seq: number;
  meta: Record<string, MetaField>;
  lines: Draft[];
  live?: Rect[];
  ref?: string | null;
}

export interface Source {
  /** Start reading; the returned function stops. */
  connect(user: number, target: string, feed: Feed): Promise<() => void>;
  /** Meta keys a change to which forces a keyframe (`app`, `session`). */
  keyframeOn?: string[];
  /** `false` for a source whose lines only ever scroll away (a terminal):
   *  the `-` lines would be noise, so deltas leave them out. */
  removals?: boolean;
  /** Meta keys that are a delivery on their own; the gate's default is `focus`. */
  ruleKeys?: string[];
  /** A full repaint, for gap recovery. A source without one stays incomplete. */
  snapshot?(): Promise<SourceSnapshot | null>;
}

export interface CoreDeps {
  clock: Clock;
  store: Store;
  source: Source;
  target: string;
  user: number;
  decider?: Decider;
  settings: () => LensSettings;
}

export interface LookResult {
  v: number;
  epoch: number;
  incomplete: boolean;
  meta?: Record<string, MetaField>;
  lines?: Line[];
  regions?: Region[];
  live?: Rect[];
  delivery?: Delivery;
}

export type WaitResult =
  | Delivery
  | { timeout: true; v: number; epoch: number }
  | { cancelled: true; v: number; epoch: number };

export interface CoreStatus {
  state: 'live' | 'offline';
  error: string | null;
  epoch: number;
  seq: number;
  v: number;
  lines: number;
  incomplete: boolean;
  embedding: boolean | null;
  waiters: number;
  consumers: { id: string; kind: ConsumerKind; cursor: number | null; delivered: string | null; watches: number }[];
}

export interface CoreEvents {
  delivery: (consumerId: string, delivery: Delivery) => void;
  /** A new frozen version. */
  scene: (v: number) => void;
  status: (status: CoreStatus) => void;
  /** Lines that only changed position: applied with no version bump and no
   *  event, so a highlight follows a scroll without a delivery. */
  moved: (lines: Line[]) => void;
}

interface Waiter {
  resolve: (value: WaitResult) => void;
  timer: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class LensCore {
  #deps: CoreDeps;
  #clock: Clock;
  #store: Store;
  #doc: DocState;
  #consumers = new Map<string, Consumer>();
  #waiters = new Map<string, Waiter>();
  #reports = new Map<string, WatchReport[]>();
  #forceKey = new Set<string>();
  #frames: { at: number; dirty: Dirty[] }[] = [];
  #timer: unknown = null;
  #firstBumpAt: number | null = null;
  #recovering = false;
  #settling = false;
  #recoverToken = 0;
  /** Feed calls buffered while a snapshot is in flight. */
  #queue: { seq: number; run: () => void }[] = [];
  /** Every feed call at or below this is already in the document (snapshot). */
  #boundary: number | null = null;
  /** An epoch was opened and nothing has published it yet. */
  #owedFlush = false;
  #flushQueued = false;
  #lastDescribeAt: number | null = null;
  #embedding: boolean | null = null;
  /** The live rectangles the source named, beside the ones the gate detected. */
  #sourceLive: Rect[] = [];
  #ref: string | null = null;
  #offline: string | null = null;
  #stop: (() => void) | null = null;
  #connected = false;
  #listeners: { [K in keyof CoreEvents]: Set<CoreEvents[K]> } = {
    delivery: new Set(),
    scene: new Set(),
    status: new Set(),
    moved: new Set(),
  };

  constructor(deps: CoreDeps) {
    this.#deps = deps;
    this.#clock = deps.clock;
    this.#store = deps.store;
    this.#doc = new DocState({ now: () => deps.clock.now() });
    for (const consumer of deps.store.loadConsumers()) this.#consumers.set(consumer.id, consumer);
  }

  /** Swap what judges a change, on the live core. The helper coming up (or
   *  going down) is no reason to rebuild a core and lose every cursor, so the
   *  stored watches are re-embedded and re-scored here instead: a `for` watch
   *  registered while nothing could embed it stops reading `unavailable` the
   *  moment something can. */
  async setDecider(decider?: Decider): Promise<void> {
    if (this.#deps.decider === decider) return;
    if (decider) this.#deps.decider = decider;
    else delete this.#deps.decider;
    for (const consumer of [...this.#consumers.values()]) {
      if (consumer.watches.length > 0) await this.watch(consumer.id);
    }
  }

  // ------------------------------------------------------------------- feed

  /** The one `Feed` the source writes through. Never throws at the source: a
   *  payload the document cannot apply drops the call, not the lens. */
  readonly feed: Feed = {
    // An epoch does not publish on its own: it would freeze an empty document
    // and hand it over before the source had said what it now is. It arms a
    // flush instead, which the writes that follow it in the same turn consume
    // — a `keyframeOn` header takes it synchronously, and anything else leaves
    // it to the end of the turn, so an epoch-opening source that writes no
    // such header still gets its keyframe, and either way one turn is one
    // version.
    epoch: (epoch, seq) =>
      this.#control(seq, true, () => {
        if (!this.#doc.epoch(epoch, seq)) return;
        this.#boundary = null;
        this.#frames.length = 0;
        this.#sourceLive = [];
        this.#ref = null;
        this.#owedFlush = true;
      }),

    meta: (key, value, seq, bounds) =>
      this.#control(seq, false, () => {
        const field: MetaField | undefined =
          value === undefined ? undefined : { value, ...(bounds === undefined ? {} : { bounds }) };
        if (!this.#doc.meta(key, field, seq)) return this.#armOwedFlush();
        if (this.#keyframeOn(key)) this.#flush();
        else {
          this.#bump();
          this.#armOwedFlush();
        }
      }),

    replace: (drafts, seq, claims) =>
      this.#control(seq, false, () => {
        const result = this.#doc.replace(drafts, seq, claims);
        if (result.changed === 'bump') this.#bump();
        else if (result.changed === 'moved' && result.moved.length > 0) {
          for (const fn of this.#listeners.moved) fn(result.moved);
        }
        this.#armOwedFlush();
      }),

    dirty: (d, at) => {
      const doc = this.#doc.current();
      doc.dirty = mergeDirty(doc.dirty, [d]);
      // One entry per instant: the live detector counts frames, not rectangles.
      const last = this.#frames.at(-1);
      if (last && last.at === at) last.dirty.push(d);
      else this.#frames.push({ at, dirty: [d] });
      const gate = this.#gate();
      // A purely visual change on an otherwise idle source opens the settle
      // window like a text change does.
      if (d.d >= gate.visualThreshold && outsideLive(this.#liveNow(gate), d.bbox)) this.#bump();
    },

    live: (rects) => {
      this.#sourceLive = rects;
    },

    // A second gap restarts recovery; the buffer still holds what arrived.
    gap: (from, to) => {
      void from;
      void to;
      this.#recover();
    },

    ref: (ref) => {
      this.#ref = ref;
    },

    offline: (error) => {
      this.#offline = error;
      this.#announce();
    },

    online: () => {
      if (this.#offline === null) return;
      this.#offline = null;
      this.#announce();
    },
  };

  #control(seq: number, opensEpoch: boolean, run: () => void): void {
    try {
      if (this.#recovering) {
        // An epoch change voids the old epoch, the in-flight snapshot included:
        // the epoch change publishes its own keyframe.
        if (opensEpoch) {
          this.#queue.length = 0;
          this.#recovering = false;
          this.#recoverToken += 1;
          run();
          return;
        }
        this.#queue.push({ seq, run });
        return;
      }
      // Already represented by the snapshot, for as long as this epoch lasts.
      if (!opensEpoch && this.#boundary !== null && seq <= this.#boundary) return;
      run();
    } catch {
      // A payload the document could not apply: the call is gone, the lens stays.
    }
  }

  #keyframeOn(key: string): boolean {
    return this.#deps.source.keyframeOn?.includes(key) ?? false;
  }

  // ------------------------------------------------------------------ state

  /** Returns an unsubscribe. */
  on<K extends keyof CoreEvents>(event: K, handler: CoreEvents[K]): () => void {
    const set = this.#listeners[event] as Set<CoreEvents[K]>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Start reading without becoming a consumer. Captions watch the document
   *  and acknowledge nothing, so a caption window is not something a cursor
   *  should be kept for — but it still needs the source to be running. */
  connect(): void {
    this.#connect();
  }

  doc(): Doc {
    return this.#doc.current();
  }

  version(v: number): Doc | undefined {
    return this.#doc.version(v);
  }

  status(): CoreStatus {
    const doc = this.#doc.current();
    return {
      state: this.#offline === null ? 'live' : 'offline',
      error: this.#offline,
      epoch: doc.epoch,
      seq: this.#doc.lastSeq(),
      v: doc.v,
      lines: doc.lines.length,
      incomplete: doc.incomplete,
      embedding: this.#embedding,
      waiters: this.#waiters.size,
      consumers: [...this.#consumers.values()].map((c) => ({
        id: c.id,
        kind: c.kind,
        cursor: c.cursor,
        delivered: c.delivered?.id ?? null,
        watches: c.watches.length,
      })),
    };
  }

  #announce(): void {
    const status = this.status();
    for (const fn of this.#listeners.status) fn(status);
  }

  // ------------------------------------------------------------ gate timing

  #bump(): void {
    if (this.#recovering) return; // deltas are stopped until the snapshot lands
    const now = this.#clock.now();
    if (this.#firstBumpAt === null) this.#firstBumpAt = now;
    this.#clock.clearTimeout(this.#timer);
    const capLeft = this.#firstBumpAt + SETTLE_CAP_MS - now;
    const wait = Math.max(0, Math.min(this.#settleMs(), capLeft));
    this.#timer = this.#hold(this.#clock.setTimeout(() => void this.#settleNow(), wait));
  }

  #settleMs(): number {
    const ms = this.#deps.settings().settleMs;
    return Number.isFinite(ms) && ms >= 0 ? ms : 750;
  }

  #clearSettle(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#firstBumpAt = null;
  }

  /** Timers must never hold the process open. */
  #hold(handle: unknown): unknown {
    (handle as { unref?: () => void } | null)?.unref?.();
    return handle;
  }

  #gate(): GateDeps {
    const settings = this.#deps.settings();
    const decider = this.#deps.decider;
    return gateDefaults({
      settleMs: this.#settleMs(),
      minLines: settings.minLines,
      seq: this.#doc.lastSeq(),
      // Which embedder is judging decides which calibration the thresholds come
      // from, and whether there is one at all.
      ...(decider?.embedderId ? { embedderId: decider.embedderId } : {}),
      ...(this.#deps.source.ruleKeys ? { ruleKeys: this.#deps.source.ruleKeys } : {}),
      ...(this.#deps.source.removals === false ? { removals: false } : {}),
      ...(decider?.embed ? { embed: decider.embed } : {}),
      ...(decider?.triage ? { triage: decider.triage } : {}),
      ...(decider?.describe ? { describe: decider.describe } : {}),
      ...(decider?.cloudTriage ? { cloudTriage: decider.cloudTriage } : {}),
    });
  }

  /** The end of an epoch's opening turn: whatever the source wrote after the
   *  epoch is published together, once, however many calls it took. */
  #armOwedFlush(): void {
    if (!this.#owedFlush || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      if (this.#owedFlush) this.#flush();
    });
  }

  /** A keyframe-forcing meta change: deliver now, ignoring `min_interval`. */
  #flush(): void {
    this.#owedFlush = false;
    this.#clearSettle();
    this.#freeze(this.#gate());
    for (const consumer of [...this.#consumers.values()]) {
      if (consumer.delivered !== null) continue; // an unclaimed delivery stands
      this.#produce(consumer);
    }
  }

  async #settleNow(): Promise<void> {
    this.#timer = null;
    this.#firstBumpAt = null;
    // A watch that is still thinking owns this round; the next bump re-arms.
    if (this.#settling) return this.#bump();
    this.#settling = true;
    try {
      const gate = this.#gate();
      const eligible = [...this.#consumers.values()].filter((c) => this.#eligible(c));
      await this.#describeRound(eligible, gate);
      const frozen = this.#freeze(gate);
      for (const consumer of eligible) {
        try {
          await this.#settleConsumer(consumer, frozen, gate);
        } catch {
          // One consumer's watch must never stop the others.
        }
      }
    } finally {
      this.#settling = false;
    }
  }

  /** Not mid-delivery and outside its own `min_interval`. */
  #eligible(consumer: Consumer): boolean {
    if (consumer.delivered !== null) return false;
    const now = this.#clock.now();
    return consumer.lastSentAt === null || now - consumer.lastSentAt >= consumer.minIntervalMs;
  }

  /** One describe per settle round, shared by every consumer: the largest
   *  visual candidate any eligible watch needs, no more often than the shortest
   *  `min_interval` among those consumers. The `Region` lands on the working
   *  copy before the freeze, so the frozen version carries it for everyone. */
  async #describeRound(eligible: Consumer[], gate: GateDeps): Promise<void> {
    const describe = this.#deps.decider?.describe;
    if (!describe) return;
    const current = this.#doc.current();
    const previous = this.#doc.version(current.v) ?? null;
    const cand = candidates(diffDocs(previous, current), this.#liveNow(gate), gate);
    if (cand.visual.length === 0) return;
    const needing = eligible.filter((c) => describeTarget([c], cand) !== null);
    const rect = describeTarget(needing, cand);
    const ref = this.#ref;
    if (!rect || !ref) return;
    const now = this.#clock.now();
    const interval = Math.min(...needing.map((c) => c.minIntervalMs));
    if (this.#lastDescribeAt !== null && now - this.#lastDescribeAt < interval) return;
    this.#lastDescribeAt = now;
    const epoch = current.epoch;
    const answer = await describe({ ref, rect, prompt: DESCRIBE_PROMPT, schema: DESCRIBE_SCHEMA, epoch });
    if ('error' in answer) return;
    const text = readDescription(answer.json);
    const doc = this.#doc.current();
    if (!text || doc.epoch !== epoch) return; // the answer describes something nobody is looking at
    // Interpreted text is a Region, never merged into `doc.lines`. A fresh
    // description of the same rectangle replaces the old one.
    doc.regions = [
      ...doc.regions.filter((r) => iou(r.bbox, rect) < 0.5),
      { bbox: rect, kind: 'visual' as const, interpreted: text, ref, v: doc.v + 1 },
    ].slice(-REGION_CAP);
  }

  async #settleConsumer(consumer: Consumer, frozen: Doc, gate: GateDeps): Promise<void> {
    if (!this.#eligible(consumer)) return; // a flush may have landed during the describe

    const diff = this.#doc.diff(consumer.cursor, frozen.v);
    const cand = candidates(diff, frozen.live, gate);
    if (cand.text.length === 0 && cand.visual.length === 0 && cand.meta.length === 0) return;
    if (!cand.rule && consumer.watches.length === 0) return;

    const decision = await evaluate(consumer, cand, frozen, gate);
    this.#reports.set(consumer.id, decision.watches);
    if (!decision.deliver) return;
    this.#produce(consumer);
  }

  /** Live regions as of now, trimming the frame history on the way so a region
   *  stops being live once its frames stop arriving. */
  #liveNow(gate: GateDeps): Rect[] {
    const cutoff = this.#clock.now() - FRAME_HISTORY_MS;
    while (this.#frames.length > 0 && (this.#frames[0] as { at: number }).at < cutoff) this.#frames.shift();
    return [...liveRegions(this.#frames, gate, this.#clock.now()), ...this.#sourceLive];
  }

  #freeze(gate?: GateDeps): Doc {
    const current = this.#doc.current();
    current.live = this.#liveNow(gate ?? this.#gate());
    const frozen = this.#doc.freeze(this.#ref);
    for (const fn of this.#listeners.scene) fn(frozen.v);
    return frozen;
  }

  /** The newest frozen version. A feed call never bumps `v`, so a read that
   *  arrives between settles freezes what it finds. */
  #frozen(): Doc {
    const current = this.#doc.current();
    return this.#doc.version(current.v) ?? this.#freeze();
  }

  // --------------------------------------------------------------- delivery

  #produce(consumer: Consumer): Delivery {
    const doc = this.#frozen();
    const exists = (v: number): boolean => this.#doc.version(v) !== undefined;
    const diff = this.#doc.diff(consumer.cursor, doc.v);
    const kind = nextKind(
      consumer,
      doc,
      exists,
      { epoch: diff.epoch, key: diff.metaChanged.some((key) => this.#keyframeOn(key)) },
      this.#forceKey.has(consumer.id)
    );

    let target = doc;
    let rendered;
    const since = kind.kind === 'delta' ? this.#doc.version(kind.since) : undefined;
    if (kind.kind === 'delta' && since) {
      rendered = renderDelta(doc, since, diff, consumer, { removals: this.#deps.source.removals });
    } else {
      target = (kind.kind === 'key' ? this.#doc.version(kind.v) : undefined) ?? doc;
      rendered = renderKeyframe(target, consumer, { page: kind.kind === 'key' ? kind.page : 1 });
    }

    const delivery = claimDelivery(consumer, rendered, target.v, target.epoch, target.ref, kind.kind === 'key' ? kind.reason : undefined);
    consumer.lastSentAt = this.#clock.now();
    this.#forceKey.delete(consumer.id);
    this.#store.saveConsumer(consumer);
    this.#store.appendEvent(consumer.id, delivery);
    this.#resolve(consumer.id, delivery);
    for (const fn of this.#listeners.delivery) fn(consumer.id, delivery);
    return delivery;
  }

  #resolve(consumerId: string, value: WaitResult): void {
    const waiter = this.#waiters.get(consumerId);
    if (!waiter) return;
    this.#waiters.delete(consumerId);
    this.#clock.clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(value);
  }

  // --------------------------------------------------------------- recovery

  #recover(): void {
    this.#clearSettle();
    const snapshot = this.#deps.source.snapshot;
    this.#doc.markIncomplete();
    if (!snapshot) {
      // No repaint to ask for: stay incomplete and keep going from what arrives
      // next, which is what an appended-only source does anyway.
      this.#flush();
      return;
    }
    this.#recovering = true;
    const token = ++this.#recoverToken;
    const land = (snap: SourceSnapshot | null): void => {
      if (token !== this.#recoverToken) return; // a newer gap owns recovery now
      this.#recovering = false;
      const queued = this.#queue;
      this.#queue = [];
      // An epoch change while the snapshot was in flight means it describes
      // something nobody is looking at, and that change made its own keyframe.
      const usable = snap !== null && snap.epoch === this.#doc.current().epoch;
      if (usable && snap) {
        this.#boundary = snap.seq;
        this.#doc.snapshot(snap);
        if (snap.ref !== undefined) this.#ref = snap.ref;
        for (const consumer of this.#consumers.values()) this.#forceKey.add(consumer.id);
      }
      for (const entry of queued) this.#control(entry.seq, false, entry.run);
      if (usable) this.#flush();
    };
    void Promise.resolve(snapshot.call(this.#deps.source)).then(land, () => land(null));
  }

  // -------------------------------------------------------------- consumers

  consumer(id: string, kind: ConsumerKind = 'conv'): Consumer {
    this.#connect();
    const found = this.#consumers.get(id);
    if (found) {
      found.seenAt = this.#clock.now();
      return found;
    }
    const consumer: Consumer = {
      id,
      kind,
      cursor: null,
      delivered: null,
      baseline: null,
      deltas: 0,
      minIntervalMs: 0,
      lastSentAt: null,
      seenAt: this.#clock.now(),
      nextDelivery: 0,
      watches: [],
    };
    this.#consumers.set(id, consumer);
    this.#store.saveConsumer(consumer);
    return consumer;
  }

  /** Take the document as it stands as this consumer's starting point, without
   *  delivering it: its next delivery is a delta of what changes AFTER this,
   *  not a keyframe of everything that was already there. A reader that shows
   *  the document itself (a monitor's connect baseline) seeds its cursor here,
   *  so the first change it is told about is the change. A consumer that has
   *  read anything, or is holding a delivery, is left exactly as it is —
   *  seeding it would move its cursor past what it has not seen. */
  seed(id: string): void {
    const consumer = this.consumer(id);
    if (consumer.cursor !== null || consumer.delivered !== null) return;
    const doc = this.#frozen();
    consumer.cursor = doc.v;
    consumer.baseline = { v: doc.v, complete: true };
    consumer.deltas = 0;
    this.#store.saveConsumer(consumer);
  }

  deleteConsumer(id: string): void {
    const doc = this.#doc.current();
    this.#resolve(id, { cancelled: true, v: doc.v, epoch: doc.epoch });
    this.#consumers.delete(id);
    this.#reports.delete(id);
    this.#forceKey.delete(id);
    this.#store.deleteConsumer(id);
  }

  consumerCount(): number {
    return this.#consumers.size;
  }

  /** Connects the source the first time anyone reads it. */
  #connect(): void {
    if (this.#connected) return;
    this.#connected = true;
    void this.#deps.source.connect(this.#deps.user, this.#deps.target, this.feed).then(
      (stop) => {
        this.#stop = stop;
      },
      (err: unknown) => {
        this.feed.offline(err instanceof Error ? err.message : String(err));
      }
    );
  }

  #ack(consumer: Consumer, id: string | undefined): void {
    if (!id) return;
    const applied = applyAck(consumer, id, (v) => this.#doc.version(v) !== undefined);
    if (applied === 'applied') this.#store.saveConsumer(consumer);
  }

  look(id: string, o: { ack?: string; fields?: string[]; offer?: boolean } = {}): LookResult {
    const consumer = this.consumer(id);
    this.#ack(consumer, o.ack);
    const doc = this.#frozen();
    const want = (field: string): boolean => o.fields === undefined || o.fields.includes(field);

    const out: LookResult = { v: doc.v, epoch: doc.epoch, incomplete: doc.incomplete };
    if (want('meta')) out.meta = doc.meta;
    if (want('text')) out.lines = doc.lines;
    if (want('regions')) out.regions = doc.regions;
    if (want('live')) out.live = doc.live;

    // Anything still unacknowledged is handed over again, re-rendered from the
    // unchanged cursor; a keyframe mid-paging hands over its next page. A reader
    // that only wants the document (`offer: false`) never claims one: a
    // re-render IS a delivery, counter, stored event, listeners and all.
    if (o.offer !== false && consumer.delivered !== null) out.delivery = this.#produce(consumer);
    return out;
  }

  wait(id: string, o: { ack?: string; timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult> {
    const consumer = this.consumer(id);
    this.#ack(consumer, o.ack);
    const doc = this.#doc.current();

    if (consumer.delivered !== null) return Promise.resolve(this.#produce(consumer));
    // One waiter per consumer: a second wait retires the first.
    this.#resolve(id, { cancelled: true, v: doc.v, epoch: doc.epoch });
    if (o.signal?.aborted) return Promise.resolve({ cancelled: true, v: doc.v, epoch: doc.epoch });

    return new Promise<WaitResult>((resolve) => {
      const timer = this.#hold(
        this.#clock.setTimeout(() => {
          const now = this.#doc.current();
          this.#resolve(id, { timeout: true, v: now.v, epoch: now.epoch });
        }, o.timeoutMs)
      );
      const waiter: Waiter = { resolve, timer };
      if (o.signal) {
        waiter.signal = o.signal;
        waiter.onAbort = (): void => {
          const now = this.#doc.current();
          this.#resolve(id, { cancelled: true, v: now.v, epoch: now.epoch });
        };
        o.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.set(id, waiter);
    });
  }

  waiterCount(): number {
    return this.#waiters.size;
  }

  /** One consumer's waiter, answered because its session went away. */
  settleConsumer(id: string): void {
    const doc = this.#doc.current();
    this.#resolve(id, { cancelled: true, v: doc.v, epoch: doc.epoch });
  }

  /** Shutdown: every waiter is answered, every timer dropped. */
  settle(): void {
    this.#clearSettle();
    const doc = this.#doc.current();
    for (const id of [...this.#waiters.keys()]) {
      this.#resolve(id, { cancelled: true, v: doc.v, epoch: doc.epoch });
    }
  }

  /** Shutdown plus the source: what `releaseLens` calls. */
  close(): void {
    this.settle();
    this.#stop?.();
    this.#stop = null;
  }

  /** What is embedding for this core, when it says: the id a calibration row is
   *  keyed by. */
  get embedderId(): string | undefined {
    return this.#deps.decider?.embedderId;
  }

  async watch(
    id: string,
    o: { add?: WatchSpec[]; remove?: string[]; minIntervalS?: number } = {}
  ): Promise<{
    watches: { id: string; mode: WatchMode; evaluation?: 'unavailable' | 'weak'; calibration?: 'missing' }[];
    /** Present when a `for` watch degraded because this embedder has never been
     *  measured here: the command that measures it. */
    calibrate?: string;
  }> {
    const consumer = this.consumer(id);
    if (o.minIntervalS !== undefined && Number.isFinite(o.minIntervalS)) {
      consumer.minIntervalMs = Math.max(0, Math.round(o.minIntervalS * 1000));
    }
    if (o.remove && o.remove.length > 0) {
      const gone = new Set(o.remove);
      consumer.watches = consumer.watches.filter((w) => !gone.has(w.id));
    }
    let next = nextWatchId(consumer.watches);
    for (const spec of o.add ?? []) {
      consumer.watches.push({ id: `${id}:w${next++}`, spec, mode: 'unavailable', createdAt: this.#clock.now() });
    }

    // `Watch.vector` is not persisted (it belongs to whichever model produced
    // it), so every call re-embeds whatever is missing one, in one batch.
    const embed = this.#deps.decider?.embed;
    const cal = calibration(this.#deps.decider?.embedderId);
    const pending = consumer.watches.filter((w) => w.spec.for && w.vector === undefined).slice(0, 32);
    if (pending.length > 0 && embed) {
      try {
        const vectors = await embed(pending.map((w) => watchText(w.spec.for ?? '', cal.score)));
        this.#embedding = vectors !== null;
        if (vectors) {
          for (const [index, watch] of pending.entries()) {
            const vector = vectors[index];
            if (Array.isArray(vector) && vector.length > 0) watch.vector = vector;
          }
        }
      } catch {
        this.#embedding = false;
      }
    } else if (pending.length > 0) {
      this.#embedding = false;
    }

    const caps = {
      triage: this.#deps.decider?.triage !== undefined,
      describe: this.#deps.decider?.describe !== undefined,
      cloud: this.#deps.decider?.cloudTriage !== undefined,
    };
    for (const watch of consumer.watches) {
      // A vector scored against another model's threshold is a guess: an
      // uncalibrated embedder counts as none (gate.ts `calibration`).
      watch.mode = watchMode(watch.spec, {
        ...caps,
        embed: (watch.vector?.length ?? 0) > 0 && !cal.missing,
      });
    }
    this.#store.saveWatches(id, consumer.watches);
    this.#store.saveConsumer(consumer);
    const degraded = cal.missing && consumer.watches.some((w) => w.spec.for);
    return {
      watches: consumer.watches.map((w) => {
        const evaluation = watchEvaluation(w.mode, caps);
        return {
          id: w.id,
          mode: w.mode,
          ...(evaluation ? { evaluation } : {}),
          ...(cal.missing && w.spec.for ? { calibration: 'missing' as const } : {}),
        };
      }),
      ...(degraded ? { calibrate: calibrateCommand(this.#deps.user) } : {}),
    };
  }

  /** The last evaluation's per-watch report. */
  reports(id: string): WatchReport[] {
    return this.#reports.get(id) ?? [];
  }

  /** What was already delivered to a consumer, without becoming one: a reader
   *  that only wants to SHOW recent deliveries (the ward card) must not create
   *  a consumer row or connect the source, which `consumer()` would. An id with
   *  no events answers []. */
  recent(id: string, limit: number): Delivery[] {
    return this.#store.events(id, undefined, limit);
  }

  history(id: string, o: { ack?: string; since?: number; limit: number }): Delivery[] {
    const consumer = this.consumer(id);
    this.#ack(consumer, o.ack);
    return this.#store.events(id, o.since, o.limit);
  }
}

/** `watches.id` is a primary key, so a watch id carries its consumer:
 *  `<consumer>:w<n>`, the same shape as a delivery id. */
function nextWatchId(watches: Watch[]): number {
  let max = 0;
  for (const watch of watches) {
    const n = Number.parseInt(watch.id.slice(watch.id.lastIndexOf('w') + 1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** A later rectangle joins the collected one it mostly overlaps (the union, the
 *  larger distance) and otherwise stands beside it. Lifted from BlackIce's
 *  scene.ts, where the working copy collected frames the same way. */
function mergeDirty(have: Dirty[], next: Dirty[]): Dirty[] {
  const out = [...have];
  for (const d of next) {
    const at = out.findIndex((o) => iou(o.bbox, d.bbox) >= 0.5);
    const o = at >= 0 ? out[at] : undefined;
    if (o) out[at] = { bbox: union(o.bbox, d.bbox), d: Math.max(o.d, d.d) };
    else out.push(d);
  }
  return out.slice(-DIRTY_CAP);
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

// -------------------------------------------------------------- the registry

/** One entry per source type, by the first half of a source id. A FACTORY, not
 *  a shared instance: `snapshot()` answers for one (user, target), so every
 *  core needs its own. */
export const SOURCES: Record<string, () => Source> = {};

const CORES = new Map<string, LensCore>();

/** The core for one `<type>:<target>`, created on first use. `null` when no
 *  source of that type is registered (the screen off the desktop app). */
export function lens(user: number, sourceId: string, settings?: () => LensSettings): LensCore | null {
  const at = sourceId.indexOf(':');
  const type = at < 0 ? sourceId : sourceId.slice(0, at);
  const target = at < 0 ? '' : sourceId.slice(at + 1);
  const make = SOURCES[type];
  if (!make) return null;
  const key = `${user}:${sourceId}`;
  let core = CORES.get(key);
  if (!core) {
    core = new LensCore({
      user,
      target,
      source: make(),
      clock: systemClock,
      store: sqliteStore(user, sourceId),
      settings: settings ?? ((): LensSettings => LENS_SETTINGS),
    });
    CORES.set(key, core);
  }
  return core;
}

/** The core for one `<type>:<target>` IF one is already running: a caller that
 *  only wants to drop a consumer must not build (and connect) a source to do it. */
export function peekLens(user: number, sourceId: string): LensCore | null {
  return CORES.get(`${user}:${sourceId}`) ?? null;
}

/** Stops the source and drops the core; the stored consumers stay. */
export function releaseLens(user: number, sourceId: string): void {
  const key = `${user}:${sourceId}`;
  const core = CORES.get(key);
  if (!core) return;
  CORES.delete(key);
  core.close();
}
