/**
 * Integration checks against a real database with the atlas migrations
 * (20261025100000_atlas_core, 20261025100100_atlas_queues) applied.
 *
 * Point SCOUT_TEST_DATABASE_URL at a DISPOSABLE database: every test
 * truncates atlas.signal_queue, atlas.dead_letter and atlas.signals
 * (cascade) first. When the variable is unset the whole describe is skipped.
 * The fetcher is always a fake — no upstream is contacted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { signalId } from '@myboon/contracts';
import type { NewsFeedArticle, NewsFeedFetchOptions, NewsFeedItem, NewsFeedResult, NewsFeedPost } from '@myboon/shared/news-feed';

import { complete, claim, fail } from './queue.js';
import { runScoutOnce } from './scout.js';

const TEST_DATABASE_URL = process.env.SCOUT_TEST_DATABASE_URL?.trim() ?? '';

const articleItem: NewsFeedArticle = {
  kind: 'article',
  title: 'Bitcoin ETF inflows resume as desks reprice April risk',
  url: 'https://www.theblock.co/post/333210/bitcoin-etf-inflows-resume-reprice-april-risk',
  publishedAt: '2026-10-26T08:05:00.000Z',
  outlet: 'The Block',
  author: null,
  imageUrl: null,
  relatedCoinIds: ['bitcoin'],
};

const postItem: NewsFeedPost = {
  kind: 'post',
  text: 'SOL-USD perps are live on the terminal, BTC-USD spreads tightened to 4bps for the week.',
  url: 'https://x.com/myboontokens/status/1917764102417182722',
  postedAt: '2026-10-26T07:10:16.000Z',
  handle: '@myboontokens',
  imageUrl: null,
  relatedCoinIds: [],
};

function fetcherFor(items: NewsFeedItem[]): (options?: NewsFeedFetchOptions) => Promise<NewsFeedResult<NewsFeedItem>> {
  return async () => ({
    items,
    meta: { mode: 'global', terms: [], limit: 50, coingeckoCandidates: 0, xCandidates: 0 },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(TEST_DATABASE_URL === '')('scout-news against a real database', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 2,
      application_name: 'myboon_scout_news_test',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate atlas.signal_queue, atlas.dead_letter, atlas.signals cascade');
  });

  it('inserts once, dedupes on re-run, and does not re-enqueue a completed signal', async () => {
    const fetcher = fetcherFor([articleItem, postItem]);

    const first = await runScoutOnce({ pool, fetcher, now: () => new Date('2026-10-26T09:00:00.000Z') });
    expect(first).toEqual({ fetched: 2, mapped: 2, invalid: 0, inserted: 2, duplicates: 0 });

    const afterFirst = await pool.query<{ signal_id: string; type: string }>(
      'select signal_id, type from atlas.signals order by signal_id',
    );
    expect(afterFirst.rows).toHaveLength(2);
    expect(new Set(afterFirst.rows.map((row) => row.type))).toEqual(new Set(['news', 'post']));

    const queueAfterFirst = await pool.query<{ signal_id: string; max_attempts: string }>(
      'select signal_id, max_attempts from atlas.signal_queue order by signal_id',
    );
    expect(queueAfterFirst.rows).toHaveLength(2);
    for (const row of queueAfterFirst.rows) {
      expect(row.max_attempts).toBe('3');
    }

    // Same items again: no new signal, no new queue row.
    const second = await runScoutOnce({ pool, fetcher, now: () => new Date('2026-10-26T09:05:00.000Z') });
    expect(second).toEqual({ fetched: 2, mapped: 2, invalid: 0, inserted: 0, duplicates: 2 });
    expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signals')).rows[0]!.count).toBe(2);
    expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signal_queue')).rows[0]!.count).toBe(2);

    // A completed queue row must not come back on the next run.
    const client = await pool.connect();
    try {
      const claimed = await claim(client);
      expect(claimed).toHaveLength(2);
      for (const row of claimed) {
        expect(await complete(client, row.id, row.lease_token)).toBe(true);
      }
    } finally {
      client.release();
    }

    const third = await runScoutOnce({ pool, fetcher, now: () => new Date('2026-10-26T09:10:00.000Z') });
    expect(third.inserted).toBe(0);
    expect(third.duplicates).toBe(2);
    expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signals')).rows[0]!.count).toBe(2);
    expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signal_queue')).rows[0]!.count).toBe(0);
  });

  it('skips and counts items that fail to map into a valid signal', async () => {
    // An item whose URL is not a valid absolute URL cannot satisfy the
    // contracts schema (link/source_id must be a URL) and is counted, not stored.
    const brokenItem: NewsFeedItem = { ...postItem, url: 'not a url' };

    const counts = await runScoutOnce({
      pool,
      fetcher: fetcherFor([postItem, brokenItem]),
      now: () => new Date('2026-10-26T09:00:00.000Z'),
    });
    expect(counts).toEqual({ fetched: 2, mapped: 1, invalid: 1, inserted: 1, duplicates: 0 });

    // The broken item and the good item share no source_id, so exactly one signal exists.
    const signals = await pool.query<{ source_id: string }>('select source_id from atlas.signals');
    expect(signals.rows.map((row) => row.source_id)).toEqual([postItem.url]);
  });

  it('retakes an expired lease and fences the old token', { timeout: 15_000 }, async () => {
    await runScoutOnce({ pool, fetcher: fetcherFor([articleItem]), now: () => new Date('2026-10-26T09:00:00.000Z') });

    const client = await pool.connect();
    try {
      const firstLease = await claim(client, 10, '1 second');
      expect(firstLease).toHaveLength(1);
      const original = firstLease[0]!;
      expect(original.ref_id).toBe(signalId('tokens_xyz', articleItem.url));
      expect(original.attempts).toBe('1');

      await sleep(1500);

      const retaken = await claim(client, 10, '5 minutes');
      expect(retaken).toHaveLength(1);
      const fresh = retaken[0]!;
      expect(fresh.id).toBe(original.id);
      expect(fresh.ref_id).toBe(original.ref_id);
      expect(fresh.lease_token).not.toBe(original.lease_token);
      expect(fresh.attempts).toBe('2');

      expect(await complete(client, original.id, original.lease_token)).toBe(false);
      expect(await complete(client, fresh.id, fresh.lease_token)).toBe(true);
      expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signal_queue')).rows[0]!.count).toBe(0);
    } finally {
      client.release();
    }
  });

  it('dead-letters a signal after max_attempts failures and empties the queue', async () => {
    await runScoutOnce({ pool, fetcher: fetcherFor([postItem]), now: () => new Date('2026-10-26T09:00:00.000Z') });

    const client = await pool.connect();
    try {
      const outcomes = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = await claim(client);
        expect(claimed).toHaveLength(1);
        const row = claimed[0]!;
        outcomes.push(await fail(client, row.id, row.lease_token, 'worker exploded ' + attempt, '0 seconds'));
      }
      expect(outcomes).toEqual(['retry', 'retry', 'dead_letter']);
    } finally {
      client.release();
    }

    const deadRows = await pool.query<{ queue_name: string; ref_id: string; attempts: string; last_error: string | null }>(
      'select queue_name, ref_id, attempts, last_error from atlas.dead_letter',
    );
    expect(deadRows.rows).toHaveLength(1);
    const dead = deadRows.rows[0]!;
    expect(dead.queue_name).toBe('signal_queue');
    expect(dead.ref_id).toBe(signalId('tokens_xyz', postItem.url));
    expect(dead.attempts).toBe('3');
    expect(dead.last_error).toBe('worker exploded 3');

    expect((await pool.query<{ count: number }>('select count(*)::int as count from atlas.signal_queue')).rows[0]!.count).toBe(0);
  });
});