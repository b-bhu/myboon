/**
 * runScoutOnce against a fake fetcher and a fake atlas client that records
 * the call order: the crash-recovery sweep always opens the run, before the
 * feed fetch and the store calls. The insert/enqueue/stamp details live in
 * store.test.ts, and the DB-side sweep filters in scout.db.test.ts
 * (PostgREST is not run locally).
 */
import { describe, expect, it } from 'vitest';

import { fetchFeed } from '@myboon/shared/news-feed';
import type { NewsFeedArticle, NewsFeedMeta } from '@myboon/shared/news-feed';

import { runScoutOnce } from './scout.js';
import type { AtlasDb, AtlasDbError, AtlasDbResult, AtlasQueueRow, AtlasSweepRecent, AtlasSweepSelect, AtlasSweepUnstamped, AtlasUpdateBuilder, AtlasUpsertBuilder } from './store.js';
import type { Signal } from '@myboon/contracts';

const articleItem: NewsFeedArticle = {
  kind: 'article',
  title: 'Ethereum staking inflows slow ahead of the upgrade vote',
  url: 'https://www.theblock.co/post/333211/ethereum-staking-inflows-slow-upgrade-vote',
  publishedAt: '2026-10-26T08:45:00.000Z',
  outlet: 'The Block',
  author: null,
  imageUrl: null,
  relatedCoinIds: ['ethereum'],
};

const emptyMeta: NewsFeedMeta = { mode: 'global', terms: [], limit: 50, coingeckoCandidates: 0, xCandidates: 0 };

const FAKE_SIGNAL_ID_A = 'a'.repeat(64);

type UpsertOptions = { onConflict: string; ignoreDuplicates: boolean };

type FakeOptions = {
  /** signal_id rows the sweep select returns (default [], modeling a DB where nothing is unstamped). */
  sweepIds?: string[];
  /** Postgrest error the sweep select reports. */
  sweepError?: AtlasDbError;
};

/** The fake is deliberately shallow: the signals upsert read-back is always empty. */
function fakeScoutDb(options: FakeOptions = {}) {
  const events: string[] = [];
  // Filter arguments the sweep select received (one select per call). One
  // object mutated in place, so the caller sees the live values after the run.
  const sweepFilter: { is: { column: string; value: null } | null; gt: { column: string; value: string } | null; limit: number | null } = {
    is: null,
    gt: null,
    limit: null,
  };

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
              if (rows.length === 0 || upsertOptions.onConflict === '') {
                throw new Error('unexpected upsert arguments');
              }
              if (table === 'signals') {
                events.push('signals:upsert');
                return {
                  select(columns: string) {
                    if (columns !== 'signal_id') {
                      throw new Error(`unexpected select columns: ${columns}`);
                    }
                    // Nothing newly inserted: insertSignals counts duplicates.
                    return Promise.resolve({ data: [], error: null });
                  },
                  then(onfulfilled, onrejected) {
                    return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
                  },
                };
              }
              events.push('queue:upsert');
              return {
                select() {
                  throw new Error('signal_queue upserts must not select');
                },
                then(onfulfilled, onrejected) {
                  return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
                },
              };
            },
            select(columns: 'signal_id'): AtlasSweepSelect {
              if (table !== 'signals') {
                throw new Error('signal_queue must not be selected');
              }
              events.push('sweep:select');
              const result: AtlasDbResult<{ signal_id: string }[]> = options.sweepError
                ? { data: null, error: options.sweepError }
                : { data: (options.sweepIds ?? []).map((id) => ({ signal_id: id })), error: null };
              return {
                is(column: 'enqueued_at', value: null): AtlasSweepUnstamped {
                  sweepFilter.is = { column, value };
                  return {
                    gt(gtColumn: 'created_at', gtValue: string): AtlasSweepRecent {
                      sweepFilter.gt = { column: gtColumn, value: gtValue };
                      return {
                        limit(count: number): PromiseLike<AtlasDbResult<{ signal_id: string }[]>> {
                          sweepFilter.limit = count;
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
              events.push('signals:stamp');
              if (Number.isNaN(Date.parse(values.enqueued_at))) {
                throw new Error('enqueued_at stamp must be a parseable timestamp');
              }
              return {
                in(column: 'signal_id', inIds: readonly string[]): PromiseLike<AtlasDbResult<null>> {
                  if (column === 'signal_id' && inIds.length === 0) {
                    throw new Error('stamp must name at least one signal_id');
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        rpc() {
          throw new Error('runScoutOnce must not call rpc');
        },
      };
    },
  }
  return { db, events, sweepFilter };
}

describe('runScoutOnce (fake fetcher + fake atlas client)', () => {
  const fixedNow = new Date('2026-10-26T09:00:00.000Z');

  it('sweeps before it fetches, and reports the swept count', async () => {
    const { db, events, sweepFilter } = fakeScoutDb({ sweepIds: [FAKE_SIGNAL_ID_A] });
    const fetcher: typeof fetchFeed = async () => {
      events.push('fetch');
      return { items: [articleItem], meta: emptyMeta };
    };

    // The sweep found the stranded signal (swept 1); the signals upsert
    // read-back is empty in this fake, so the item counts as a duplicate.
    await expect(runScoutOnce({ db, fetcher, now: () => fixedNow })).resolves.toEqual({
      fetched: 1,
      mapped: 1,
      invalid: 0,
      inserted: 0,
      duplicates: 1,
      enqueued: 0,
      swept: 1,
    });

    // The sweep completes fully (select → queue upsert → stamp) before the
    // feed is fetched, and only then does insertSignals run. The signals
    // upsert read-back is empty in this fake, so the item counts as a
    // duplicate and there is no second queue upsert or stamp.
    expect(events).toEqual(['sweep:select', 'queue:upsert', 'signals:stamp', 'fetch', 'signals:upsert']);

    // The sweep window is derived from the run's clock, not the wall clock.
    expect(sweepFilter.is).toEqual({ column: 'enqueued_at', value: null });
    expect(sweepFilter.gt).toEqual({ column: 'created_at', value: '2026-10-25T09:00:00.000Z' });
    expect(sweepFilter.limit).toBe(500);
  });

  it('aborts before fetching when the sweep fails', async () => {
    const { db, events } = fakeScoutDb({ sweepError: { message: 'connection refused' } });
    const fetcher: typeof fetchFeed = async () => {
      // Recorded before the throw so the event list proves fetch was never reached.
      events.push('fetch');
      throw new Error('fetch must not be reached');
    };

    await expect(runScoutOnce({ db, fetcher, now: () => fixedNow })).rejects.toThrow(
      'scout-news: sweep select failed: connection refused',
    );

    expect(events).toEqual(['sweep:select']);
  });
});