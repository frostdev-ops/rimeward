// The `node --test`-facing wrapper around `src/lib/lens/replay.ts`: a
// `LensCore` on a `FakeClock`, the real SQLite store with no consumers loaded,
// and one of two sources — the screen-shaped fixture source below, or the real
// `terminalSource` on fake dev-runtime deps. The parser and the step runner
// live in `src/lib/lens/replay.ts`.
//
// `import './_setup.ts'` must still come first in the test file; this module
// touches the DB as soon as a replay runs.
//
// The screen source here is TEST-ONLY and minimal: it turns BlackIce's wire
// signals into `Feed` calls so the fourteen lifted fixtures keep pinning the
// core's behaviour. The real one lands in `src/lib/lens/screen.ts` (phase B2).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from './fake-clock.ts';
import { LensCore } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source, SourceSnapshot } from '../src/lib/lens/core.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { parseFixtureFile, runSteps } from '../src/lib/lens/replay.ts';
import type { ReplayCtx, ReplayReport, Step } from '../src/lib/lens/replay.ts';
import { terminalSource } from '../src/lib/lens/terminal.ts';
import type { TerminalDeps } from '../src/lib/lens/terminal.ts';
import type { Draft } from '../src/lib/lens/doc.ts';
import type { Delivery, Line, MetaField, Rect } from '../src/lib/lens/types.ts';
import type { RuntimeEvent } from '../src/lib/dev/types.ts';
import { createUser } from '../src/lib/users.ts';

export const FIXTURES = fileURLToPath(new URL('./fixtures/lens/', import.meta.url));

/** 2025-09-17T16:00:00Z: signals stamped from this clock carry realistic `at`. */
export const REPLAY_EPOCH_MS = 1_758_120_000_000;

export interface ReplayOptions {
  settleMs?: number;
  minLines?: number;
}

const DIMS = 128;

/** One user per replay, so two fixtures never share a consumer row. */
let users = 0;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const q = (s: string): string => JSON.stringify(s);
const box = (r: Rect): string => `${Math.round(r[0])},${Math.round(r[1])},${Math.round(r[2])},${Math.round(r[3])}`;
const rect = (v: unknown): Rect | undefined => {
  const values = arr(v);
  return values.length === 4 ? (values.map((n) => num(n)) as Rect) : undefined;
};

/** A deterministic stand-in for a real embedder: hashed character trigrams,
 *  L2-normalised. It orders paraphrases above unrelated text well enough for a
 *  fixture to exercise the `for` path without a model, and its scale is its own
 *  — a fixture that relies on it sets `threshold` explicitly. */
