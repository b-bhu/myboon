/**
 * Integration checks against a real database with the atlas migrations
 * (20261025100000_atlas_core, 20261025100100_atlas_queues) applied.
 *
 * PostgREST is not run locally, so these tests exercise — with `pg` against a
 * disposable Postgres — the exact DB-side behavior the scout's three Supabase
 * upserts/writes (store.ts) and the queue rpc wrappers (queue.ts) rely on:
 * `insert ... on conflict (source, source_id) do nothing returning
 * signal_id`, the enqueue with max_attempts 3, the enqueued_at stamp (see the
 * sweep select below), and the atlas.queue_* functions. The exact PostgREST
 * call shapes and the error paths are covered against fakes in store.test.ts,
 * scout.test.ts and queue.test.ts instead.
 *
 * Point SCOUT_TEST_DATABASE_URL at a DISPOSABLE database: every test
 * truncates atlas.signal_queue, atlas.dead_letter and atlas.signals
 * (cascade) first. When the variable is unset the whole describe is skipped.
 * No upstream is contacted — signals are mapped from local fixtures with
 * feedItemToSignal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { signalId } from '@myboon/contracts';
import type { Signal } from '@myboon/contracts';
import type { NewsFeedArticle, NewsFeedPost } from '@myboon/shared/news-feed';

import { feedItemToSignal } from './map.js';
import { SWEEP_LIMIT, SWEEP_LOOKBACK_MS } from './store.js';

const TEST_DATABASE_URL = process.env.SCOUT_TEST_DATABASE_URL?.trim() ?? '';

/**
 * The DB side of the scout's two Supabase calls (store.ts): the signals
 * upsert compiles to `insert ... on conflict (source, source_id) do nothing
 * returning signal_id` (the id-only read-back), and the queue upsert keeps
 * max_attempts 3 fixed.
 */
const SQL_INSERT_SIGNAL = `insert into atlas.signals
  (signal_id, schema_version, source, source_id, type, priority, occurred_at, fetched_at, text, numbers, link, raw_ids, unusual_score, excerpt, raw_hash)
values
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (source, source_id) do nothing
returning signal_id`;

const SQL_ENQUEUE_SIGNAL = `insert into atlas.signal_queue (signal_id, priority, max_attempts)
values ($1, $2, 3)
on conflict (signal_id) do nothing`;

/** The DB side of sweepUnqueued's select (store.ts): recent rows still missing the enqueued_at stamp. */
const SQL_SWEEP_SELECT = `select signal_id
from atlas.signals
where enqueued_at is null
  and created_at > $1
order by signal_id
limit ${SWEEP_LIMIT}`;

/** The marker the sweep and insertSignals' stamp write: enqueued_at on unstamped rows. */
const SQL_STAMP_ENQUEUED = `update atlas.signals set enqueued_at = $1 where signal_id = $2`;

/** The atlas.queue_* functions the rpc wrappers in queue.ts call. */
const SQL_CLAIM = `select * from atlas.queue_claim('signal_queue', $1, $2::interval)`;
const SQL_HEARTBEAT = `select atlas.queue_heartbeat('signal_queue', $1, $2, $3::interval) as ok`;
const SQL_COMPLETE = `select atlas.queue_complete('signal_queue', $1, $2) as ok`;
const SQL_FAIL = `select atlas.queue_fail('signal_queue', $1, $2, $3, $4::interval) as outcome`;

