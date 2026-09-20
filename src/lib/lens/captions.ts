// Live translation captions: the Node half of the overlay. It watches the
// document for added text lines, batches them, asks for each batch to be
// translated and draws the result over the lines it came from. Lifted from
// BlackIce `src/lens/captions.ts` with `Scene` read as a `Doc` (`scene.text` is
// `doc.lines`, `scene.latest.ref` is `doc.ref`) and the settings pair read from
// the lens settings rows.
//
// Three rules shape everything here. It never blocks the gate: the `scene` and
// `moved` listeners do their grouping synchronously and fire the side effects
// off to the side, so a slow translator delays a caption and nothing else. It
// never paints something the user is no longer looking at: a reply is discarded
// when the epoch changed, the line was removed, the language pair changed or
// captions were turned off. And it never queues work: one batch is in flight
// and one is pending per caption window, latest wins.
//
// WHERE those three things happen is the deps' business, not this module's:
// `draw`, `clear` and `translate` are functions, so the screen lens draws on
// the native overlay above the user's screen and translates on the bundled
// helper (`screenCaptionSinks`, below — the same three desktop ops this module
// used to call itself), while a browser ward draws into its own page and
// translates through whatever that machine has (lens/browser.ts).
//
// It also owns the two overlay ops for lens/tools.ts (`show`, `clear`): this is
// the only Node module that draws, so the ops live in one place.

import { systemClock } from './core.ts';
import type { Clock, LensCore } from './core.ts';
import { lensSettings, setLensSettings } from './settings.ts';
import type { Doc, Line, Rect } from './types.ts';
import { nativeDesktop } from '../dev/remote.ts';

/** The helper answers a translate within this or the op fails `deadline`.
 *  Measured 2026-09-18 on the M5 Pro: a six-line batch of English sentences
 *  takes about 2.25 s (375 ms a line, serial per pair), a cold session 0.76 s. */
export const TRANSLATE_DEADLINE_MS = 6000;
/** Translates at the helper at once. The helper serialises calls on a pair
 *  (three concurrent six-line batches took 6.7 s, the sum), so a second one
 *  only waits inside the helper against its deadline. */
export const TRANSLATE_INFLIGHT = 1;
/** The first translate of a pair builds the session, which takes seconds on a
 *  cold helper; turning captions on sends one throwaway text with this much room. */
export const WARM_DEADLINE_MS = 15_000;
/** `busy`, `deadline`, `down` and `recovering` are the helper catching its
 *  breath, not a verdict on the batch: it goes again after this, doubling. */
export const RETRY_MS = 1000;
export const RETRY_MAX = 3;
const TRANSIENT = new Set(['busy', 'deadline', 'down', 'recovering']);
export const OVERLAY_DEADLINE_MS = 2000;
/** Lines per batch, and the vertical gap (in line heights) that ends one. */
export const BATCH_LINES = 6;
export const BATCH_GAP = 1.5;
/** Caption windows, `cap-0`..`cap-5`; the pool has 8 slots and cards want some. */
export const CAPTION_SLOTS = 6;
export const CAPTION_TTL_S = 20;
export const CACHE_CAP = 2000;
/** The hint the degraded table asks for when a pair is not installed. */
export const TRANSLATE_HINT = 'open the Translate app and download the pair';
/** Timings kept for `stats()`. */
const SAMPLES = 200;

export interface CaptionsState {
  on: boolean;
  from: string;
  to: string;
  state: 'off' | 'on' | 'unavailable';
  error?: string;
}

export interface CaptionsStats {
  batches: number;
  p50Ms: number;
  p95Ms: number;
}

type Desktop = (op: string, value?: unknown, deadlineMs?: number) => Promise<unknown>;

/** Only the caption pair; the rest of the lens settings are nothing to do with
 *  what is drawn. */
export interface CaptionPair {
  caption_from: string | null;
  caption_to: string | null;
}

/** One thing to draw, wherever this source draws. `text` is either plain text
 *  or the per-line JSON `{items:[{rect,text}]}` a caption batch renders as. */
export interface DrawReq {
  id: string;
  kind: 'card' | 'caption' | 'highlight';
  text: string;
  anchor: unknown;
  ttlMs: number;
  epoch: number;
}

/** One batch to translate. `epoch`/`seq` are the document's, which the helper
 *  uses to drop a reply whose window has ended; a translator with no notion of
 *  the screen ignores them. */
export interface TranslateReq {
  texts: string[];
  from: string;
  to: string;
  epoch: number;
  seq: number;
  /** The first call of a pair, which builds its session: slower, discarded. */
  warm?: true;
}

