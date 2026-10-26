/**
 * Store: insert V4 signals and enqueue the freshly inserted ones.
 *
 * One transaction per run. Dedupe is the database key (source, source_id)
 * via `on conflict do nothing returning signal_id`: a signal that is already
 * present yields no row and is NOT re-enqueued, so a completed signal survives
 * later re-runs untouched (no queue row is created for it again).
 */
import type { Signal } from '@myboon/contracts';
import type { PoolClient } from 'pg';

/** The slice of a pg PoolClient that the store and queue wrappers need. */
export type Queryable = Pick<PoolClient, 'query'>;

export const SQL_INSERT_SIGNAL = `insert into atlas.signals
  (signal_id, schema_version, source, source_id, type, priority, occurred_at, fetched_at, text, numbers, link, raw_ids, unusual_score, excerpt, raw_hash)
values
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (source, source_id) do nothing
returning signal_id`;

export const SQL_ENQUEUE_SIGNAL = `insert into atlas.signal_queue (signal_id, priority, max_attempts)
values ($1, $2, 3)
on conflict (signal_id) do nothing`;

export interface InsertSignalsResult {
  inserted: number;
  duplicates: number;
}

/**
 * All inserts inside one BEGIN/COMMIT transaction, rolled back entirely on
 * error. Enqueue only happens for rows this call actually inserted.
 */
export async function insertSignals(
  client: Queryable,
  signals: Signal[],
): Promise<InsertSignalsResult> {
  await client.query('begin');
  try {
    await client.query("set local statement_timeout = '10s'");
    await client.query("set local lock_timeout = '2s'");

    let inserted = 0;
    let duplicates = 0;
    for (const signal of signals) {
      const result = await client.query<{ signal_id: string }>(SQL_INSERT_SIGNAL, [
        signal.signal_id,
        signal.schema_version,
        signal.source,
        signal.source_id,
        signal.type,
        signal.priority,
        signal.occurred_at,
        signal.fetched_at,
        signal.text,
        signal.numbers,
        signal.link,
        signal.raw_ids,
        signal.unusual_score,
        signal.excerpt,
        signal.raw_hash,
      ]);
      const row = result.rows[0];
      if (!row) {
        duplicates += 1;
        continue;
      }
      inserted += 1;
      await client.query(SQL_ENQUEUE_SIGNAL, [row.signal_id, signal.priority]);
    }

    await client.query('commit');
    return { inserted, duplicates };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}