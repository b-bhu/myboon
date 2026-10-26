/**
 * insertSignals and sweepUnqueued against a fake atlas client that records
 * the exact calls: upsert arguments, the select('signal_id') read-back, which
 * rows get enqueued, and which ids get the enqueued_at stamp. The fake's
 * default signals behavior mimics a small Postgres table: a row's signal_id
 * is returned only on the first insert, so a second insertSignals call sees
 * only conflicts. The fake's sweep select is an empty result by default — the
 * real DB-side filter (enqueued_at null, created_at recent) excludes finished
 * signals; that filtering is covered by scout.db.test.ts (PostgREST is not
 * run locally).
 */
import { describe, expect, it } from 'vitest';

import type { Signal } from '@myboon/contracts';

import { insertSignals, sweepUnqueued } from './store.js';
import type {
  AtlasDb,
  AtlasDbError,
  AtlasDbResult,
  AtlasQueueRow,
  AtlasSweepRecent,
  AtlasSweepSelect,
  AtlasSweepUnstamped,
  AtlasUpdateBuilder,
  AtlasUpsertBuilder,
} from './store.js';

/** A valid news Signal; the caller supplies the unique url and its hex signal_id. */
function makeSignal(url: string, signalId: string, priority: 0 | 1 = 0): Signal {
  return {
    schema_version: 1,
    signal_id: signalId,
    source: 'tokens_xyz',
    source_id: url,
    type: 'news',
    priority,
    occurred_at: null,
    fetched_at: '2026-10-26T09:00:00.000Z',
    text: 'headline',
    numbers: {},
    link: url,
    raw_ids: {},
    unusual_score: null,
    excerpt: 'headline',
    raw_hash: 'b'.repeat(64),
  };
}

const FAKE_SIGNAL_ID_A = 'a'.repeat(64);
const FAKE_SIGNAL_ID_B = 'b'.repeat(64);

type UpsertOptions = { onConflict: string; ignoreDuplicates: boolean };

/** An upsert into atlas.signals, with every select() it received. */
type SignalUpsertCall = {
  rows: readonly (Signal | AtlasQueueRow)[];
  options: UpsertOptions;
  selectColumns: string[];
};

/** An upsert into atlas.signal_queue. */
type QueueUpsertCall = {
  rows: readonly (Signal | AtlasQueueRow)[];
  options: UpsertOptions;
};

/** The sweep read: the select/is/gt/limit arguments it received. */
type SweepSelectCall = {
  columns: string;
  is: { column: string; value: null } | null;
  gt: { column: string; value: string } | null;
  limit: number | null;
};

/** The enqueued_at stamp: the update values and the .in() filter it received. */
type UpdateCall = {
  values: { enqueued_at: string };
  inColumn: string | null;
  inIds: readonly string[] | null;
};

type FakeOptions = {
  /** Postgrest error the signals step reports. */
  signalsError?: AtlasDbError;
  /** Postgrest error the queue step reports (insertSignals and the sweep share the queue upsert shape). */
  queueError?: AtlasDbError;
  /** Postgrest error the signals-table update (the enqueued_at stamp) reports. */
  updateError?: AtlasDbError;
  /** Fixed signal_id read-back for the signals select, instead of the fake's stored-set default. */
  insertedIds?: string[];
  /** signal_id rows the sweep select returns (default [], modeling a DB where nothing is unstamped). */
  sweepIds?: string[];
  /** Postgrest error the sweep select reports. */
  sweepError?: AtlasDbError;
};

const nullResult: AtlasDbResult<null> = { data: null, error: null };

/**
 * A fake AtlasDb whose schema('atlas') records the calls and answers exactly
 * like the PostgREST calls of insertSignals and sweepUnqueued: the signals
 * upsert returns signal_id rows (only for rows not seen before, unless
 * insertedIds forces a projection), the queue upsert resolves without a
 * read-back, the sweep select returns the configured sweepIds (default []),
 * and the signals-table update reports updateError (default none).
 */