export interface CaptionsDeps {
  core: LensCore;
  /** The three side effects, one function each. */
  draw(req: DrawReq): Promise<unknown>;
  clear(id?: string): Promise<unknown>;
  translate(req: TranslateReq): Promise<{ texts: string[] } | { error: string }>;
  /** The language pairs this machine has installed, when it can say; absent
   *  (or null) leaves the pair to the stored one, then English into the system
   *  language. */
  pairs?(): Promise<string[][] | null>;
  clock: Clock;
  settings: () => CaptionPair;
  /** Stores the pair so the next toggle reuses it. Absent in tests. */
  saveSettings?: (patch: CaptionPair) => void;
  log?: (message: string) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Ref {
  id: string;
  key: string;
}

interface Job {
  /** The caption window: `cap-<n>`. */
  id: string;
  epoch: number;
  seq: number;
  from: string;
  to: string;
  /** The generation this job was made in; a pair change or an off bumps it. */
  token: number;
  /** When the document version these lines came from was published, for the
   *  end-to-end timing (BlackIce measured from the signal; a `Doc` is stamped
   *  when it freezes, so this is settle-to-drawn rather than signal-to-drawn). */
  at: number;
  lines: Ref[];
  /** A `moved` redraw carries its translations and never calls the helper. */
  texts?: (string | undefined)[];
  /** Retries so far after a transient helper answer. */
  attempt?: number;
}

interface Drawn {
  epoch: number;
  from: string;
  to: string;
  lines: Ref[];
  texts: (string | undefined)[];
}

export class Captions {
  #deps: CaptionsDeps;
  #clock: Clock;
  #core: LensCore;
  #on = false;
  #from: string | null;
  #to: string | null;
  #error: string | null = null;
  #token = 0;
  #next = 0;
  #epoch = 0;
  /** Line ids the current document already offered; the rest are new. */
  #seen = new Set<string>();
  #cache = new Map<string, string>();
  /** Translate jobs at the helper right now, at most `TRANSLATE_INFLIGHT`. */
  #running = 0;
  /** Batches waiting for the helper, oldest first, one per caption window. */
  #queue: Job[] = [];
  #drawn = new Map<string, Drawn>();
  #pairs: string[][] | null = null;
  #asked = false;
  #batches = 0;
  #samples: number[] = [];
  #off: (() => void)[] = [];
  #release: (() => void) | undefined;

