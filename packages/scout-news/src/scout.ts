/**
 * The scout run: fetch the tokens.xyz feed ONCE, map every usable item to a
 * V4 Signal, and insert through the Supabase client. The insert is the
 * handoff to the analyst (status 'received', unclaimed, due); there is no
 * queue row, no enqueue stamp and no sweep. Pure orchestration — the fetcher
 * is injectable for tests, the db client handles all DB behavior.
 */
import type { Signal } from '@myboon/contracts';
import type { AtlasDb } from './store.js';
import { insertSignals } from './store.js';
import { fetchFeed } from '@myboon/shared/news-feed';

import { NEWS_SIGNAL_SOURCE, feedItemToSignal } from './map.js';

export interface ScoutCounts {
  fetched: number;
  mapped: number;
  invalid: number;
  inserted: number;
  duplicates: number;
}

export interface RunScoutOnceOptions {
  db: AtlasDb;
  /** Defaults to the shared tokens.xyz client; inject a fake in tests. */
  fetcher?: typeof fetchFeed;
  /** Defaults to wall clock; inject for deterministic runs. */
  now?: () => Date;
}

/**
 * Fetch, map (skipping and counting items that fail `feedItemToSignal`),
 * store. Throws when the feed fetch or the store call fails; returns the
 * counts. One JSON line per run is logged, the operational record of a scout
 * pass.
 */
export async function runScoutOnce({ db, fetcher = fetchFeed, now = () => new Date() }: RunScoutOnceOptions): Promise<ScoutCounts> {
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

  const { inserted, duplicates } = await insertSignals(db, signals);

  const counts: ScoutCounts = {
    fetched: feed.items.length,
    mapped: signals.length,
    invalid,
    inserted,
    duplicates,
  };
  console.log(
    JSON.stringify({ run: 'scout_news_once', source: NEWS_SIGNAL_SOURCE, ...counts }),
  );
  return counts;
}