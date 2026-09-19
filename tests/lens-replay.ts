// The `node --test`-facing wrapper around `src/lib/lens/replay.ts`: a
// `LensCore` on a `FakeClock`, the real SQLite store with no consumers loaded,
// and one of the two real sources — `screenSource` on scripted native replies,
// or `terminalSource` on fake dev-runtime deps. The parser and the step runner
// live in `src/lib/lens/replay.ts`.
//
// `import './_setup.ts'` must still come first in the test file; this module
// touches the DB as soon as a replay runs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from './fake-clock.ts';
import { LensCore } from '../src/lib/lens/core.ts';
import type { LensSettings, Source } from '../src/lib/lens/core.ts';
import { sqliteStore } from '../src/lib/lens/store.ts';
import { parseFixtureFile, runSteps } from '../src/lib/lens/replay.ts';
import type { ReplayCtx, ReplayReport, Step } from '../src/lib/lens/replay.ts';
import { terminalSource } from '../src/lib/lens/terminal.ts';
import type { TerminalDeps } from '../src/lib/lens/terminal.ts';
import { screenSource } from '../src/lib/lens/screen.ts';
import { browserSource } from '../src/lib/lens/browser.ts';
import type { BrowserDeps, PageRead } from '../src/lib/lens/browser.ts';
import type { Delivery } from '../src/lib/lens/types.ts';
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

/** The real screen source (src/lib/lens/screen.ts) on scripted native replies:
 *  a fixture's `lens` step is one pushed wire signal, and `lens-snapshot` is a
 *  `reply` step like any other native call. */
function screenFixture(
  replies: Replies,
  now: () => number
): { source: Source; inject(body: Record<string, unknown>): void } {
  let push: ((signal: Record<string, unknown>) => void) | null = null;
  const source = screenSource({
    desktop: async (op: string) => {
      const value = replies.take(op);
      if (value === undefined) throw new Error(`no scripted reply for ${op}`);
      return value;
    },
    attach: (fn) => {
      push = fn;
      return (): void => {
        push = null;
      };
    },
    now,
  });
  return {
    source,
    inject(body: Record<string, unknown>): void {
      push?.(body);
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

// ------------------------------------------------------ the browser fixture

const BROWSER_TARGET = 'w1';

/** The page a browser fixture stands in for. A `page` step sets what the tab
 *  now shows; the real `browserSource` pulls it on its own poll, so the read
 *  answers null until something changed, exactly as the page-side reader does.
 *  A step that changes the url is a NEW DOCUMENT: the reader is gone with it,
 *  which is what `fresh` means. */
export function browserFixture(clock: FakeClock): { deps: BrowserDeps; inject(body: Record<string, unknown>): void } {
  let url = 'https://pages.test/start';
  let title = 'Start';
  let nodes: PageRead['nodes'] = [];
  let changed: PageRead['nodes'][number]['rect'][] = [];
  let dirty = false;
  let fresh = true;

  const rects = (value: unknown): PageRead['nodes'][number]['rect'][] =>
    arr(value)
      .map((raw) => arr(raw).map((n) => num(n)))
      .filter((r) => r.length === 4) as PageRead['nodes'][number]['rect'][];

  return {
    deps: {
      clock,
      read: async (_user, _ward, force): Promise<PageRead | null> => {
        if (!fresh && !dirty && !force) return null;
        const read: PageRead = { url, title, fresh, nodes: [...nodes], changed: [...changed] };
        fresh = false;
        dirty = false;
        changed = [];
        return read;
      },
    },
    inject(body: Record<string, unknown>): void {
      if (typeof body.url === 'string' && body.url !== url) {
        url = body.url;
        fresh = true;
      }
      if (typeof body.title === 'string') title = body.title;
      if (Array.isArray(body.nodes)) {
        nodes = arr(body.nodes).map((raw) => {
          const node = (raw ?? {}) as { text?: unknown; rect?: unknown };
          return { text: str(node.text), rect: (rects([node.rect])[0] ?? [0, 0, 0, 0]) };
        });
      }
      changed = [...changed, ...rects(body.changed)];
      dirty = true;
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
  const browser = !terminal && steps.some((step) => step.body.type === 'page');
  const fixture = terminal ? terminalFixture(() => clock.now()) : null;
  const web = browser ? browserFixture(clock) : null;
  const screen = terminal || browser ? null : screenFixture(replies, () => clock.now());
  const source = fixture
    ? terminalSource(fixture.deps)
    : web
      ? browserSource(web.deps)
      : (screen as { source: Source }).source;
  const sourceId = terminal
    ? `terminal:${TERMINAL_TARGET}`
    : browser
      ? `browser:${BROWSER_TARGET}`
      : `screen:${path.basename(file)}`;

  const store = sqliteStore(user, sourceId, () => clock.now());
  const core = new LensCore({
    user,
    target: terminal ? TERMINAL_TARGET : browser ? BROWSER_TARGET : 'local',
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
  // Nothing has read this core yet, so the source is not connected: the fixtures
  // start pushing signals straight away, as the real lens does.
  if (screen) void source.connect(user, 'local', core.feed);
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
      else if (web) web.inject(body);
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
