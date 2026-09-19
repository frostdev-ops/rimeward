// Delivery bookkeeping that has to survive a restart: who is consuming, what
// they have acknowledged, what they are watching, and the events already
// rendered. The core takes a `Store` by injection; `sqliteStore()` is the only
// implementation. Lifted from BlackIce src/lens/store.ts, scoped to one
// (user, source) pair: every statement carries both, so two users watching the
// same source — or one user watching two — never see each other's rows.

import type { Consumer, ConsumerKind, Delivered, Delivery, Watch, WatchMode, WatchSpec } from './types.ts';
import { CONSUMER_KINDS } from './types.ts';
import { getDb } from '../db.ts';

/** Newest events kept, per (user, source). */
export const EVENT_CAP = 2000;

export interface Store {
  loadConsumers(): Consumer[];
  saveConsumer(consumer: Consumer): void;
  deleteConsumer(id: string): void;
  /** Replaces every watch the consumer has. */
  saveWatches(consumerId: string, watches: Watch[]): void;
  appendEvent(consumerId: string, delivery: Delivery): void;
  events(consumerId: string, since?: number, limit?: number): Delivery[];
}

interface ConsumerRow {
  id: string;
  kind: string;
  cursor: number;
  delivered_id: string | null;
  delivered_v: number | null;
  delivered_page: number | null;
  delivered_truncated: number;
  delivered_kind: string | null;
  delivered_pages: number | null;
  delivered_pending_page: number | null;
  baseline_v: number | null;
  baseline_complete: number;
  deltas: number;
  min_interval_ms: number;
  last_sent_at: number | null;
  seen_at: number | null;
  next_delivery: number;
}

interface WatchRow {
  id: string;
  consumer_id: string;
  spec_json: string;
  mode: string;
  created_at: number;
}

interface EventRow {
  consumer_id: string;
  delivery_id: string;
  v: number;
  since: number | null;
  key: string | null;
  page: number | string;
  truncated: number;
  text: string;
  at: number;
  epoch: number;
  ref: string | null;
}

