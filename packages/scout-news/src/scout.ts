/**
 * The scout run: first heal anything the previous run inserted but never
 * enqueued (sweepUnqueued), then fetch the tokens.xyz feed ONCE, map every
 * usable item to a V4 Signal, and insert + enqueue + stamp through the
 * Supabase client. Pure orchestration — the fetcher is injectable for tests,
 * the db client handles all DB behavior.
 */
import type { Signal } from '@myboon/contracts';
import type { AtlasDb } from './store.js';
import { insertSignals, sweepUnqueued } from './store.js';
import { fetchFeed } from '@myboon/shared/news-feed';

import { NEWS_SIGNAL_SOURCE, feedItemToSignal } from './map.js';

export interface ScoutCounts {
  fetched: number;
  mapped: number;
  invalid: number;
  inserted: number;
  duplicates: number;
  enqueued: number;
  /** Crash-recovery sweep: signals re-enqueued by sweepUnqueued this run. */
  swept: number;
}

export interface RunScoutOnceOptions {
  db: AtlasDb;
  /** Defaults to the shared tokens.xyz client; inject a fake in tests. */
  fetcher?: typeof fetchFeed;
  /** Defaults to wall clock; inject for deterministic runs. */
  now?: () => Date;
}

/**
 * Sweep, fetch, map (skipping and counting items that fail
 * `feedItemToSignal`), store. Throws when the sweep, the feed fetch or the
 * store calls fail; returns the counts. The sweep opens the run so a crash
 * from a previous pass is repaired before fresh work starts.
 */
export async function runScoutOnce({ db, fetcher = fetchFeed, now = () => new Date() }: RunScoutOnceOptions): Promise<ScoutCounts> {
  // Heal first: re-enqueue and stamp the signals the last run left unstamped
  // (a crash after the signals insert). Nothing new is fetched until the
  // heal is done, so the stranded set never grows.
  const { enqueued: swept } = await sweepUnqueued(db, now());

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

  const { inserted, duplicates, enqueued } = await insertSignals(db, signals);

  const counts: ScoutCounts = {
    fetched: feed.items.length,
    mapped: signals.length,
    invalid,
    inserted,
    duplicates,
    enqueued,
    swept,
  };
  // One JSON line per run, the operational record of a scout pass.
  console.log(
    JSON.stringify({ run: 'scout_news_once', source: NEWS_SIGNAL_SOURCE, ...counts }),
  );
  return counts;
}