/**
 * Store: insert V4 signals into atlas.signals and enqueue the freshly
 * inserted ones into atlas.signal_queue, through the Supabase client
 * (service_role). The atlas schema and tables are defined by
 * supabase/migrations/20261025100000_atlas_core.sql and the queue functions
 * by 20261025100100_atlas_queues.sql — this package runs no SQL migrations of
 * its own.
 *
 * supabase-js has no transaction API, so the steps are separate PostgREST
 * calls:
 *
 *   step 1  upsert into atlas.signals (`on_conflict=source,source_id`,
 *           ignoreDuplicates) and read back ONLY signal_id — a signal that is
 *           already present yields no id and is NOT re-enqueued, so a
 *           completed signal survives later re-runs untouched;
 *   step 2  upsert an atlas.signal_queue row (max_attempts 3, on_conflict =
 *           signal_id, ignoreDuplicates) for exactly the ids step 1 returned;
 *   step 3  stamp enqueued_at on those ids (update ... in, no read-back) —
 *           the marker the sweep reads.
 *
 * A run that fails or crashes between the steps is healed by the next run:
 * runScoutOnce opens every run with sweepUnqueued, which selects recent
 * signals still missing the stamp (enqueued_at null, created_at within the
 * lookback), re-runs step 2 for them — the ignoreDuplicates upsert cannot
 * double a queue row that already landed — and stamps them. A finished
 * signal has no queue row left but keeps its enqueued_at, so the sweep never
 * touches it. Step 1 stays idempotent across re-runs and inserts nothing
 * twice.
 */
import type { Signal } from '@myboon/contracts';

/** The part of a PostgREST error this package relies on (message only; never a URL or key). */
export interface AtlasDbError {
  message: string;
}

/** The `{ data, error }` result of an awaited PostgREST call. */
export interface AtlasDbResult<Row> {
  data: Row | null;
  error: AtlasDbError | null;
}

/**
 * The atlas table slice: one interface for both tables this package writes.
 * `upsert` with full signal rows targets atlas.signals and chains `.select()`
 * to read back the inserted signal_ids; `upsert` with queue rows targets
 * atlas.signal_queue and resolves without a read-back. The overload picks
 * which, so no call site can mix the two row shapes. `update` (enqueue
 * stamp) and the sweep `select` chain target atlas.signals only.
 */
export interface AtlasTable {
  upsert(
    rows: readonly Signal[],
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): AtlasUpsertBuilder<{ signal_id: string }>;
  upsert(
    rows: readonly AtlasQueueRow[],
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): PromiseLike<AtlasDbResult<null>>;
  /** `.update({ enqueued_at: <iso> })` on atlas.signals — always filtered and awaited, no read-back. */
  update(values: { enqueued_at: string }): AtlasUpdateBuilder;
  /** The sweep read on atlas.signals; asks for signal_id only. */
  select(columns: 'signal_id'): AtlasSweepSelect;
}

/** Builder for a signals-table upsert: awaitable as-is, and chainable with a column selection. */
export interface AtlasUpsertBuilder<Row> extends PromiseLike<AtlasDbResult<null>> {
  select: (columns: string) => PromiseLike<AtlasDbResult<Row[]>>;
}

/**
 * The tail of an update on atlas.signals: `.update(values)` is only ever
 * filtered with `.in('signal_id', ids)` and awaited with no read-back — the
 * stamp changes a column nobody reads back.
 */
export interface AtlasUpdateBuilder {
  in(column: 'signal_id', values: readonly string[]): PromiseLike<AtlasDbResult<null>>;
}

/** The sweep read chain on atlas.signals: unstamped rows only (nothing else is filtered here). */
export interface AtlasSweepSelect {
  is(column: 'enqueued_at', value: null): AtlasSweepUnstamped;
}

/** Unstamped filter applied; restricts further to the lookback window. */
export interface AtlasSweepUnstamped {
  gt(column: 'created_at', value: string): AtlasSweepRecent;
}

/** Lookback filter applied; awaitable to the swept signal_ids (at most the limit). */
export interface AtlasSweepRecent {
  limit(count: number): PromiseLike<AtlasDbResult<{ signal_id: string }[]>>;
}

