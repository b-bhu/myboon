/**
 * Integration checks against a real database with the atlas migrations
 * applied, INCLUDING 20261027120000_atlas_signal_status (issue #478):
 *
 * PostgREST is not run locally, so these tests exercise — with `pg` against a
 * disposable Postgres — the exact DB-side behavior the scout's one Supabase
 * upsert (store.ts) relies on: `insert ... on conflict (source, source_id) do
 * nothing returning signal_id`, and the handoff itself: the committed signal
 * lands as status 'received', unclaimed and due, with no enqueued_at column,
 * no signal_queue table and queue_* refusing the signal queue. The error
 * paths are covered against fakes in store.test.ts and scout.test.ts.
 *
 * Point SCOUT_TEST_DATABASE_URL at a DISPOSABLE database: every test
 * truncates atlas.signals (cascade) first. When the variable is unset the
 * whole describe is skipped. No upstream is contacted — signals are mapped
 * from local fixtures with feedItemToSignal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { signalId } from '@myboon/contracts';
import type { Signal } from '@myboon/contracts';
import type { NewsFeedArticle, NewsFeedPost } from '@myboon/shared/news-feed';

import { feedItemToSignal } from './map.js';

const TEST_DATABASE_URL = process.env.SCOUT_TEST_DATABASE_URL?.trim() ?? '';

/**
 * The DB side of the scout's Supabase call (store.ts): the signals upsert
 * compiles to this insert (the id-only read-back).
 */
const SQL_INSERT_SIGNAL = `insert into atlas.signals
  (signal_id, schema_version, source, source_id, type, priority, occurred_at, fetched_at, text, numbers, link, raw_ids, unusual_score, excerpt, raw_hash)
values
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (source, source_id) do nothing
returning signal_id`;

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

describe.skipIf(TEST_DATABASE_URL === '')('scout-news DB-side behavior against a real database', () => {
  let pool: Pool;
  const fetchedAt = new Date('2026-10-26T09:00:00.000Z');

  beforeAll(async () => {
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
    await pool.query('truncate atlas.decisions, atlas.item_signals, atlas.signals cascade');
  });

  /** store.ts step on the DB: return only the signal_ids this pass newly inserted. */
  async function insertSignalsDirectly(signals: Signal[]): Promise<string[]> {
    const ids: string[] = [];
    for (const signal of signals) {
      const result = await pool.query<{ signal_id: string }>(SQL_INSERT_SIGNAL, [
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
      if (result.rows[0]) ids.push(result.rows[0].signal_id);
    }
    return ids;
  }

  it('inserts once (returning signal_id) and dedupes on rerun', async () => {
    const signals = [feedItemToSignal(articleItem, fetchedAt), feedItemToSignal(postItem, fetchedAt)];

    const firstIds = await insertSignalsDirectly(signals);
    expect(firstIds).toEqual(signals.map((signal) => signal.signal_id));

    const stored = await pool.query<{ signal_id: string; type: string }>(
      'select signal_id, type from atlas.signals order by signal_id',
    );
    expect(stored.rows).toHaveLength(2);
    expect(new Set(stored.rows.map((row) => row.type))).toEqual(new Set(['news', 'post']));

    const secondIds = await insertSignalsDirectly(signals);
    expect(secondIds).toEqual([]);
  });

  it('the insert is the handoff: received, unclaimed, one decision per signal is free, and the claim loop owns the rest', async () => {
    const signals = [feedItemToSignal(articleItem, fetchedAt), feedItemToSignal(postItem, fetchedAt)];
    const ids = await insertSignalsDirectly(signals);
    expect(ids).toHaveLength(2);

    const states = await pool.query<{ status: string; attempts: string; claimed: string }>(
      `select status, attempts::text,
              (claim_token is null and next_attempt_at <= now()) as claimed
         from atlas.signals where signal_id = any($1)`,
      [ids],
    );
    expect(states.rows).toHaveLength(2);
    for (const row of states.rows) {
      expect(row.status).toBe('received');
      expect(row.attempts).toBe('0');
      expect(row.claimed).toBe(true);
    }

    // No signal_states / jev_decisions / signal_queue revival; the signal
    // queue functions were dropped with decision_queue in #537.
    const tables = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'atlas' and tablename in ('signal_queue','signal_states','jev_decisions')`,
    );
    expect(tables.rows).toHaveLength(0);
    await expect(pool.query(`select atlas.queue_claim('signal_queue', 10, '5 minutes')`)).rejects.toThrow(/function atlas\.queue_claim\(.*\) does not exist/);
    const enqueuedAt = await pool.query<{ count: string }>(
      `select count(*)::text from information_schema.columns
        where table_schema = 'atlas' and table_name = 'signals' and column_name = 'enqueued_at'`,
    );
    expect(enqueuedAt.rows[0]?.count).toBe('0');
  });
});