  constructor(deps: CaptionsDeps) {
    this.#deps = deps;
    this.#clock = deps.clock;
    this.#core = deps.core;
    const settings = deps.settings();
    this.#from = settings.caption_from;
    this.#to = settings.caption_to;
    this.#off.push(
      deps.core.on('scene', (v) => this.#onScene(v)),
      deps.core.on('moved', (lines) => this.#onMoved(lines))
    );
  }

  /** Drops the subscriptions. Anything in flight still discards on reply. */
  close(): void {
    this.#release?.();
    this.#release = undefined;
    for (const off of this.#off) off();
    this.#off = [];
    this.#on = false;
    this.#token += 1;
  }

  state(): CaptionsState {
    return {
      on: this.#on,
      from: this.#from ?? 'en',
      to: this.#to ?? systemLanguage(),
      state: !this.#on ? 'off' : this.#error !== null ? 'unavailable' : 'on',
      ...(this.#error === null ? {} : { error: this.#error }),
    };
  }

  stats(): CaptionsStats {
    return {
      batches: this.#batches,
      p50Ms: percentile(this.#samples, 0.5),
      p95Ms: percentile(this.#samples, 0.95),
    };
  }

  /** The tool and the ward route. Turning captions on captions what is already
   *  on screen; turning them off clears the windows it drew. */
  async set(o: { on: boolean; from?: string; to?: string }): Promise<CaptionsState> {
    const pair = await this.#resolve(o.from, o.to);
    if (o.from !== undefined || o.to !== undefined) {
      this.#deps.saveSettings?.({ caption_from: pair.from, caption_to: pair.to });
    }
    // Anything in flight belongs to the old generation and will be discarded.
    this.#token += 1;
    this.#queue.length = 0;
    // A missing pack survives a toggle: the next call is how the caller learns
    // about it, so only a different pair (or a translation that works) clears
    // it. Anything else — a frame the ring had dropped, a helper that was busy
    // — is a moment's trouble, and turning captions on is the retry.
    const pack = this.#error !== null && /^(not-installed|unavailable)\b/.test(this.#error);
    if (pair.from !== this.#from || pair.to !== this.#to || (o.on && !pack)) this.#error = null;
    this.#from = pair.from;
    this.#to = pair.to;
    this.#on = o.on;
    this.#seen = new Set();
    const drawn = [...this.#drawn.keys()];
    this.#drawn.clear();
    if (!o.on) {
      this.#release?.();
      this.#release = undefined;
      for (const id of drawn) this.#fire('clear', this.#deps.clear(id));
    }
    else {
      // Nothing reads the screen for its own sake, so captions are the reason
      // the source runs while they are on.
      this.#release ??= this.#core.acquire().release;
      this.#core.connect();
      // Build the pair's session now, with room, so the first batches do not
      // all run into the deadline while the helper is still loading it.
      void this.#deps
        .translate({ texts: ['ok'], from: pair.from, to: pair.to, epoch: this.#core.doc().epoch, seq: 0, warm: true })
        .catch(() => {
          // The first real batch reports whatever this was.
        });
      this.#onDoc(this.#core.doc());
    }
    return this.state();
  }

  // ------------------------------------------------------------- overlay ops

  /** `overlay_show`: the receipt is the sink's (Rust's `{id, evicted?}` on a
   *  screen, the page layer's on a browser ward). */
  async show(req: {
    id: string;
    kind: 'card' | 'caption' | 'highlight';
    text?: string;
    anchor: unknown;
    ttlS: number;
  }): Promise<unknown> {
    return this.#deps.draw({
      id: req.id,
      kind: req.kind,
      text: req.text ?? '',
      anchor: req.anchor,
      ttlMs: req.ttlS * 1000,
      epoch: this.#core.doc().epoch,
    });
  }

  async clear(id?: string): Promise<unknown> {
    if (id !== undefined) this.#drawn.delete(id);
    else this.#drawn.clear();
    return this.#deps.clear(id);
  }

  // ----------------------------------------------------------------- batching

  #onScene(v: number): void {
    const doc = this.#core.version(v);
    if (doc) this.#onDoc(doc);
  }

  /** Synchronous by contract: the gate is mid-freeze when this runs. */
  #onDoc(doc: Doc): void {
    if (doc.epoch !== this.#epoch) {
      // A new window: every caption on screen described the old one.
      this.#epoch = doc.epoch;
      this.#seen = new Set();
      this.#drawn.clear();
    }
    if (!this.#on) return;
    // A line with no box cannot be drawn over (a terminal document has none).
    const placed = doc.lines.filter((line): line is Line & { bbox: Rect } => line.bbox !== undefined);
    const added = placed.filter((line) => !this.#seen.has(line.id) && line.key !== '');
    this.#seen = new Set(placed.map((line) => line.id));
    const from = this.#from;
    const to = this.#to;
    if (added.length === 0 || from === null || to === null) return;
    for (const group of batches(added)) {
      this.#submit({
        id: `cap-${this.#next++ % CAPTION_SLOTS}`,
        epoch: doc.epoch,
        seq: group.reduce((max, line) => Math.max(max, line.seq), 0),
        from,
        to,
        token: this.#token,
        at: doc.at,
        lines: group.map((line) => ({ id: line.id, key: line.key })),
      });
    }
  }

  /** Lines that only shifted: the translation still holds, so the windows that
   *  carry them are placed again with no helper call. */
  #onMoved(lines: Line[]): void {
    if (!this.#on || this.#drawn.size === 0) return;
    const moved = new Set(lines.map((line) => line.id));
    const from = this.#from;
    const to = this.#to;
    if (from === null || to === null) return;
    for (const [id, rec] of [...this.#drawn]) {
      if (rec.from !== from || rec.to !== to) continue;
      if (!rec.lines.some((line) => moved.has(line.id))) continue;
      this.#submit({
        id,
        epoch: rec.epoch,
        seq: 0,
        from,
        to,
        token: this.#token,
        at: this.#clock.now(),
        lines: rec.lines,
        texts: rec.texts,
      });
    }
  }

  /** Translates go to the helper one at a time in arrival order; a newer batch
   *  for a window that is still waiting replaces it, so the screen catches up
   *  instead of queueing. A redraw carries its translations and goes at once. */
  #submit(job: Job): void {
    if (job.texts !== undefined) {
      void this.#work(job);
      return;
    }
    const waiting = this.#queue.findIndex((queued) => queued.id === job.id);
    if (waiting !== -1) {
      this.#queue[waiting] = job;
      return;
    }
    if (this.#running >= TRANSLATE_INFLIGHT) {
      this.#queue.push(job);
      return;
    }
    void this.#work(job);
  }

  async #work(job: Job): Promise<void> {
    const translating = job.texts === undefined;
    if (translating) this.#running += 1;
    try {
      await this.#run(job);
    } catch (err) {
      this.#fail(err, job);
    } finally {
      if (translating) this.#running -= 1;
    }
    if (!translating) return;
    const next = this.#queue.shift();
    if (next) void this.#work(next);
  }

  async #run(job: Job): Promise<void> {
    const texts = job.texts ?? (await this.#translate(job));
    if (this.#stale(job)) return;
    await this.#draw(job, texts);
    if (job.texts === undefined) this.#error = null;
  }

  /** Cached lines never reach the helper; a batch that is entirely cached is
   *  drawn without an op at all. */
  async #translate(job: Job): Promise<(string | undefined)[]> {
    const wanted = job.lines.map((line) => line.key);
    const missing = [...new Set(wanted)].filter((key) => this.#get(this.#key(key, job)) === undefined);
    if (missing.length > 0) {
      // A refusal comes back as a value rather than a throw, so every
      // translator reports the same way; from here on it is the throw `#fail`
      // reads, exactly as the helper's rejection always was.
      const reply = await this.#deps.translate({
        texts: missing,
        from: job.from,
        to: job.to,
        epoch: job.epoch,
        seq: job.seq,
      });
      if ('error' in reply) throw new Error(reply.error);
      const out = reply.texts;
      if (!Array.isArray(out)) throw new Error('bad-reply');
      for (const [index, key] of missing.entries()) {
        const text = out[index];
        if (typeof text === 'string') this.#put(this.#key(key, job), text);
      }
    }
    return wanted.map((key) => this.#get(this.#key(key, job)));
  }

  /** Placement always uses the line's rectangle as it is now, not as it was
   *  when the batch was made: a scroll during a translate moves the caption. */
  async #draw(job: Job, texts: (string | undefined)[]): Promise<void> {
    const doc = this.#core.doc();
    const ref = doc.ref;
    if (!ref) return; // nothing captured yet: no frame to anchor against
    const now = new Map(doc.lines.map((line) => [line.id, line]));
    const items: { rect: Rect; text: string }[] = [];
    const lines: Ref[] = [];
    const kept: string[] = [];
    for (const [index, line] of job.lines.entries()) {
      const current = now.get(line.id);
      const text = texts[index];
      // Removed, rewritten or untranslated.
      if (!current || current.bbox === undefined || current.key !== line.key || text === undefined) continue;
      items.push({ rect: current.bbox, text });
      lines.push(line);
      kept.push(text);
    }
    if (items.length === 0) return;
    await this.#deps.draw({
      id: job.id,
      kind: 'caption',
      anchor: { rect: union(items.map((item) => item.rect)), ref },
      text: JSON.stringify({ items }),
      ttlMs: CAPTION_TTL_S * 1000,
      epoch: job.epoch,
    });
    this.#drawn.set(job.id, { epoch: job.epoch, from: job.from, to: job.to, lines, texts: kept });
    if (job.texts !== undefined) return; // a redraw is not a batch
    this.#batches += 1;
    this.#sample(this.#clock.now() - job.at);
  }

