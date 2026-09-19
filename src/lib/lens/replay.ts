// Fixture replay: parse a `tests/fixtures/lens/*.jsonl` script and run it
// against a `LensCore`. Nothing here imports from `tests/` — the harness in
// `tests/lens-replay.ts` supplies the fake clock, the store, the source that
// interprets a `source` step and the scripted decider a `reply` step feeds.
//
// A fixture is JSON Lines. Blank lines and `//` lines are skipped; every other
// line is one step object keyed by `type`. See `tests/fixtures/lens/README.md`.
//
// Lifted from BlackIce src/lens/replay.ts: its `lens` step (a screen wire
// signal) is now an opaque `source` step the harness's own source reads (`term`
// is the same step for a terminal fixture), and its `desktop` step is a `reply`
// for the scripted decider.

import { readFileSync } from 'node:fs';
import type { LensCore } from './core.ts';
import type { ConsumerKind, Delivery, WatchSpec } from './types.ts';

export interface Step {
  /** 1-based line in the fixture, quoted back by every failure. */
  line: number;
  body: Record<string, unknown>;
}

export interface Failure {
  line: number;
  expect: string;
  actual: string;
}

export interface WaitRecord {
  line: number;
  consumer: string;
  /** `pending` until the promise settles. */
  result: 'pending' | 'delivery' | 'timeout' | 'cancelled';
  delivery?: string;
}

export interface ReplayReport {
  steps: number;
  failures: Failure[];
  deliveries: Map<string, Delivery[]>;
  elapsedMs: number;
  waits: WaitRecord[];
  /** Lines that kept their id and changed their bbox, over the whole run. */
  moved: number;
  /** Fixture time: the sum of every `tick`, for per-minute rates. */
  clockMs: number;
}

