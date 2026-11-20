/**
 * The last successful payload of a Feed Home section, saved on device (issue #416).
 *
 * Feed Home renders three sections that each load through `useFeedSection`,
 * which keeps its payload only in memory. Persisting each Home section's
 * payload in AsyncStorage lets a cold open show the last saved copy as soon as
 * the on-device read returns instead of a loading placeholder, and then quietly
 * swap in the fresh response. Persistence is opt-in: only the Home sections
 * pass a versioned `storageKey`, every other `useFeedSection` caller stays
 * memory-only.
 *
 * Envelope: `{ version, savedAt, payload }` under a versioned key, so a later
 * shape change never reads old bytes. A copy is shown for 24 hours at most.
 * Corrupt, wrong-shape, wrong-version, or expired copies are treated as no copy
 * and removed. A failed storage read or write never throws — persistence must
 * not break the UI, and a thrown fetch never overwrites the saved copy.
 */

import type { StorySummary } from './feed.types';

/** Versioned AsyncStorage keys for the three Feed Home sections. */
export const FEED_HOME_STORAGE_KEYS = {
  updates: 'feed.home.updates.v1',
  stories: 'feed.home.stories.v1',
  calendar: 'feed.home.calendar.v1',
} as const;

/** A saved copy may be shown for at most 24 hours after it was saved (issue #416). */
export const SAVED_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Same freshness bar as the API's quotes: a snapshot older than 15 minutes hides the move. */
export const PRICE_STALE_MS = 15 * 60 * 1000;

const ENVELOPE_VERSION = 1;

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * AsyncStorage is a native module and cannot load under `tsx`, so it is
 * resolved only when a persistence call actually runs — a memory-only section
 * (and the plain `feed-data.test.tsx` harness) never touches it. The test
 * stubs (features/chain/activation.test.ts pattern) intercept through
 * `require.cache` at call time.
 */
function storage(): AsyncStorageLike {
  const mod = require('@react-native-async-storage/async-storage') as { default?: AsyncStorageLike };
  return (mod.default ?? mod) as AsyncStorageLike;
}

/** What was last successfully loaded for a section, and when. */
interface SectionEnvelope<T> {
  version: number;
  savedAt: number;
  payload: T;
}

/**
 * Saves a successful result for future cold starts. Includes empty payloads.
 * Never throws: a failed write must not break the UI.
 */
export async function writeSectionCache<T>(key: string | undefined, payload: T, now: number = Date.now()): Promise<void> {
  if (!key) return;
  const envelope: SectionEnvelope<T> = { version: ENVELOPE_VERSION, savedAt: now, payload };
  try {
    await storage().setItem(key, JSON.stringify(envelope));
  } catch {
    // A failed write must not break the UI.
  }
}

/**
 * Returns the saved payload when the envelope is readable and at most 24 hours
 * old; otherwise null. Corrupt, wrong-shape, wrong-version, or expired copies
 * are removed on read. A storage read failure is treated as no copy and keeps
 * the bytes. Exactly 24 hours still shows.
 */
export async function readSectionCache<T>(key: string, now: number = Date.now()): Promise<T | null> {
  let raw: string | null;
  try {
    raw = await storage().getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    void removeSectionCache(key);
    return null;
  }
  const payload = usablePayload<T>(envelope, now);
  if (payload !== null) return payload;
  void removeSectionCache(key);
  return null;
}

/** Removes the saved copy; a failed removal must not break the UI. */
async function removeSectionCache(key: string): Promise<void> {
  try { await storage().removeItem(key); } catch { /* never breaks the UI */ }
}

/** Shallow envelope check; anything unreadable, wrong-version, wrongly shaped, or expired is no copy. */
function usablePayload<T>(envelope: unknown, now: number): T | null {
  if (!isRecord(envelope)) return null;
  if (envelope.version !== ENVELOPE_VERSION) return null;
  const savedAt = envelope.savedAt;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (now - savedAt > SAVED_COPY_MAX_AGE_MS) return null; // exactly 24 hours still shows
  if (!('payload' in envelope)) return null;
  return envelope.payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies the API's price-staleness rule to a list of stories at render time
 * (issue #416): a market whose `asOf` is missing, unparseable, or older than 15
 * minutes loses its move, exactly as `quoteFor` does server-side
 * (`packages/api/src/hyperliquid.ts`, `PRICE_STALE_MS = 15 * 60 * 1000`).
 *
 * Nothing on screen is mutated: the input stories (the hook's copy and the
 * stored copy) are left as they are, each stale market is nulled on a shallow
 * copy, and a story with nothing to change is passed through untouched, so a
 * rendered story tile itself stays while `pricedMarkets` drops its move.
 */
export function dropStaleMarketPrices(stories: readonly StorySummary[], now: number): StorySummary[] {
  return stories.map((story) => {
    if (!Array.isArray(story.markets) || story.markets.length === 0) return story;
    let changed = false;
    const markets = story.markets.map((market) => {
      if (market.price === null) return market;
      const snapshotMs = market.asOf == null ? Number.NaN : Date.parse(market.asOf);
      const stale = !Number.isFinite(snapshotMs) || now - snapshotMs > PRICE_STALE_MS;
      if (!stale) return market;
      changed = true;
      return { ...market, price: null, change24hPct: null, asOf: null };
    });
    return changed ? { ...story, markets } : story;
  });
}