export function sqliteStore(userId: number, source: string, now: () => number = Date.now): Store {
  const db = getDb();
  const scope = { user: userId, source };

  const selectConsumers = db.prepare(
    'SELECT * FROM lens_consumers WHERE user_id = @user AND source = @source ORDER BY id'
  );
  const selectWatches = db.prepare(
    'SELECT * FROM lens_watches WHERE user_id = @user AND source = @source ORDER BY created_at, id'
  );
  const upsertConsumer = db.prepare(
    `INSERT INTO lens_consumers (user_id, source, id, kind, cursor, delivered_id, delivered_v, delivered_page,
       delivered_truncated, delivered_kind, delivered_pages, delivered_pending_page,
       baseline_v, baseline_complete, deltas, min_interval_ms, last_sent_at, seen_at, next_delivery)
     VALUES (@user, @source, @id, @kind, @cursor, @delivered_id, @delivered_v, @delivered_page,
       @delivered_truncated, @delivered_kind, @delivered_pages, @delivered_pending_page,
       @baseline_v, @baseline_complete,
       @deltas, @min_interval_ms, @last_sent_at, @seen_at, @next_delivery)
     ON CONFLICT(user_id, source, id) DO UPDATE SET
       kind = excluded.kind, cursor = excluded.cursor,
       delivered_id = excluded.delivered_id, delivered_v = excluded.delivered_v,
       delivered_page = excluded.delivered_page, delivered_truncated = excluded.delivered_truncated,
       delivered_kind = excluded.delivered_kind, delivered_pages = excluded.delivered_pages,
       delivered_pending_page = excluded.delivered_pending_page,
       baseline_v = excluded.baseline_v, baseline_complete = excluded.baseline_complete,
       deltas = excluded.deltas, min_interval_ms = excluded.min_interval_ms,
       last_sent_at = excluded.last_sent_at, seen_at = excluded.seen_at,
       next_delivery = excluded.next_delivery`
  );
  const dropConsumer = db.prepare(
    'DELETE FROM lens_consumers WHERE user_id = @user AND source = @source AND id = @id'
  );
  const dropWatches = db.prepare(
    'DELETE FROM lens_watches WHERE user_id = @user AND source = @source AND consumer_id = @id'
  );
  const insertWatch = db.prepare(
    `INSERT INTO lens_watches (user_id, source, id, consumer_id, spec_json, mode, created_at)
     VALUES (@user, @source, @id, @consumer_id, @spec_json, @mode, @created_at)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO lens_events (user_id, source, consumer_id, delivery_id, v, since, key, page, truncated, text, at, epoch, ref)
     VALUES (@user, @source, @consumer_id, @delivery_id, @v, @since, @key, @page, @truncated, @text, @at, @epoch, @ref)`
  );
  const trimEvents = db.prepare(
    `DELETE FROM lens_events WHERE user_id = @user AND source = @source AND id NOT IN
       (SELECT id FROM lens_events WHERE user_id = @user AND source = @source ORDER BY id DESC LIMIT @cap)`
  );
  const selectEvents = db.prepare(
    `SELECT * FROM lens_events WHERE user_id = @user AND source = @source AND consumer_id = @id
       AND (@since IS NULL OR v > @since)
     ORDER BY id DESC LIMIT @limit`
  );

  const writeWatches = db.transaction((consumerId: string, watches: Watch[]) => {
    dropWatches.run({ ...scope, id: consumerId });
    for (const watch of watches) {
      // The embedding vector is not persisted: it belongs to whichever model
      // produced it, and the core re-embeds `for` on load.
      insertWatch.run({
        ...scope,
        id: watch.id,
        consumer_id: consumerId,
        spec_json: JSON.stringify(watch.spec),
        mode: watch.mode,
        created_at: watch.createdAt,
      });
    }
  });

  const writeEvent = db.transaction((row: EventRow) => {
    insertEvent.run({ ...scope, ...row });
    trimEvents.run({ ...scope, cap: EVENT_CAP });
  });

  return {
    loadConsumers(): Consumer[] {
      const watches = new Map<string, Watch[]>();
      for (const row of selectWatches.all(scope) as WatchRow[]) {
        const spec = parseSpec(row.spec_json);
        if (!spec) continue; // a hand-edited row must not take the lens down
        const group = watches.get(row.consumer_id);
        const watch: Watch = { id: row.id, spec, mode: row.mode as WatchMode, createdAt: row.created_at };
        if (group) group.push(watch);
        else watches.set(row.consumer_id, [watch]);
      }
      return (selectConsumers.all(scope) as ConsumerRow[]).map((row) => ({
        id: row.id,
        kind: readKind(row.kind),
        // Versions start at 1, so the column's 0 default is "nothing acked".
        cursor: row.cursor === 0 ? null : row.cursor,
        delivered: readDelivered(row),
        baseline: row.baseline_v === null ? null : { v: row.baseline_v, complete: row.baseline_complete === 1 },
        deltas: row.deltas,
        minIntervalMs: row.min_interval_ms,
        lastSentAt: row.last_sent_at,
        seenAt: row.seen_at,
        nextDelivery: row.next_delivery,
        watches: watches.get(row.id) ?? [],
      }));
    },

    saveConsumer(consumer: Consumer): void {
      upsertConsumer.run({
        ...scope,
        id: consumer.id,
        kind: consumer.kind,
        cursor: consumer.cursor ?? 0,
        delivered_id: consumer.delivered?.id ?? null,
        delivered_v: consumer.delivered?.v ?? null,
        delivered_page: consumer.delivered?.page ?? null,
        delivered_truncated: consumer.delivered?.truncated ? 1 : 0,
        delivered_kind: consumer.delivered?.kind ?? null,
        delivered_pages: consumer.delivered?.pages ?? null,
        delivered_pending_page: consumer.delivered?.pendingPage ?? null,
        baseline_v: consumer.baseline?.v ?? null,
        baseline_complete: consumer.baseline?.complete ? 1 : 0,
        deltas: consumer.deltas,
        min_interval_ms: consumer.minIntervalMs,
        last_sent_at: consumer.lastSentAt,
        seen_at: consumer.seenAt,
        next_delivery: consumer.nextDelivery,
      });
    },

    deleteConsumer(id: string): void {
      dropConsumer.run({ ...scope, id }); // watches and events cascade
    },

    saveWatches(consumerId: string, watches: Watch[]): void {
      writeWatches(consumerId, watches);
    },

    appendEvent(consumerId: string, delivery: Delivery): void {
      writeEvent({
        consumer_id: consumerId,
        delivery_id: delivery.delivery,
        v: delivery.v,
        since: delivery.since,
        key: delivery.kind,
        // "1/3" has no integer affinity, so SQLite keeps it as text; an
        // unpaged delivery stores the plain 1 the column was declared for.
        page: delivery.page ?? 1,
        truncated: delivery.truncated ? 1 : 0,
        text: delivery.text,
        at: now(),
        epoch: delivery.epoch,
        ref: delivery.ref,
      });
    },

    events(consumerId: string, since?: number, limit = 100): Delivery[] {
      const rows = selectEvents.all({ ...scope, id: consumerId, since: since ?? null, limit }) as EventRow[];
      return rows.reverse().map((row) => ({
        delivery: row.delivery_id,
        v: row.v,
        since: row.since,
        epoch: row.epoch,
        ref: row.ref,
        kind: row.key === 'key' ? 'key' : 'delta',
        ...(typeof row.page === 'string' ? { page: row.page } : {}),
        ...(row.truncated === 1 ? { truncated: true } : {}),
        text: row.text,
      }));
    },
  };
}