function fakeAtlasDb(options: FakeOptions = {}) {
  const storedSignals = new Set<string>();
  const signalCalls: SignalUpsertCall[] = [];
  const queueCalls: QueueUpsertCall[] = [];
  const sweepSelectCalls: SweepSelectCall[] = [];
  const updateCalls: UpdateCall[] = [];

  const db: AtlasDb = {
    schema(schemaName: string) {
      if (schemaName !== 'atlas') {
        throw new Error(`unexpected schema: ${schemaName}`);
      }
      return {
        from(table: 'signals' | 'signal_queue') {
          return {
            upsert(
              rows: readonly (Signal | AtlasQueueRow)[],
              upsertOptions: UpsertOptions,
            ): AtlasUpsertBuilder<{ signal_id: string }> {
              const snapshot = [...rows];
              if (table === 'signals') {
                const call: SignalUpsertCall = { rows: snapshot, options: upsertOptions, selectColumns: [] };
                signalCalls.push(call);
                const selectResult: AtlasDbResult<{ signal_id: string }[]> = options.signalsError
                  ? { data: null, error: options.signalsError }
                  : {
                      data: options.insertedIds
                        ? options.insertedIds.map((id) => ({ signal_id: id }))
                        : snapshot
                            .filter((row) => !storedSignals.has(row.signal_id))
                            .map((row) => ({ signal_id: row.signal_id })),
                      error: null,
                    };
                if (!options.signalsError) {
                  for (const row of snapshot) storedSignals.add(row.signal_id);
                }
                return {
                  select(columns: string) {
                    call.selectColumns.push(columns);
                    return Promise.resolve(selectResult);
                  },
                  then(onfulfilled, onrejected) {
                    return Promise.resolve(nullResult).then(onfulfilled, onrejected);
                  },
                };
              }
              queueCalls.push({ rows: snapshot, options: upsertOptions });
              return {
                select() {
                  throw new Error('signal_queue upserts must not select');
                },
                then(onfulfilled, onrejected) {
                  const result: AtlasDbResult<null> = options.queueError
                    ? { data: null, error: options.queueError }
                    : nullResult;
                  return Promise.resolve(result).then(onfulfilled, onrejected);
                },
              };
            },
            select(columns: 'signal_id'): AtlasSweepSelect {
              if (table !== 'signals') {
                throw new Error('signal_queue must not be selected');
              }
              const call: SweepSelectCall = { columns, is: null, gt: null, limit: null };
              sweepSelectCalls.push(call);
              const result: AtlasDbResult<{ signal_id: string }[]> = options.sweepError
                ? { data: null, error: options.sweepError }
                : { data: (options.sweepIds ?? []).map((id) => ({ signal_id: id })), error: null };
              return {
                is(column: 'enqueued_at', value: null): AtlasSweepUnstamped {
                  call.is = { column, value };
                  return {
                    gt(gtColumn: 'created_at', gtValue: string): AtlasSweepRecent {
                      call.gt = { column: gtColumn, value: gtValue };
                      return {
                        limit(count: number): PromiseLike<AtlasDbResult<{ signal_id: string }[]>> {
                          call.limit = count;
                          return Promise.resolve(result);
                        },
                      };
                    },
                  };
                },
              };
            },
            update(values: { enqueued_at: string }): AtlasUpdateBuilder {
              if (table !== 'signals') {
                throw new Error('signal_queue must not be updated');
              }
              const call: UpdateCall = { values: { ...values }, inColumn: null, inIds: null };
              updateCalls.push(call);
              return {
                in(column: 'signal_id', inIds: readonly string[]): PromiseLike<AtlasDbResult<null>> {
                  call.inColumn = column;
                  call.inIds = [...inIds];
                  const result: AtlasDbResult<null> = options.updateError
                    ? { data: null, error: options.updateError }
                    : nullResult;
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
        rpc() {
          throw new Error('insertSignals must not call rpc');
        },
      };
    },
  }
  return { db, signalCalls, queueCalls, sweepSelectCalls, updateCalls };
}

describe('insertSignals (fake atlas client)', () => {
  it('returns zeros for an empty batch and never touches the client', async () => {
    const { db, signalCalls, queueCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [])).resolves.toEqual({ inserted: 0, duplicates: 0, enqueued: 0 });

    expect(signalCalls).toHaveLength(0);
    expect(queueCalls).toHaveLength(0);
  });

  it('upserts with onConflict source,source_id + ignoreDuplicates and reads back only signal_id', async () => {
    const signal = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const { db, signalCalls, queueCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [signal])).resolves.toEqual({ inserted: 1, duplicates: 0, enqueued: 1 });

    expect(signalCalls).toEqual([
      {
        rows: [signal],
        options: { onConflict: 'source,source_id', ignoreDuplicates: true },
        selectColumns: ['signal_id'],
      },
    ]);
  });

  it('enqueues exactly one queue row per returned id, with max_attempts 3', async () => {
    const first = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A, 1);
    const second = makeSignal('https://x.test/b', FAKE_SIGNAL_ID_B);
    const { db, queueCalls, updateCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [first, second])).resolves.toEqual({ inserted: 2, duplicates: 0, enqueued: 2 });

    expect(queueCalls).toEqual([
      {
        rows: [
          { signal_id: FAKE_SIGNAL_ID_A, priority: 1, max_attempts: 3 },
          { signal_id: FAKE_SIGNAL_ID_B, priority: 0, max_attempts: 3 },
        ],
        options: { onConflict: 'signal_id', ignoreDuplicates: true },
      },
    ]);
    // The stamp lands only after the queue upsert succeeded.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.inColumn).toBe('signal_id');
    expect(updateCalls[0]!.inIds).toEqual([FAKE_SIGNAL_ID_A, FAKE_SIGNAL_ID_B]);
    expect(Date.parse(updateCalls[0]!.values.enqueued_at)).not.toBeNaN();
  });

  it('enqueues and stamps only the ids the signals step returned and counts the rest as duplicates', async () => {
    const first = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const second = makeSignal('https://x.test/b', FAKE_SIGNAL_ID_B);
    const { db, queueCalls, updateCalls } = fakeAtlasDb({ insertedIds: [FAKE_SIGNAL_ID_A] });

    await expect(insertSignals(db, [first, second])).resolves.toEqual({ inserted: 1, duplicates: 1, enqueued: 1 });

    expect(queueCalls[0]!.rows.map((row) => row.signal_id)).toEqual([FAKE_SIGNAL_ID_A]);
    expect(updateCalls[0]!.inIds).toEqual([FAKE_SIGNAL_ID_A]);
  });

  it('makes no queue call and no stamp when the signals step returned zero ids', async () => {
    const { db, signalCalls, queueCalls, updateCalls } = fakeAtlasDb({ insertedIds: [] });

    await expect(insertSignals(db, [makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A)])).resolves.toEqual({
      inserted: 0,
      duplicates: 1,
      enqueued: 0,
    });

    expect(signalCalls[0]!.selectColumns).toEqual(['signal_id']);
    expect(queueCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('keeps the first occurrence and counts the repeats when one batch carries the same source twice', async () => {
    const first = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const repeat = { ...first, text: 'second copy', excerpt: 'second copy' };
    const third = makeSignal('https://x.test/b', FAKE_SIGNAL_ID_B);
    const { db, signalCalls, queueCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [first, repeat, third])).resolves.toEqual({ inserted: 2, duplicates: 1, enqueued: 2 });

    expect(signalCalls[0]?.rows).toEqual([first, third]);
    expect(queueCalls[0]?.rows.map((row) => row.signal_id)).toEqual([FAKE_SIGNAL_ID_A, FAKE_SIGNAL_ID_B]);
  });

  it('throws when the signals step fails and makes no queue call', async () => {
    const { db, signalCalls, queueCalls } = fakeAtlasDb({ signalsError: { message: 'permission denied for table signals' } });

    await expect(insertSignals(db, [makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A)])).rejects.toThrow(
      'scout-news: signal insert failed: permission denied for table signals',
    );

    expect(signalCalls[0]?.selectColumns).toEqual(['signal_id']);
    expect(queueCalls).toHaveLength(0);
  });

  it('throws when the queue step fails after the signals step went out, and does not stamp', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({ queueError: { message: 'insert or update on table violates foreign key constraint' } });

    await expect(insertSignals(db, [makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A)])).rejects.toThrow(
      'scout-news: signal enqueue failed: insert or update on table violates foreign key constraint',
    );

    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
  });

  it('throws when the stamp fails after the queue row landed', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({ updateError: { message: 'permission denied for table signals' } });

    await expect(insertSignals(db, [makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A)])).rejects.toThrow(
      'scout-news: enqueue stamp failed: permission denied for table signals',
    );

    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
  });

  it('re-runs safely after a queue-step failure: no throw, no re-enqueue, duplicates counted', async () => {
    const signal = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const { db, signalCalls, queueCalls, updateCalls } = fakeAtlasDb({ queueError: { message: 'temporarily unavailable' } });

    // First run: the signal is inserted (step 1 succeeded, stored in the fake)
    // but the enqueue fails, so nothing is stamped.
    await expect(insertSignals(db, [signal])).rejects.toThrow('scout-news: signal enqueue failed: temporarily unavailable');
    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);

    // Second run: the signals upsert now conflicts and returns no ids, so
    // nothing throws and nothing is enqueued or stamped again — the row
    // stays unstamped until the sweep heals it (see the sweepUnqueued tests
    // below and scout.db.test.ts for the DB-side filters).
    await expect(insertSignals(db, [signal])).resolves.toEqual({ inserted: 0, duplicates: 1, enqueued: 0 });
    expect(signalCalls).toHaveLength(2);
    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('sweepUnqueued (fake atlas client)', () => {
  const fixedNow = new Date('2026-10-26T09:00:00.000Z');
  const expectedCutoff = '2026-10-25T09:00:00.000Z';

  it('selects with the null-stamp filter and the 24h cutoff, and does nothing when nothing is found', async () => {
    // The fake returns [] for the null filter — modeling the DB-side select
    // that excludes finished signals (enqueued_at set, queue row consumed);
    // the DB-side filter behavior is covered by scout.db.test.ts.
    const { db, queueCalls, updateCalls, sweepSelectCalls } = fakeAtlasDb({ sweepIds: [] });

    await expect(sweepUnqueued(db, fixedNow)).resolves.toEqual({ found: 0, enqueued: 0 });

    expect(sweepSelectCalls).toEqual([
      {
        columns: 'signal_id',
        is: { column: 'enqueued_at', value: null },
        gt: { column: 'created_at', value: expectedCutoff },
        limit: 500,
      },
    ]);
    expect(queueCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('re-enqueues and stamps a signal the previous run crashed before enqueueing', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({ sweepIds: [FAKE_SIGNAL_ID_A] });

    await expect(sweepUnqueued(db, fixedNow)).resolves.toEqual({ found: 1, enqueued: 1 });

    expect(queueCalls).toEqual([
      {
        rows: [{ signal_id: FAKE_SIGNAL_ID_A, priority: 0, max_attempts: 3 }],
        options: { onConflict: 'signal_id', ignoreDuplicates: true },
      },
    ]);
    expect(updateCalls).toEqual([
      { values: { enqueued_at: fixedNow.toISOString() }, inColumn: 'signal_id', inIds: [FAKE_SIGNAL_ID_A] },
    ]);
  });

  it('throws with the select step name when the sweep select fails, and touches nothing else', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({ sweepError: { message: 'permission denied for table signals' } });

    await expect(sweepUnqueued(db, fixedNow)).rejects.toThrow(
      'scout-news: sweep select failed: permission denied for table signals',
    );

    expect(queueCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('throws with the enqueue step name when the sweep queue upsert fails, and does not stamp', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({
      sweepIds: [FAKE_SIGNAL_ID_A],
      queueError: { message: 'permission denied for table signal_queue' },
    });

    await expect(sweepUnqueued(db, fixedNow)).rejects.toThrow(
      'scout-news: sweep enqueue failed: permission denied for table signal_queue',
    );

    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
  });

  it('throws with the stamp step name when the sweep stamp fails', async () => {
    const { db, queueCalls, updateCalls } = fakeAtlasDb({
      sweepIds: [FAKE_SIGNAL_ID_A],
      updateError: { message: 'permission denied for table signals' },
    });

    await expect(sweepUnqueued(db, fixedNow)).rejects.toThrow(
      'scout-news: sweep stamp failed: permission denied for table signals',
    );

    expect(queueCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);
  });
});