  #stale(job: Job): boolean {
    return !this.#on || job.token !== this.#token || job.epoch !== this.#core.doc().epoch;
  }

  #fail(err: unknown, job: Job): void {
    const said = message(err);
    const attempt = job.attempt ?? 0;
    if (TRANSIENT.has(said) && attempt < RETRY_MAX && !this.#stale(job)) {
      this.#deps.log?.(`captions: ${said}, retry ${attempt + 1} of ${RETRY_MAX}`);
      this.#clock.setTimeout(() => {
        if (!this.#stale(job)) this.#submit({ ...job, attempt: attempt + 1 });
      }, RETRY_MS * 2 ** attempt);
      return;
    }
    // The pair is what the user has to install, so it belongs in the message.
    this.#error = said === 'not-installed' || said === 'unavailable' ? `${said} ${job.from}->${job.to}` : said;
    this.#deps.log?.(`captions: ${this.#error}`);
  }

  /** A side effect whose reply nobody waits for. A rejection is logged, never
   *  thrown: an unhandled one would take the runtime down. */
  #fire(what: string, run: Promise<unknown>): void {
    run.catch((err: unknown) => {
      this.#deps.log?.(`captions: ${what} failed: ${message(err)}`);
    });
  }

  // -------------------------------------------------------------- the pair

  /** Explicit wins, then the stored pair, then what the helper has installed,
   *  then English into whatever language the machine is set to. */
  async #resolve(from?: string, to?: string): Promise<{ from: string; to: string }> {
    const settings = this.#deps.settings();
    let f = from ?? settings.caption_from ?? this.#from;
    let t = to ?? settings.caption_to ?? this.#to;
    if (f === null || t === null) {
      const pair = await this.#helperPair();
      f = f ?? pair?.[0] ?? 'en';
      t = t ?? pair?.[1] ?? systemLanguage();
    }
    return { from: f, to: t };
  }

  async #helperPair(): Promise<string[] | null> {
    if (!this.#asked) {
      this.#asked = true;
      try {
        this.#pairs = (await this.#deps.pairs?.()) ?? null;
      } catch {
        this.#pairs = null; // nothing to ask: the defaults answer
      }
    }
    const first = this.#pairs?.[0];
    return first && typeof first[0] === 'string' && typeof first[1] === 'string' ? first : null;
  }

  // -------------------------------------------------------------- the cache

  #key(key: string, job: Job): string {
    return `${key}|${job.from}|${job.to}`;
  }

  #get(key: string): string | undefined {
    const value = this.#cache.get(key);
    if (value === undefined) return undefined;
    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value;
  }

  #put(key: string, value: string): void {
    this.#cache.delete(key);
    this.#cache.set(key, value);
    while (this.#cache.size > CACHE_CAP) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
  }

  #sample(ms: number): void {
    this.#samples.push(Math.max(0, ms));
    if (this.#samples.length > SAMPLES) this.#samples.shift();
  }
}

