/**
 * insertSignals against a fake atlas client that records the exact call: the
 * upsert arguments and the select('signal_id') read-back. The fake's default
 * signals behavior mimics a small Postgres table: a row's signal_id is
 * returned only on the first insert, so a second insertSignals call sees only
 * conflicts — the database side (insert ... on conflict (source, source_id)
 * do nothing returning signal_id) is covered by scout.db.test.ts against a
 * disposable Postgres.
 */
import { describe, expect, it } from 'vitest';

import type { Signal } from '@myboon/contracts';

import { insertSignals } from './store.js';
import type { AtlasDb, AtlasDbError, AtlasDbResult, AtlasUpsertBuilder } from './store.js';

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
  rows: readonly Signal[];
  options: UpsertOptions;
  selectColumns: string[];
};

type FakeOptions = {
  /** Postgrest error the signals step reports. */
  signalsError?: AtlasDbError;
  /** Fixed signal_id read-back for the signals select, instead of the fake's stored-set default. */
  insertedIds?: string[];
};

const nullResult: AtlasDbResult<null> = { data: null, error: null };

/**
 * A fake AtlasDb whose schema('atlas') records the signals upsert and answers
 * exactly like the PostgREST call of insertSignals: signal_id rows returned
 * only for rows not seen before, unless insertedIds forces a projection.
 */
function fakeAtlasDb(options: FakeOptions = {}) {
  const storedSignals = new Set<string>();
  const signalCalls: SignalUpsertCall[] = [];

  const db: AtlasDb = {
    schema(schemaName: string) {
      if (schemaName !== 'atlas') {
        throw new Error(`unexpected schema: ${schemaName}`);
      }
      return {
        from(table: 'signals') {
          if (table !== 'signals') {
            throw new Error(`unexpected table: ${table}`);
          }
          return {
            upsert(rows: readonly Signal[], upsertOptions: UpsertOptions): AtlasUpsertBuilder<{ signal_id: string }> {
              const snapshot = [...rows];
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
            },
          };
        },
      };
    },
  };
  return { db, signalCalls };
}

describe('insertSignals (fake atlas client)', () => {
  it('returns zeros for an empty batch and never touches the client', async () => {
    const { db, signalCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [])).resolves.toEqual({ inserted: 0, duplicates: 0 });

    expect(signalCalls).toHaveLength(0);
  });

  it('upserts with onConflict source,source_id + ignoreDuplicates and reads back only signal_id', async () => {
    const signal = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const { db, signalCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [signal])).resolves.toEqual({ inserted: 1, duplicates: 0 });

    expect(signalCalls).toEqual([
      {
        rows: [signal],
        options: { onConflict: 'source,source_id', ignoreDuplicates: true },
        selectColumns: ['signal_id'],
      },
    ]);
  });

  it('keeps the first occurrence and counts the repeats when one batch carries the same source twice', async () => {
    const first = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const repeat = { ...first, text: 'second copy', excerpt: 'second copy' };
    const third = makeSignal('https://x.test/b', FAKE_SIGNAL_ID_B);
    const { db, signalCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [first, repeat, third])).resolves.toEqual({ inserted: 2, duplicates: 1 });

    expect(signalCalls[0]?.rows).toEqual([first, third]);
  });

  it('re-runs safely: every already-present signal counts as a duplicate and nothing is re-inserted', async () => {
    const signal = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const { db, signalCalls } = fakeAtlasDb();

    await expect(insertSignals(db, [signal])).resolves.toEqual({ inserted: 1, duplicates: 0 });
    await expect(insertSignals(db, [signal])).resolves.toEqual({ inserted: 0, duplicates: 1 });
    expect(signalCalls).toHaveLength(2);
    expect(signalCalls[1]?.rows).toEqual([signal]);
  });

  it('throws when the signals step fails', async () => {
    const { db, signalCalls } = fakeAtlasDb({ signalsError: { message: 'permission denied for table signals' } });

    await expect(insertSignals(db, [makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A)])).rejects.toThrow(
      'scout-news: signal insert failed: permission denied for table signals',
    );

    expect(signalCalls[0]?.selectColumns).toEqual(['signal_id']);
  });

  it('counts rows the read-back did not return as duplicates (already present on the DB)', async () => {
    const first = makeSignal('https://x.test/a', FAKE_SIGNAL_ID_A);
    const second = makeSignal('https://x.test/b', FAKE_SIGNAL_ID_B);
    const { db, signalCalls } = fakeAtlasDb({ insertedIds: [FAKE_SIGNAL_ID_A] });

    await expect(insertSignals(db, [first, second])).resolves.toEqual({ inserted: 1, duplicates: 1 });

    expect(signalCalls[0]?.options).toEqual({ onConflict: 'source,source_id', ignoreDuplicates: true });
  });
});