/** Rows this store writes into atlas.signal_queue for freshly inserted signals. */
export interface AtlasQueueRow {
  signal_id: string;
  priority: number;
  max_attempts: number;
}

/**
 * One atlas.queue_claim result row, as PostgREST JSON delivers it: bigint
 * id and attempts arrive as numbers, uuid and text as strings, timestamptz
 * as an ISO datetime string.
 */
export interface AtlasClaimedRow {
  id: number;
  ref_id: string;
  attempts: number;
  lease_token: string;
  lease_expires_at: string;
}

/** Outcome of atlas.queue_fail, as returned by PostgREST. */
export type AtlasFailOutcome = 'retry' | 'dead_letter' | 'lost_lease';

/**
 * What the atlas.queue_* rpc calls resolve to, as PostgREST JSON delivers
 * them: queue_claim returns claimed rows, the other three return a boolean
 * or an outcome string. Call sites narrow by function name; queue.ts does
 * that with runtime guards, so no cast is needed.
 */
export type AtlasRpcData = AtlasClaimedRow[] | boolean | AtlasFailOutcome;

/**
 * The atlas schema slice of the Supabase client this package needs: the two
 * table entry points and the atlas.queue_* functions via rpc. The client
 * built by @myboon/shared's createSupabaseClient satisfies this structurally;
 * unit tests build fakes against the same type.
 */
export interface AtlasSchema {
  from(table: 'signals' | 'signal_queue'): AtlasTable;
  rpc(
    fn: 'queue_claim',
    args: { p_queue: string; p_limit: number; p_lease: string },
  ): PromiseLike<AtlasDbResult<AtlasRpcData>>;
  rpc(
    fn: 'queue_heartbeat',
    args: { p_queue: string; p_id: number | string; p_token: string; p_lease: string },
  ): PromiseLike<AtlasDbResult<AtlasRpcData>>;
  rpc(
    fn: 'queue_complete',
    args: { p_queue: string; p_id: number | string; p_token: string },
  ): PromiseLike<AtlasDbResult<AtlasRpcData>>;
  rpc(
    fn: 'queue_fail',
    args: { p_queue: string; p_id: number | string; p_token: string; p_error: string; p_backoff: string },
  ): PromiseLike<AtlasDbResult<AtlasRpcData>>;
}

/** The slice of the Supabase client passed to the store and queue wrappers. */
export interface AtlasDb {
  schema(schemaName: string): AtlasSchema;
}

export interface InsertSignalsResult {
  inserted: number;
  duplicates: number;
  enqueued: number;
}

/** What one sweep pass did; found and enqueued match because the upsert writes a row for every id. */
export interface SweepUnqueuedResult {
  found: number;
  enqueued: number;
}

/** Queued rows retry twice before dead-lettering (atlas.signal_queue default is 5). */
const QUEUE_MAX_ATTEMPTS = 3;

/** How far back the sweep looks for signals that never got their enqueued_at stamp. */
export const SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Hard cap on rows one sweep pass reads and re-enqueues. */
export const SWEEP_LIMIT = 500;

/**
 * Stamp enqueued_at on exactly these signal_ids: `update ... in('signal_id',
 * ids)`, no read-back. Throws `scout-news: <step> failed: <PostgREST
 * message>`. A failed stamp is NOT retried here — the next run's sweep finds
 * the unstamped row and heals it, so a retry would only double the load.
 */
async function stampEnqueuedAt(db: AtlasDb, ids: readonly string[], enqueuedAtIso: string, step: string): Promise<void> {
  const { error } = await db
    .schema('atlas')
    .from('signals')
    .update({ enqueued_at: enqueuedAtIso })
    .in('signal_id', ids);
  if (error) {
    throw new Error(`scout-news: ${step} failed: ${error.message}`);
  }
}

/**
 * Dedupe (in memory, keeping the first) on the database key
 * (source, source_id) — Postgres rejects a single upsert statement that hits
 * the same key twice — then insert. Only rows with a returned signal_id
 * count as inserted and are enqueued in step 2 and stamped in step 3; every
 * other row (an in-batch repeat or a signal already stored) counts as a
 * duplicate.
 */