/** Added lines in reading order, cut into windows of at most six vertically
 *  adjacent lines. A gap wider than 1.5 line heights starts a new window, so a
 *  caption never spans two unrelated blocks of text. */
export function batches<T extends { bbox: Rect }>(lines: T[]): T[][] {
  const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const out: T[][] = [];
  let group: T[] = [];
  let previous: T | null = null;
  for (const line of sorted) {
    const gap = previous === null ? 0 : line.bbox[1] - (previous.bbox[1] + previous.bbox[3]);
    const height = previous === null ? 0 : previous.bbox[3];
    if (group.length === BATCH_LINES || (previous !== null && gap > BATCH_GAP * height)) {
      out.push(group);
      group = [];
    }
    group.push(line);
    previous = line;
  }
  if (group.length > 0) out.push(group);
  return out;
}

export function union(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]);
    y1 = Math.max(y1, r[1] + r[3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Nearest-rank percentile, rounded; an empty sample is 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[at] ?? 0);
}

export function systemLanguage(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] || 'en';
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------- the screen sinks

/** The screen lens's three side effects: the desktop ops this module used to
 *  call itself, byte for byte. `desktop` is a seam for the tests alone. */
export function screenCaptionSinks(
  desktop: Desktop = (op, value, deadlineMs) => nativeDesktop(op, value, deadlineMs)
): Pick<CaptionsDeps, 'draw' | 'clear' | 'translate' | 'pairs'> {
  return {
    draw: (req) => desktop('overlay-show', req, OVERLAY_DEADLINE_MS),
    clear: (id) => desktop('overlay-clear', id === undefined ? {} : { id }, OVERLAY_DEADLINE_MS),
    translate: async (req) => {
      try {
        const reply = (await desktop(
          'helper-translate',
          { epoch: req.epoch, seq: req.seq, source: req.from, target: req.to, texts: req.texts },
          req.warm === true ? WARM_DEADLINE_MS : TRANSLATE_DEADLINE_MS
        )) as { texts?: unknown } | null;
        return Array.isArray(reply?.texts) ? { texts: reply.texts as string[] } : { error: 'bad-reply' };
      } catch (err) {
        return { error: message(err) };
      }
    },
    pairs: async () => {
      const reply = (await desktop('helper-capabilities', {}, TRANSLATE_DEADLINE_MS)) as { translation?: unknown } | null;
      const pairs = reply?.translation;
      return Array.isArray(pairs) ? pairs.filter((p): p is string[] => Array.isArray(p)) : null;
    },
  };
}

// ------------------------------------------------------------- the instance

/** One `Captions` per core — a core is one source, so the sinks a caller passes
 *  are that source's. Whoever gets here first builds it: the screen's ward
 *  route and the tools pass none and get the screen sinks; lens/tools.ts passes
 *  a browser ward's. Tests seed the map by passing their own deps first. */
const INSTANCES = new WeakMap<LensCore, Captions>();

export function captionsFor(core: LensCore, deps?: Partial<CaptionsDeps>): Captions {
  let captions = INSTANCES.get(core);
  if (!captions) {
    captions = new Captions({
      core,
      ...screenCaptionSinks(),
      clock: systemClock,
      settings: lensSettings,
      saveSettings: (patch) => void setLensSettings({ ...patch }),
      ...deps,
    });
    INSTANCES.set(core, captions);
  }
  return captions;
}
