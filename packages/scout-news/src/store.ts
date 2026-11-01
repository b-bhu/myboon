/**
 * Store: insert V4 signals into atlas.signals through the Supabase client
 * (service_role). The insert IS the handoff to the analyst (#478): the
 * migration (supabase/migrations/20261027120000_atlas_signal_status.sql) gives
 * every new row status 'received', attempts 0 and next_attempt_at now(), so a
 * committed signal is immediately claimable and there is no queue row, no
 * enqueue step and no enqueued_at stamp. The atlas schema is defined by
 * supabase/migrations/20261025100000_atlas_core.sql — this package runs no SQL
 * migrations of its own.
 *
 * supabase-js has no transaction API, so this is one PostgREST call:
 * upsert into atlas.signals (`on_conflict=source,source_id`, ignoreDuplicates)
 * and read back ONLY signal_id — a signal that is already present yields no id
 * and is never re-handed-off, so a completed signal survives later re-runs
 * untouched and the call is idempotent across scout runs.
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

/** The atlas.signals table slice: an upsert that chains `.select()` to read back the inserted signal_ids. */
export interface AtlasTable {
  upsert(
    rows: readonly Signal[],
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): AtlasUpsertBuilder<{ signal_id: string }>;
}

/** Builder for a signals-table upsert: awaitable as-is, and chainable with a column selection. */
export interface AtlasUpsertBuilder<Row> extends PromiseLike<AtlasDbResult<null>> {
  select: (columns: string) => PromiseLike<AtlasDbResult<Row[]>>;
}

/**
 * The atlas schema slice of the Supabase client this package needs. The client
 * built by @myboon/shared's createSupabaseClient satisfies this structurally;
 * unit tests build fakes against the same type.
 */
export interface AtlasSchema {
  from(table: 'signals'): AtlasTable;
}

/** The slice of the Supabase client passed to the store. */
export interface AtlasDb {
  schema(schemaName: string): AtlasSchema;
}

export interface InsertSignalsResult {
  inserted: number;
  duplicates: number;
}

/**
 * Dedupe (in memory, keeping the first) on the database key
 * (source, source_id) — Postgres rejects a single upsert statement that hits
 * the same key twice — then insert. Only rows with a returned signal_id count
 * as inserted; every other row (an in-batch repeat or a signal already
 * stored) counts as a duplicate, and the insert is never retried: a rerun
 * sees the same conflict and inserts nothing twice.
 */
export async function insertSignals(db: AtlasDb, signals: Signal[]): Promise<InsertSignalsResult> {
  if (signals.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }

  const seen = new Set<string>();
  const unique: Signal[] = [];
  for (const signal of signals) {
    const key = `${signal.source}\u0000${signal.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }

  // The read-back selects ONLY signal_id — service_role may read just
  // signal_id, source and source_id from atlas.signals.
  const { data, error } = await db
    .schema('atlas')
    .from('signals')
    .upsert(unique, { onConflict: 'source,source_id', ignoreDuplicates: true })
    .select('signal_id');
  if (error) {
    throw new Error(`scout-news: signal insert failed: ${error.message}`);
  }

  const inserted = (data ?? []).length;
  return { inserted, duplicates: signals.length - inserted };
}