export function trigramVector(text: string): number[] {
  const out = new Array<number>(DIMS).fill(0);
  const normalised = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  for (let i = 0; i + 3 <= normalised.length; i++) {
    let hash = 2166136261;
    for (const code of normalised.slice(i, i + 3)) {
      hash ^= code.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const slot = (hash >>> 0) % DIMS;
    out[slot] = (out[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(out.reduce((n, x) => n + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

// ------------------------------------------------------- the screen fixture

interface Replies {
  take(op: string): unknown;
}

/** A line whose bbox the replacement claims: it covers at least half that
 *  line's height and touches it horizontally. BlackIce's `overlaps`. */
function claims(area: Rect): (line: Line) => boolean {
  return (line: Line): boolean => {
    const b = line.bbox;
    if (!b) return false;
    const y = Math.min(b[1] + b[3], area[1] + area[3]) - Math.max(b[1], area[1]);
    const x = Math.min(b[0] + b[2], area[0] + area[2]) - Math.max(b[0], area[0]);
    return x > 0 && y >= b[3] / 2;
  };
}

function wireDrafts(lines: unknown, src: 'ax' | 'ocr'): Draft[] {
  return arr(lines).map((raw) => {
    const line = (raw ?? {}) as { bbox?: unknown; text?: unknown; conf?: unknown };
    return {
      text: str(line.text),
      src,
      bbox: rect(line.bbox) ?? [0, 0, 0, 0],
      conf: src === 'ax' ? 1 : num(line.conf, 1),
    };
  });
}

/** The screen's own header strings, byte for byte what BlackIce's renderer
 *  produced, so the lifted fixtures' text assertions still hold. */
function headMeta(body: Record<string, unknown>): { key: string; value: string; bounds?: Rect }[] {
  const kind = str(body.kind);
  if (kind === 'app') {
    return [{ key: 'app', value: `${str(body.bundle)} ${q(str(body.name))} pid=${num(body.pid)}` }];
  }
  const bounds = rect(body.bounds) ?? [0, 0, 0, 0];
  const url = str(body.url);
  const display = (body.display ?? null) as { id?: unknown; w?: unknown; h?: unknown; scale?: unknown } | null;
  // The display travels with the window (only a window change moves it), so it
  // rides that one field rather than a second one nothing ever asks about. The
  // bounds are the field's, which the renderer prints after the value.
  const tail = display ? ` display=${num(display.id)} ${num(display.w)}x${num(display.h)} @${num(display.scale)}` : '';
  return [
    { key: 'window', value: `${num(body.id)} ${q(str(body.title))}${url ? ` url=${url}` : ''}${tail}`, bounds },
  ];
}

function focusValue(body: { role?: unknown; label?: unknown; value?: unknown }): string {
  return `${str(body.role)} ${q(str(body.label))} value=${q(str(body.value))}`;
}

/** Turns a fixture's wire signal into `Feed` calls, reproducing the epoch and
 *  staleness rules BlackIce's `SceneState.apply` enforced. */
function screenSource(replies: Replies, now: () => number): Source & { attach(feed: Feed): void; inject(body: Record<string, unknown>): void } {
  let feed: Feed | null = null;
  let epoch = 0;

  return {
    keyframeOn: ['app', 'window', 'sheet'],
    attach(f: Feed): void {
      feed = f;
    },
    async connect(_user: number, _target: string, f: Feed): Promise<() => void> {
      feed = f;
      return () => {};
    },
    inject(body: Record<string, unknown>): void {
      if (!feed) return;
      const kind = str(body.kind);
      const e = num(body.epoch);
      const seq = num(body.seq);
      const at = num(body.at, now());

      if (kind === 'app' || kind === 'window') {
        if (e < epoch) return;
        if (e > epoch) {
          epoch = e;
          feed.epoch(e, seq);
        }
        for (const field of headMeta(body)) feed.meta(field.key, field.value, seq, field.bounds);
        return;
      }
      // Everything else from another epoch describes a window nobody is looking at.
      if (e !== epoch) return;

      switch (kind) {
        case 'ax-focus':
        case 'ax-value':
          feed.meta('focus', focusValue(body), seq, rect(body.bounds));
          return;
        case 'ax-sheet':
          feed.meta('sheet', q(str(body.title)), seq, rect(body.bounds));
          return;
        case 'ax-text':
          feed.replace(wireDrafts(body.lines, 'ax'), seq, claims(rect(body.rect) ?? [0, 0, 0, 0]));
          return;
        case 'ocr':
          // An `axCovered` OCR read a rect the AX tree already owns: its lines
          // are empty by design and it removes nothing.
          if (body.axCovered === true) return;
          feed.replace(wireDrafts(body.lines, 'ocr'), seq, claims(rect(body.rect) ?? [0, 0, 0, 0]));
          return;
        case 'frame': {
          feed.ref(str(body.ref) || null);
          for (const raw of arr(body.dirty)) {
            const d = (raw ?? {}) as { bbox?: unknown; d?: unknown };
            const bbox = rect(d.bbox);
            if (bbox) feed.dirty({ bbox, d: num(d.d) }, at);
          }
          return;
        }
        case 'gap':
          feed.gap(num(body.from), num(body.to));
          return;
        default:
          return; // status, helper and overlay are not part of the document
      }
    },
    async snapshot(): Promise<SourceSnapshot | null> {
      const value = replies.take('lens-snapshot');
      if (!value || typeof value !== 'object') return null;
      const snap = value as Record<string, unknown>;
      const meta: Record<string, MetaField> = {};
      const app = snap.app as Record<string, unknown> | null;
      if (app) meta.app = { value: `${str(app.bundle)} ${q(str(app.name))} pid=${num(app.pid)}` };
      const window = snap.window as Record<string, unknown> | null;
      if (window) {
        for (const field of headMeta({ kind: 'window', ...window })) {
          meta[field.key] = { value: field.value, ...(field.bounds ? { bounds: field.bounds } : {}) };
        }
      }
      const focus = snap.focus as Record<string, unknown> | null;
      if (focus) meta.focus = { value: focusValue(focus), ...(rect(focus.bounds) ? { bounds: rect(focus.bounds) as Rect } : {}) };
      const sheet = snap.sheet as Record<string, unknown> | null;
      if (sheet) {
        meta.sheet = { value: q(str(sheet.title)), ...(rect(sheet.bounds) ? { bounds: rect(sheet.bounds) as Rect } : {}) };
      }
      const latest = snap.latest as { ref?: unknown } | null;
      epoch = num(snap.epoch);
      return {
        epoch,
        seq: num(snap.seq),
        meta,
        lines: [...wireDrafts(snap.axText, 'ax'), ...wireDrafts(snap.ocr, 'ocr')],
        live: Array.isArray(snap.live) ? (snap.live as Rect[]) : [],
        ref: latest ? str(latest.ref) || null : null,
      };
    },
  };
}

// ----------------------------------------------------- the terminal fixture

const TERMINAL_TARGET = 's1';

/** The dev runtime a terminal fixture stands in for: one session, whatever rows
 *  the last `term` step painted, and the stream every event rides. */
export function terminalFixture(now: () => number): { deps: TerminalDeps; inject(body: Record<string, unknown>): void } {
  const session = {
    id: TERMINAL_TARGET,
    project: 'p',
    kind: 'claude',
    state: 'running',
    exitCode: null as number | null,
    cols: 80,
    rows: 24,
    title: 'claude',
  };
  let lines: string[] = [];
  let wrapped: boolean[] = [];
  let scrolled = 0;
  let lost = 0;
  let sequence = 0;
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const emit = (event: RuntimeEvent): void => {
    for (const fn of [...listeners]) fn(event);
  };

  const deps = {
    subscribe: ((_user: number, fn: (event: RuntimeEvent) => void) => {
      listeners.add(fn);
      fn({ sequence, type: 'reset', id: '' });
      return (): void => {
        listeners.delete(fn);
      };
    }) as unknown as TerminalDeps['subscribe'],
    rendered: ((_user: number, _id: string) => ({ lines, wrapped, scrolled, lost })) as TerminalDeps['rendered'],
    read: ((_user: number, _id: string) => ({ session: { ...session } })) as unknown as TerminalDeps['read'],
    now,
  };

  return {
    deps,
    inject(body: Record<string, unknown>): void {
      sequence = num(body.seq, sequence + 1);
      if (body.reset === true) return emit({ sequence, type: 'reset', id: '' });
      const next = body.session as Record<string, unknown> | undefined;
      if (next) {
        if (next.state !== undefined) session.state = str(next.state);
        if (next.exitCode !== undefined) session.exitCode = next.exitCode === null ? null : num(next.exitCode);
        if (next.cols !== undefined) session.cols = num(next.cols);
        if (next.rows !== undefined) session.rows = num(next.rows);
        if (next.kind !== undefined) session.kind = str(next.kind);
        emit({
          sequence,
          type: 'session',
          id: TERMINAL_TARGET,
          data: { state: session.state, exitCode: session.exitCode, cols: session.cols, rows: session.rows },
        });
        return;
      }
      lines = arr(body.rows).map((row) => str(row));
      wrapped = arr(body.wrapped).length === lines.length ? arr(body.wrapped).map((w) => w === true) : lines.map(() => false);
      scrolled = num(body.scrolled, scrolled);
      lost = num(body.lost);
      // Nobody is listening until the first consumer connects: the rows above
      // are simply what the session already shows when it does.
      if (listeners.size > 0) emit({ sequence, type: 'output', id: TERMINAL_TARGET, data: { sequence } });
    },
  };
}

// ------------------------------------------------------------- the harness

export function replay(fixturePath: string, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const file = path.isAbsolute(fixturePath) ? fixturePath : path.join(FIXTURES, fixturePath);
  const steps: Step[] = parseFixtureFile(file);
  const clock = new FakeClock(REPLAY_EPOCH_MS);
  const queued = new Map<string, unknown[]>();
  const deliveries = new Map<string, Delivery[]>();
  const user = createUser(`replay-${++users}@example.com`, 'pw-replay-12345');

  const replies: Replies = {
    take(op: string): unknown {
      const queue = queued.get(op);
      return queue && queue.length > 0 ? queue.shift() : undefined;
    },
  };
  /** The scripted decider: a fixture answers triage and describe with a
   *  `reply` step, and an unscripted call is an error the gate survives. */
  const scripted = async <T>(op: string, _value: unknown): Promise<T | { error: string }> => {
    const value = replies.take(op);
    return value === undefined ? { error: `no scripted reply for ${op}` } : (value as T);
  };

  const terminal = steps.some((step) => step.body.type === 'term');
  const fixture = terminal ? terminalFixture(() => clock.now()) : null;
  const screen = terminal ? null : screenSource(replies, () => clock.now());
  const source = fixture ? terminalSource(fixture.deps) : (screen as Source);
  const sourceId = terminal ? `terminal:${TERMINAL_TARGET}` : `screen:${path.basename(file)}`;

  const store = sqliteStore(user, sourceId, () => clock.now());
  const core = new LensCore({
    user,
    target: terminal ? TERMINAL_TARGET : 'local',
    source,
    clock,
    store: { ...store, loadConsumers: () => [] },
    settings: (): LensSettings => ({ settleMs: opts.settleMs ?? 750, minLines: opts.minLines ?? 1 }),
    decider: {
      embed: async (texts) => texts.map(trigramVector),
      triage: (q2) => scripted<{ yes: boolean }>('helper-triage', q2),
      describe: (q2) => scripted<{ json: unknown }>('helper-describe', q2),
    },
  });
  screen?.attach(core.feed);
  core.on('delivery', (id, delivery) => {
    const list = deliveries.get(id);
    if (list) list.push(delivery);
    else deliveries.set(id, [delivery]);
  });

  // A macrotask boundary drains the whole microtask queue; two of them cover a
  // settle that hands off to an async decider and then renders.
  const drain = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  const ctx: ReplayCtx = {
    core,
    now: () => clock.now(),
    advance: async (ms) => {
      clock.advance(ms);
      await drain();
    },
    drain,
    inject: (body) => {
      if (fixture) fixture.inject(body);
      else screen?.inject(body);
    },
    reply: (op, value) => {
      const queue = queued.get(op);
      if (queue) queue.push(value);
      else queued.set(op, [value]);
    },
    deliveries,
  };

  return runSteps(steps, ctx).finally(() => core.close());
}
