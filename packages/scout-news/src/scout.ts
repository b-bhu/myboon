/**
 * The scout run: fetch the tokens.xyz feed ONCE, map every usable item to a
 * V4 Signal, then insert + enqueue in one transaction. Pure orchestration —
 * the fetcher is injectable for tests, the client handles all DB behavior.
 */
import { Pool } from 'pg';
import { fetchFeed } from '@myboon/shared/news-feed';

import { NEWS_SIGNAL_SOURCE, feedItemToSignal } from './map.js';
import { insertSignals } from './store.js';
import type { Signal } from '@myboon/contracts';

export interface ScoutCounts {
  fetched: number;
  mapped: number;
  invalid: number;
  inserted: number;
  duplicates: number;
}

export interface RunScoutOnceOptions {
  pool: Pool;
  /** Defaults to the shared tokens.xyz client; inject a fake in tests. */
  fetcher?: typeof fetchFeed;
  /** Defaults to wall clock; inject for deterministic runs. */
  now?: () => Date;
}

/**
 * Fetch, map (skipping and counting items that fail `parseSignal`), store.
 * Throws when the feed fetch or the transaction fails; returns the counts.
 */
export async function runScoutOnce({ pool, fetcher = fetchFeed, now = () => new Date() }: RunScoutOnceOptions): Promise<ScoutCounts> {
  const fetchedAt = now();
  const feed = await fetcher({ limit: 50 });

  const signals: Signal[] = [];
  let invalid = 0;
  for (const item of feed.items) {
    try {
      signals.push(feedItemToSignal(item, fetchedAt));
    } catch {
      invalid += 1;
    }
  }

  const client = await pool.connect();
  let inserted: number;
  let duplicates: number;
  try {
    ({ inserted, duplicates } = await insertSignals(client, signals));
  } finally {
    client.release();
  }

  const counts: ScoutCounts = {
    fetched: feed.items.length,
    mapped: signals.length,
    invalid,
    inserted,
    duplicates,
  };
  // One JSON line per run, the operational record of a scout pass.
  console.log(
    JSON.stringify({ run: 'scout_news_once', source: NEWS_SIGNAL_SOURCE, ...counts }),
  );
  return counts;
}