/** Everything the runner needs that a fixture cannot provide itself. */
export interface ReplayCtx {
  core: LensCore;
  now(): number;
  /** Advance the clock, then let the queued async work land. */
  advance(ms: number): Promise<void>;
  /** Let the queued async work land without moving the clock. */
  drain(): Promise<void>;
  /** Hand one `source` step to the harness's source, which reads its shape. */
  inject(body: Record<string, unknown>): void;
  /** Queue a reply for the next decider call of that name. */
  reply(op: string, value: unknown): void;
  /** Filled by the core's `delivery` event, oldest first. */
  deliveries: Map<string, Delivery[]>;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The fixtures name a consumer the way BlackIce did; these are the kinds the
 *  lens store keeps. A BlackIce `mcp` consumer is an MCP host reading raw text
 *  — our `cli` door — not the Rime conversation, whose deliveries are budgeted
 *  for JSON (`deliveryCap`): the lifted page counts are the raw-text ones. */
const KINDS: Record<string, ConsumerKind> = { mcp: 'cli', feed: 'monitor', conv: 'conv', cli: 'cli', monitor: 'monitor', edge: 'edge' };

export function parseFixture(text: string): Step[] {
  const steps: Step[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    let body: unknown;
    try {
      body = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`fixture line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`fixture line ${index + 1}: every step is a JSON object`);
    }
    steps.push({ line: index + 1, body: body as Record<string, unknown> });
  }
  return steps;
}

export function parseFixtureFile(path: string): Step[] {
  return parseFixture(readFileSync(path, 'utf8'));
}

export async function runSteps(steps: Step[], ctx: ReplayCtx): Promise<ReplayReport> {
  const startedAt = Date.now();
  const failures: Failure[] = [];
  const waits: WaitRecord[] = [];
  // Modes as the consumer step reported them; `unavailable` shows up here.
  const modes = new Map<string, { id: string; mode: string; evaluation?: string }[]>();
  let moved = 0;
  let ran = 0;
  let clockMs = 0;

  const list = (id: string): Delivery[] => ctx.deliveries.get(id) ?? [];
  const lastOf = (id: string): Delivery | undefined => list(id).at(-1);
  /** `consumer` may be left out only while one consumer exists. */
  const newest = (): Delivery | undefined =>
    ctx.deliveries.size === 1 ? [...ctx.deliveries.values()][0]?.at(-1) : undefined;
  const boxes = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of ctx.core.doc().lines) out.set(line.id, (line.bbox ?? []).join(','));
    return out;
  };
  const fail = (line: number, expect: string, actual: unknown): void => {
    failures.push({ line, expect, actual: typeof actual === 'string' ? actual : JSON.stringify(actual) });
  };

  for (const step of steps) {
    const { line, body } = step;
    ran += 1;
    switch (str(body.type)) {
      case 'note':
        break;

      case 'source':
      case 'term': {
        const before = boxes();
        ctx.inject(body);
        for (const [id, box] of boxes()) {
          const was = before.get(id);
          if (was !== undefined && was !== box) moved += 1;
        }
        // No drain: a feed call is synchronous apart from gap recovery, and a
        // fixture that wants the snapshot to land asks for it with `tick`.
        break;
      }

      case 'tick': {
        const ms = num(body.ms);
        clockMs += ms;
        await ctx.advance(ms);
        break;
      }

      case 'consumer': {
        const id = str(body.id);
        ctx.core.consumer(id, KINDS[str(body.kind, 'mcp')] ?? 'conv');
        const add = arr(body.watches) as WatchSpec[];
        if (add.length > 0 || body.minIntervalS !== undefined) {
          const report = await ctx.core.watch(id, {
            ...(add.length > 0 ? { add } : {}),
            ...(body.minIntervalS === undefined ? {} : { minIntervalS: num(body.minIntervalS) }),
          });
          modes.set(id, report.watches);
        }
        await ctx.drain();
        break;
      }

      case 'ack': {
        const id = str(body.consumer);
        const want = str(body.id, 'last');
        const ackId = want === 'last' ? lastOf(id)?.delivery : want;
        // `history` acknowledges without producing, so acking a keyframe page
        // does not hand the next page over before the fixture asks for it.
        if (ackId) ctx.core.history(id, { ack: ackId, limit: 1 });
        await ctx.drain();
        break;
      }

      case 'wait': {
        const id = str(body.consumer);
        const record: WaitRecord = { line, consumer: id, result: 'pending' };
        waits.push(record);
        void ctx.core.wait(id, { timeoutMs: num(body.timeoutMs, 30_000) }).then((result) => {
          if ('timeout' in result) record.result = 'timeout';
          else if ('cancelled' in result) record.result = 'cancelled';
          else {
            record.result = 'delivery';
            record.delivery = result.delivery;
          }
        });
        await ctx.drain();
        break;
      }

      case 'reply':
        ctx.reply(str(body.op), body.reply);
        break;

      case 'expect':
        check(line, body);
        break;

      default:
        fail(line, 'a known step type', str(body.type, '(missing)'));
    }
  }

  return { steps: ran, failures, deliveries: ctx.deliveries, elapsedMs: Date.now() - startedAt, waits, moved, clockMs };

  // ------------------------------------------------------------- assertions

  function pick(body: Record<string, unknown>): Delivery | undefined {
    return body.consumer === undefined ? newest() : lastOf(str(body.consumer));
  }

  function pages(delivery: Delivery): { page: number; pages: number } {
    const [page, total] = (delivery.page ?? '1/1').split('/');
    return { page: num(Number(page), 1), pages: num(Number(total), 1) };
  }

  function check(line: number, body: Record<string, unknown>): void {
    const verb = str(body.expect);
    switch (verb) {
      case 'deliveries': {
        const id = str(body.consumer);
        const n = list(id).length;
        if (body.count !== undefined && n !== num(body.count)) fail(line, `deliveries ${id} = ${num(body.count)}`, n);
        if (body.atMost !== undefined && n > num(body.atMost)) fail(line, `deliveries ${id} <= ${num(body.atMost)}`, n);
        if (body.atLeast !== undefined && n < num(body.atLeast)) fail(line, `deliveries ${id} >= ${num(body.atLeast)}`, n);
        return;
      }

      case 'lines': {
        const delivery = pick(body);
        if (!delivery) return fail(line, `a delivery for ${str(body.consumer)}`, 'none');
        const rows = delivery.text.split('\n');
        const plus = rows.filter((r) => r.startsWith('+ ')).length;
        const minus = rows.filter((r) => r.startsWith('- ')).length;
        const same = rows.filter((r) => r.startsWith('= ')).length;
        if (body.plus !== undefined && plus !== num(body.plus)) fail(line, `+ lines = ${num(body.plus)}`, plus);
        if (body.minus !== undefined && minus !== num(body.minus)) fail(line, `- lines = ${num(body.minus)}`, minus);
        if (body.same !== undefined && same !== num(body.same)) fail(line, `= lines = ${num(body.same)}`, same);
        return;
      }

      case 'moved':
        if (moved !== num(body.count)) fail(line, `moved lines = ${num(body.count)}`, moved);
        return;

      case 'incomplete': {
        const value = ctx.core.doc().incomplete;
        if (value !== body.value) fail(line, `incomplete = ${String(body.value)}`, value);
        return;
      }

      case 'keyframe': {
        const delivery = pick(body);
        if (!delivery) return fail(line, `a keyframe for ${str(body.consumer)}`, 'no delivery');
        if (delivery.kind !== 'key') return fail(line, 'kind = key', delivery.kind);
        const at = pages(delivery);
        if (body.pages !== undefined && at.pages !== num(body.pages)) fail(line, `pages = ${num(body.pages)}`, at.pages);
        if (body.page !== undefined && at.page !== num(body.page)) fail(line, `page = ${num(body.page)}`, at.page);
        return;
      }

      case 'delta': {
        const delivery = pick(body);
        if (!delivery) return fail(line, `a delta for ${str(body.consumer)}`, 'no delivery');
        if (delivery.kind !== 'delta') return fail(line, 'kind = delta', delivery.kind);
        if (body.since !== undefined && delivery.since !== num(body.since)) {
          fail(line, `since = ${num(body.since)}`, delivery.since);
        }
        return;
      }

      case 'truncated': {
        const delivery = pick(body);
        if (!delivery) return fail(line, `a delivery for ${str(body.consumer)}`, 'none');
        const value = delivery.truncated === true;
        if (value !== body.value) fail(line, `truncated = ${String(body.value)}`, value);
        return;
      }

      case 'text':
      case 'notContains': {
        const delivery = pick(body);
        if (!delivery) return fail(line, `a delivery for ${str(body.consumer)}`, 'none');
        const wanted = verb === 'text' ? arr(body.contains) : [];
        const unwanted = verb === 'text' ? arr(body.notContains) : arr(body.contains ?? body.notContains);
        for (const needle of wanted) {
          if (!delivery.text.includes(str(needle))) fail(line, `text contains ${JSON.stringify(needle)}`, delivery.text);
        }
        for (const needle of unwanted) {
          if (delivery.text.includes(str(needle))) fail(line, `text omits ${JSON.stringify(needle)}`, delivery.text);
        }
        return;
      }

      case 'epoch': {
        const value = ctx.core.doc().epoch;
        if (value !== num(body.value)) fail(line, `epoch = ${num(body.value)}`, value);
        return;
      }

      case 'watch': {
        const id = str(body.consumer);
        const watchId = str(body.id);
        const found = (modes.get(id) ?? []).find((w) => w.id === watchId);
        if (!found) return fail(line, `a watch ${watchId}`, JSON.stringify(modes.get(id) ?? []));
        if (body.mode !== undefined && found.mode !== str(body.mode)) fail(line, `mode = ${str(body.mode)}`, found.mode);
        if (body.evaluation !== undefined) {
          const report = ctx.core.reports(id).find((r) => r.id === watchId);
          const value = report?.evaluation ?? found.evaluation ?? null;
          if (value !== body.evaluation) fail(line, `evaluation = ${String(body.evaluation)}`, value);
        }
        if (body.hit !== undefined) {
          const report = ctx.core.reports(id).find((r) => r.id === watchId);
          if ((report?.hit ?? false) !== body.hit) fail(line, `hit = ${String(body.hit)}`, report?.hit ?? null);
        }
        return;
      }

      case 'scene.lines': {
        const value = ctx.core.doc().lines.length;
        if (value !== num(body.count)) fail(line, `document lines = ${num(body.count)}`, value);
        return;
      }

      case 'scene.text': {
        const value = ctx.core.doc().lines.map((l) => l.text);
        const wanted = arr(body.contains).map((t) => str(t));
        for (const needle of wanted) if (!value.includes(needle)) fail(line, `the document has ${JSON.stringify(needle)}`, value);
        for (const needle of arr(body.notContains).map((t) => str(t))) {
          if (value.includes(needle)) fail(line, `the document omits ${JSON.stringify(needle)}`, value);
        }
        return;
      }

      case 'meta': {
        const meta = ctx.core.doc().meta;
        const key = str(body.key);
        const value = meta[key]?.value ?? null;
        if (body.value !== undefined && value !== body.value) fail(line, `meta ${key} = ${String(body.value)}`, value);
        if (body.contains !== undefined && !(value ?? '').includes(str(body.contains))) {
          fail(line, `meta ${key} contains ${JSON.stringify(body.contains)}`, value);
        }
        return;
      }

      case 'live': {
        const value = ctx.core.doc().live.length;
        if (body.count !== undefined && value !== num(body.count)) fail(line, `live regions = ${num(body.count)}`, value);
        if (body.atLeast !== undefined && value < num(body.atLeast)) fail(line, `live regions >= ${num(body.atLeast)}`, value);
        return;
      }

      case 'version': {
        const value = ctx.core.doc().v;
        if (body.value !== undefined && value !== num(body.value)) fail(line, `version = ${num(body.value)}`, value);
        if (body.atLeast !== undefined && value < num(body.atLeast)) fail(line, `version >= ${num(body.atLeast)}`, value);
        return;
      }

      case 'cursor': {
        const found = ctx.core.status().consumers.find((c) => c.id === str(body.consumer));
        const value = found?.cursor ?? null;
        if (value !== (body.value ?? null)) fail(line, `cursor = ${String(body.value)}`, value);
        return;
      }

      case 'delivered': {
        const id = str(body.consumer);
        const found = ctx.core.status().consumers.find((c) => c.id === id);
        const value = found?.delivered ?? null;
        const want = body.value === 'last' ? (lastOf(id)?.delivery ?? null) : (body.value ?? null);
        if (value !== want) fail(line, `delivered = ${String(want)}`, value);
        return;
      }

      case 'wait': {
        const id = str(body.consumer);
        const record = [...waits].reverse().find((w) => w.consumer === id);
        if (!record) return fail(line, `a wait for ${id}`, 'none');
        if (record.result !== str(body.result)) fail(line, `wait ${id} = ${str(body.result)}`, record.result);
        return;
      }

      default:
        fail(line, 'a known expect verb', verb || '(missing)');
    }
  }
}
