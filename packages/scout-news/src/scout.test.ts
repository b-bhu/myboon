/**
 * runScoutOnce against a fake fetcher and a fake atlas client that records
 * the call order: the feed fetch happens once, then the signals upsert — the
* insert is the handoff, so there is no sweep, no queue row and no
* enqueued_at stamp. The insert details live in store.test.ts and the
* DB-side behavior in scout.db.test.ts (PostgREST is not run locally).
 */
import { describe, expect, it } from 'vitest';

import { fetchFeed } from '@myboon/shared/news-feed';
import type { NewsFeedArticle, NewsFeedMeta } from '@myboon/shared/news-feed';

import { runScoutOnce } from './scout.js';
import type { AtlasDb, AtlasUpsertBuilder } from './store.js';
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

const articleThatNeverMaps: NewsFeedArticle = {
  kind: 'article',
  title: 'x',
  url: 'not a url',
  publishedAt: '2026-10-26T08:45:00.000Z',
  outlet: 'The Block',
  author: null,
  imageUrl: null,
  relatedCoinIds: [],
};

const emptyMeta: NewsFeedMeta = { mode: 'global', terms: [], limit: 50, coingeckoCandidates: 0, xCandidates: 0 };

type UpsertOptions = { onConflict: string; ignoreDuplicates: boolean };

/** The fake records the signals upsert (rows + options) and answers with an empty read-back. */
function fakeScoutDb() {
  const events: string[] = [];
  const upserts: { table: string; rows: readonly Signal[]; options: UpsertOptions }[] = [];

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
              if (rows.length === 0 || upsertOptions.onConflict === '') {
                throw new Error('unexpected upsert arguments');
              }
              events.push('signals:upsert');
              upserts.push({ table, rows: [...rows], options: upsertOptions });
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
            },
          };
        },
      };
    },
  };
  return { db, events, upserts };
}

describe('runScoutOnce (fake fetcher + fake atlas client)', () => {
  const fixedNow = new Date('2026-10-26T09:00:00.000Z');

  it('fetches once, maps, and stores with the handoff conflict shape', async () => {
    const { db, events, upserts } = fakeScoutDb();
    const fetcher: typeof fetchFeed = async () => {
      events.push('fetch');
      return { items: [articleItem], meta: emptyMeta };
    };

    await expect(runScoutOnce({ db, fetcher, now: () => fixedNow })).resolves.toEqual({
      fetched: 1,
      mapped: 1,
      invalid: 0,
      inserted: 0, // the fake read-back is empty; the item counts as a duplicate
      duplicates: 1,
    });

    expect(events).toEqual(['fetch', 'signals:upsert']);
    expect(upserts).toEqual([
      { table: 'signals', rows: [expect.objectContaining({ source: 'tokens_xyz', type: 'news' })], options: { onConflict: 'source,source_id', ignoreDuplicates: true } },
    ]);
  });

  it('skips items that do not map and keeps going', async () => {
    const { db, upserts } = fakeScoutDb();
    const fetcher: typeof fetchFeed = async () => ({ items: [articleItem, articleThatNeverMaps], meta: emptyMeta });

    await expect(runScoutOnce({ db, fetcher, now: () => fixedNow })).resolves.toEqual({
      fetched: 2,
      mapped: 1,
      invalid: 1,
      inserted: 0,
      duplicates: 1,
    });
    expect(upserts[0]?.rows).toHaveLength(1);
  });

  it('aborts and stores nothing when the fetch fails', async () => {
    const { db, events, upserts } = fakeScoutDb();
    const fetcher: typeof fetchFeed = async () => {
      throw new Error('feed unavailable');
    };

    await expect(runScoutOnce({ db, fetcher, now: () => fixedNow })).rejects.toThrow('feed unavailable');

    expect(events).toEqual([]);
    expect(upserts).toHaveLength(0);
  });
});