export async function insertSignals(db: AtlasDb, signals: Signal[]): Promise<InsertSignalsResult> {
  if (signals.length === 0) {
    return { inserted: 0, duplicates: 0, enqueued: 0 };
  }

  const seen = new Set<string>();
  const unique: Signal[] = [];
  for (const signal of signals) {
    const key = `${signal.source}\u0000${signal.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }

  // Step 1: signals. The read-back selects ONLY signal_id — service_role may
  // read just signal_id, source and source_id from atlas.signals.
  const { data, error } = await db
    .schema('atlas')
    .from('signals')
    .upsert(unique, { onConflict: 'source,source_id', ignoreDuplicates: true })
    .select('signal_id');
  if (error) {
    throw new Error(`scout-news: signal insert failed: ${error.message}`);
  }

  const ids = (data ?? []).map((row) => row.signal_id);
  const inserted = ids.length;
  const duplicates = signals.length - inserted;

  // Step 2: queue rows for step 1's ids only. on_conflict=signal_id
  // do-nothing keeps the call harmless when the queue row already exists
  // (the sweep re-runs exactly this upsert for unstamped rows).
  let enqueued = 0;
  if (ids.length > 0) {
    const idSet = new Set(ids);
    const queueRows: AtlasQueueRow[] = unique
      .filter((signal) => idSet.has(signal.signal_id))
      .map((signal) => ({ signal_id: signal.signal_id, priority: signal.priority, max_attempts: QUEUE_MAX_ATTEMPTS }));
    const { error: queueError } = await db
      .schema('atlas')
      .from('signal_queue')
      .upsert(queueRows, { onConflict: 'signal_id', ignoreDuplicates: true });
    if (queueError) {
      throw new Error(`scout-news: signal enqueue failed: ${queueError.message}`);
    }
    enqueued = queueRows.length;

    // Step 3: mark the fresh signals as enqueued. Exactly the ids step 1
    // returned are stamped, so a stamp can never land on a row this run
    // skipped; a stamp failure throws and the sweep heals it next run.
    await stampEnqueuedAt(db, ids, new Date().toISOString(), 'enqueue stamp');
  }

  return { inserted, duplicates, enqueued };
}

/**
 * Recovery sweep: re-enqueue and stamp up to SWEEP_LIMIT signals inserted
 * within the last SWEEP_LOOKBACK_MS that never got their enqueued_at stamp
 * (a run that died before step 3). The select asks only for signal_id; the
 * queue upsert is ignoreDuplicates, so a signal whose queue row survived is
 * not re-leased; finished signals keep the stamp and are never selected.
 * Errors throw with the failing step name and cost nothing — the next run
 * retries by running the sweep again.
 */
export async function sweepUnqueued(db: AtlasDb, now: Date): Promise<SweepUnqueuedResult> {
  const cutoffIso = new Date(now.getTime() - SWEEP_LOOKBACK_MS).toISOString();
  const { data, error } = await db
    .schema('atlas')
    .from('signals')
    .select('signal_id')
    .is('enqueued_at', null)
    .gt('created_at', cutoffIso)
    .limit(SWEEP_LIMIT);
  if (error) {
    throw new Error(`scout-news: sweep select failed: ${error.message}`);
  }
  const ids = (data ?? []).map((row) => row.signal_id);
  if (ids.length === 0) {
    return { found: 0, enqueued: 0 };
  }

  const queueRows: AtlasQueueRow[] = ids.map((signalId) => ({
    signal_id: signalId,
    priority: 0,
    max_attempts: QUEUE_MAX_ATTEMPTS,
  }));
  const { error: queueError } = await db
    .schema('atlas')
    .from('signal_queue')
    .upsert(queueRows, { onConflict: 'signal_id', ignoreDuplicates: true });
  if (queueError) {
    throw new Error(`scout-news: sweep enqueue failed: ${queueError.message}`);
  }

  // Stamp exactly the ids this pass re-enqueued: the select returned them,
  // so the stamp cannot land on a signal the sweep skipped.
  await stampEnqueuedAt(db, ids, now.toISOString(), 'sweep stamp');
  return { found: ids.length, enqueued: ids.length };
}