/** A queue_claim row as node-postgres returns it: bigint as string, timestamptz as Date. */
type ClaimedRow = {
  id: string;
  ref_id: string;
  attempts: string;
  lease_token: string;
  lease_expires_at: Date;
};

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(TEST_DATABASE_URL === '')('scout-news DB-side behavior against a real database', () => {
  let pool: Pool;
  const fetchedAt = new Date('2026-10-26T09:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 2,
      application_name: 'myboon_scout_news_test',
    });
    // atlas.signals.enqueued_at is added on the live databases separately
    // (timestamptz null); a disposable test database built from the atlas
    // migrations may predate it, so the suite adds the column itself. This
    // ALTER is test-only — the scout package ships no migrations.
    await pool.query('alter table atlas.signals add column if not exists enqueued_at timestamptz');
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('truncate atlas.signal_queue, atlas.dead_letter, atlas.signals cascade');
  });

  /** insertSignals step 1 on the DB: return only the signal_ids this pass newly inserted. */
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

  /** insertSignals step 2 on the DB: enqueue the returned ids with max_attempts 3. */
  async function enqueueDirectly(signals: Signal[], ids: string[]): Promise<void> {
    const priorityById = new Map(signals.map((signal) => [signal.signal_id, signal.priority]));
    for (const id of ids) {
      await pool.query(SQL_ENQUEUE_SIGNAL, [id, priorityById.get(id) ?? 0]);
    }
  }

  async function claimRows(limit: number, lease: string): Promise<ClaimedRow[]> {
    const result = await pool.query<ClaimedRow>(SQL_CLAIM, [limit, lease]);
    return result.rows;
  }

  async function queueCount(): Promise<number> {
    return (await pool.query<{ count: number }>('select count(*)::int as count from atlas.signal_queue')).rows[0]!.count;
  }

  it('inserts once (returning signal_id), dedupes on re-run, and never re-enqueues a completed signal', async () => {
    const signals = [feedItemToSignal(articleItem, fetchedAt), feedItemToSignal(postItem, fetchedAt)];

    // First pass: both inserts return their signal_id and both get enqueued with max_attempts 3.
    const firstIds = await insertSignalsDirectly(signals);
    expect(firstIds).toEqual(signals.map((signal) => signal.signal_id));
    await enqueueDirectly(signals, firstIds);

    const stored = await pool.query<{ signal_id: string; type: string }>(
      'select signal_id, type from atlas.signals order by signal_id',
    );
    expect(stored.rows).toHaveLength(2);
    expect(new Set(stored.rows.map((row) => row.type))).toEqual(new Set(['news', 'post']));

    const queue = await pool.query<{ signal_id: string; priority: string; max_attempts: string }>(
      'select signal_id, priority, max_attempts from atlas.signal_queue order by signal_id',
    );
    expect(queue.rows).toHaveLength(2);
    for (const row of queue.rows) {
      expect(row.priority).toBe('0');
      expect(row.max_attempts).toBe('3');
    }

    // Second pass with the same items: the conflict is skipped, nothing comes
    // back, and the existing queue rows stay untouched.
    const secondIds = await insertSignalsDirectly(signals);
    expect(secondIds).toEqual([]);
    expect(await queueCount()).toBe(2);

    // A completed queue row does not come back either: still no signal_id on
    // the third pass (an already-present signal is not re-enqueued).
    const claimed = await claimRows(10, '5 minutes');
    expect(claimed).toHaveLength(2);
    for (const row of claimed) {
      const completed = await pool.query<{ ok: boolean }>(SQL_COMPLETE, [row.id, row.lease_token]);
      expect(completed.rows[0]?.ok).toBe(true);
    }
    const thirdIds = await insertSignalsDirectly(signals);
    expect(thirdIds).toEqual([]);
    expect(await queueCount()).toBe(0);
    expect(
      (await pool.query<{ count: number }>('select count(*)::int as count from atlas.signals')).rows[0]!.count,
    ).toBe(2);
  });

  it('retakes an expired lease and fences the old token', { timeout: 15_000 }, async () => {
    const signals = [feedItemToSignal(articleItem, fetchedAt)];
    const ids = await insertSignalsDirectly(signals);
    expect(ids).toHaveLength(1);
    await enqueueDirectly(signals, ids);

    const firstLease = await claimRows(10, '1 second');
    expect(firstLease).toHaveLength(1);
    const original = firstLease[0]!;
    expect(original.ref_id).toBe(signalId('tokens_xyz', articleItem.url));
    expect(original.attempts).toBe('1');

    await sleep(1500);

    const retaken = await claimRows(10, '5 minutes');
    expect(retaken).toHaveLength(1);
    const fresh = retaken[0]!;
    expect(fresh.id).toBe(original.id);
    expect(fresh.ref_id).toBe(original.ref_id);
    expect(fresh.lease_token).not.toBe(original.lease_token);
    expect(fresh.attempts).toBe('2');

    const fencedHeartbeat = await pool.query<{ ok: boolean }>(SQL_HEARTBEAT, [original.id, original.lease_token, '5 minutes']);
    expect(fencedHeartbeat.rows[0]?.ok).toBe(false);
    const fencedComplete = await pool.query<{ ok: boolean }>(SQL_COMPLETE, [original.id, original.lease_token]);
    expect(fencedComplete.rows[0]?.ok).toBe(false);
    const freshComplete = await pool.query<{ ok: boolean }>(SQL_COMPLETE, [fresh.id, fresh.lease_token]);
    expect(freshComplete.rows[0]?.ok).toBe(true);
    expect(await queueCount()).toBe(0);
  });

  it('dead-letters a signal after max_attempts failures and empties the queue', async () => {
    const signals = [feedItemToSignal(postItem, fetchedAt)];
    const ids = await insertSignalsDirectly(signals);
    expect(ids).toHaveLength(1);
    await enqueueDirectly(signals, ids);

    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimRows(10, '5 minutes');
      expect(claimed).toHaveLength(1);
      const row = claimed[0]!;
      const failed = await pool.query<{ outcome: string }>(SQL_FAIL, [
        row.id,
        row.lease_token,
        'worker exploded ' + attempt,
        '0 seconds',
      ]);
      outcomes.push(failed.rows[0]?.outcome ?? '');
    }
    expect(outcomes).toEqual(['retry', 'retry', 'dead_letter']);

    const deadRows = await pool.query<{ queue_name: string; ref_id: string; attempts: string; last_error: string | null }>(
      'select queue_name, ref_id, attempts, last_error from atlas.dead_letter',
    );
    expect(deadRows.rows).toHaveLength(1);
    const dead = deadRows.rows[0]!;
    expect(dead.queue_name).toBe('signal_queue');
    expect(dead.ref_id).toBe(signalId('tokens_xyz', postItem.url));
    expect(dead.attempts).toBe('3');
    expect(dead.last_error).toBe('worker exploded 3');

    expect(await queueCount()).toBe(0);
  });

  it('sweep SQL finds a recent unstamped signal and skips a finished one', async () => {
    // A finished signal: as recent as the crashed one, but it keeps enqueued_at
    // set (the stamp from its original run) even though no queue row is left.
    // The stamp is what keeps it out of the sweep, not its age.
    const finished = [feedItemToSignal(articleItem, fetchedAt)];
    const finishedIds = await insertSignalsDirectly(finished);
    expect(finishedIds).toHaveLength(1);
    await pool.query(SQL_STAMP_ENQUEUED, [new Date(), finishedIds[0]!]);

    // A crashed signal: inserted seconds ago, never enqueued, never stamped.
    const crashed = [feedItemToSignal(postItem, fetchedAt)];
    const crashedIds = await insertSignalsDirectly(crashed);
    expect(crashedIds).toHaveLength(1);

    const cutoff = new Date(Date.now() - SWEEP_LOOKBACK_MS);
    const found = await pool.query<{ signal_id: string }>(SQL_SWEEP_SELECT, [cutoff]);
    expect(found.rows.map((row) => row.signal_id)).toEqual([crashedIds[0]!]);

    // After the sweep's enqueue + stamp run for the crashed row, it leaves
    // the sweep too — with both rows stamped, a re-run selects nothing.
    await enqueueDirectly(crashed, crashedIds);
    await pool.query(SQL_STAMP_ENQUEUED, [new Date(), crashedIds[0]!]);
    const refound = await pool.query<{ signal_id: string }>(SQL_SWEEP_SELECT, [cutoff]);
    expect(refound.rows).toHaveLength(0);
  });
});