function readKind(value: string): ConsumerKind {
  return (CONSUMER_KINDS as readonly string[]).includes(value) ? (value as ConsumerKind) : 'conv';
}

function readDelivered(row: ConsumerRow): Delivered | null {
  if (row.delivered_id === null || row.delivered_v === null) return null;
  return {
    id: row.delivered_id,
    v: row.delivered_v,
    kind: row.delivered_kind === 'key' ? 'key' : 'delta',
    page: row.delivered_page ?? 1,
    pages: row.delivered_pages ?? 1,
    truncated: row.delivered_truncated === 1,
    ...(row.delivered_pending_page === null ? {} : { pendingPage: row.delivered_pending_page }),
  };
}

function parseSpec(json: string): WatchSpec | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') return null;
    return value as WatchSpec;
  } catch {
    return null;
  }
}

/** One stored watch, as the Lens watches list draws it: the source and consumer
 *  are the (user, source, consumer) it was added under, never inferrable from
 *  the id alone once the consumer that made it is gone. */
export interface StoredWatch {
  source: string;
  consumer: string;
  id: string;
  spec: WatchSpec;
  mode: WatchMode;
  createdAt: number;
}

/** Every watch this user has, across every source — what `/api/lens/watches`
 *  lists. Read straight from the table: building a core per source to ask it
 *  would connect each source behind the question. */
export function allWatches(userId: number): StoredWatch[] {
  const rows = getDb()
    .prepare('SELECT * FROM lens_watches WHERE user_id = ? ORDER BY source, created_at, id')
    .all(userId) as (WatchRow & { source: string })[];
  const out: StoredWatch[] = [];
  for (const row of rows) {
    const spec = parseSpec(row.spec_json);
    if (!spec) continue; // a hand-edited row shows as nothing, never as a crash
    out.push({
      source: row.source,
      consumer: row.consumer_id,
      id: row.id,
      spec,
      mode: row.mode as WatchMode,
      createdAt: row.created_at,
    });
  }
  return out;
}

/** Removes one watch when no core is live to remove it in memory (the usual
 *  case for a consumer whose source has not been read since a restart).
 *  False = no such row. */
export function deleteWatch(userId: number, source: string, consumerId: string, id: string): boolean {
  const done = getDb()
    .prepare('DELETE FROM lens_watches WHERE user_id = ? AND source = ? AND consumer_id = ? AND id = ?')
    .run(userId, source, consumerId, id);
  return done.changes > 0;
}
