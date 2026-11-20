/**
 * Tests for the saved Feed Home section copies (issue #416): the versioned
 * envelope in `feed-section-cache.ts` — write/read, the 24-hour expiry, corrupt
 * /wrong-version/wrong-shape handling, no-throw storage failures, and the
 * render-time stale-price pass. The hook-side flow (hydration, the guaranteed
 * first fresh fetch, the press-held swap) lives in feed-data.test.tsx.
 *
 * Run: pnpm --filter hybrid-expo test:feed
 *
 * AsyncStorage is a native module and cannot load under `tsx`, so it is
 * replaced in `require.cache` before `feed-section-cache.ts` is loaded, the
 * same way features/chain/activation.test.ts stubs it. The backing is a real
 * key/value map, not a spy: asserting only on calls would pass even if nothing
 * were ever read back, which is the exact failure these cases exist to catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoryMarket } from '@myboon/shared/stories';
import type { StorySummary } from './feed.types';
import { pricedMarkets } from './feed-mosaic';

/**
 * Backing store, deliberately *outside* the module cache: the module can be
 * re-loaded freely while what is "on disk" survives.
 */
const disk = new Map<string, string>();
let failNextRead = false;
let failNextWrite = false;

const asyncStorageId = require.resolve('@react-native-async-storage/async-storage');
require.cache[asyncStorageId] = {
  id: asyncStorageId,
  filename: asyncStorageId,
  loaded: true,
  exports: {
    __esModule: true,
    default: {
      getItem: async (key: string) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('simulated storage read failure');
        }
        return disk.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('simulated storage write failure');
        }
        disk.set(key, value);
      },
      removeItem: async (key: string) => {
        disk.delete(key);
      },
    },
  },
} as never;

type CacheModule = typeof import('./feed-section-cache');

const CACHE_MODULE_PATH = require.resolve('./feed-section-cache');

// `require` rather than `import` so the evaluation above — the stub entry — is
// guaranteed to precede the module's first use of AsyncStorage.
const cache = require(CACHE_MODULE_PATH) as CacheModule;

const { FEED_HOME_STORAGE_KEYS, PRICE_STALE_MS } = cache;

function reset() {
  disk.clear();
  failNextRead = false;
  failNextWrite = false;
}

function market(overrides: Partial<StoryMarket> = {}): StoryMarket {
  return {
    symbol: 'BTC',
    displaySymbol: 'BTC',
    displayName: 'Bitcoin',
    rank: 1,
    price: 100,
    change24hPct: 2.5,
    asOf: '2026-11-20T12:00:00Z',
    ...overrides,
  };
}

function story(markets: StoryMarket[]): StorySummary {
  return {
    storySlug: 'fed-decision',
    name: 'Fed decision',
    latestDevelopment: 'Rate held at 4%',
    eventCount: 21,
    updatedAt: '2026-11-20T12:00:00Z',
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
    markets,
  };
}

test('a successful payload round-trips, including an empty list', async () => {
  reset();
  const now = 1_763_600_000_000;
  await cache.writeSectionCache(FEED_HOME_STORAGE_KEYS.updates, ['first', 'second'], now);
  const envelope = JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { version: number; savedAt: number; payload: string[] };
  assert.equal(envelope.version, 1);
  assert.equal(envelope.savedAt, now);
  assert.deepEqual(envelope.payload, ['first', 'second']);
  assert.deepEqual(await cache.readSectionCache<string[]>(FEED_HOME_STORAGE_KEYS.updates, now + 1), ['first', 'second']);

  await cache.writeSectionCache(FEED_HOME_STORAGE_KEYS.updates, [], now);
  assert.deepEqual(await cache.readSectionCache<string[]>(FEED_HOME_STORAGE_KEYS.updates, now + 1), []);
});

test('a copy is shown for exactly 24 hours, then ignored and removed', async () => {
  reset();
  const key = FEED_HOME_STORAGE_KEYS.stories;
  await cache.writeSectionCache(key, ['story'], 0);
  assert.deepEqual(await cache.readSectionCache<string[]>(key, 24 * 60 * 60 * 1000), ['story']);
  assert.ok(disk.has(key));
  assert.equal(await cache.readSectionCache<string[]>(key, 24 * 60 * 60 * 1000 + 1), null);
  assert.equal(disk.has(key), false);
});

test('corrupt JSON, a bad envelope, a different key version, and a missing savedAt are no copy and are removed', async () => {
  reset();
  const key = 'feed.home.calendar.v1';
  const unreadable: string[] = [
    'not json at all{',
    'null',
    '42',
    JSON.stringify({ version: 1, savedAt: 0 }), // no payload
    JSON.stringify({ version: 1, payload: [] }), // missing savedAt
    JSON.stringify({ version: 1, savedAt: null, payload: [] }), // savedAt not a number
    JSON.stringify({ version: 2, savedAt: 0, payload: [] }), // a different key version
    JSON.stringify({ version: 1, savedAt: 0, payload: undefined }), // payload gone in transit
  ];
  for (const raw of unreadable) {
    disk.set(key, raw);
    await assert.doesNotReject(cache.readSectionCache<string[]>(key, 1_000));
    assert.equal(await cache.readSectionCache<string[]>(key, 1_000), null, raw);
    assert.equal(disk.has(key), false, raw);
  }
});

test('a storage read failure is no copy, keeps the bytes, and does not throw', async () => {
  reset();
  await cache.writeSectionCache(FEED_HOME_STORAGE_KEYS.updates, ['kept'], 0);
  failNextRead = true;
  assert.equal(await cache.readSectionCache<string[]>(FEED_HOME_STORAGE_KEYS.updates, 1_000), null);
  assert.ok(disk.has(FEED_HOME_STORAGE_KEYS.updates));
});

test('a failed write does not throw and does not overwrite the saved copy', async () => {
  reset();
  await cache.writeSectionCache(FEED_HOME_STORAGE_KEYS.updates, ['older'], 0);
  failNextWrite = true;
  await assert.doesNotReject(cache.writeSectionCache(FEED_HOME_STORAGE_KEYS.updates, ['newer'], 5));
  assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { payload: string[] }).payload, ['older']);
  failNextWrite = false;
});

test('memory-only callers pass no key and never touch storage', async () => {
  reset();
  await assert.doesNotReject(cache.writeSectionCache(undefined, ['ignored'], 0));
  assert.equal(disk.size, 0);
});

test('exactly 15-minute-old market snapshots keep their move; older, missing, and unreadable ones lose it', () => {
  reset();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const boundary = story([market({ asOf: new Date(now - PRICE_STALE_MS).toISOString() })]);
  const kept = cache.dropStaleMarketPrices([boundary], now);
  assert.deepEqual(kept, [boundary]); // untouched — same story, not even shallow-copied
  assert.equal(kept[0].markets[0].price, 100);
  assert.equal(kept[0].markets[0].change24hPct, 2.5);
  assert.deepEqual(pricedMarkets(kept[0]), kept[0].markets);

  const staleAsOf = new Date(now - PRICE_STALE_MS - 1).toISOString();
  const stale = story([market({ asOf: staleAsOf })]);
  const dropped = cache.dropStaleMarketPrices([stale], now);
  const [renderedMarket] = dropped[0].markets;
  assert.equal(renderedMarket.price, null);
  assert.equal(renderedMarket.change24hPct, null);
  assert.equal(renderedMarket.asOf, null);
  // The tile itself still shows.
  assert.equal(dropped[0].name, 'Fed decision');
  assert.equal(dropped[0].latestDevelopment, 'Rate held at 4%');
  assert.equal(dropped[0].eventCount, 21);
  assert.equal(dropped[0].updatedAt, '2026-11-20T12:00:00Z');
  assert.deepEqual(pricedMarkets(dropped[0]), []);
  // The value kept in the hook and the stored copy are not mutated.
  assert.equal(stale.markets[0].price, 100);
  assert.equal(stale.markets[0].change24hPct, 2.5);
  assert.equal(stale.markets[0].asOf, staleAsOf);
});

test('a snapshot without a readable asOf is stale, an already-hidden market is passed through, and only stale markets are nulled', () => {
  reset();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const fresh = new Date(now - PRICE_STALE_MS + 1_000).toISOString();
  const freshNoAsOf = story([market({ asOf: null })]);
  const unreadableAsOf = story([market({ asOf: 'not-a-timestamp' })]);
  const alreadyHidden = story([market({ price: null, change24hPct: null, asOf: null })]);
  const mixed = story([market({ asOf: fresh, rank: 1 }), market({ asOf: new Date(now - 16 * 60 * 1000).toISOString(), rank: 2 })]);

  const out = cache.dropStaleMarketPrices([freshNoAsOf, unreadableAsOf, alreadyHidden, mixed], now);
  assert.deepEqual(out[0].markets[0], { ...freshNoAsOf.markets[0], price: null, change24hPct: null, asOf: null });
  assert.deepEqual(out[1].markets[0], { ...unreadableAsOf.markets[0], price: null, change24hPct: null, asOf: null });
  assert.equal(out[2], alreadyHidden); // a priceless market has nothing to hide
  assert.equal(out[3].markets[0].price, 100); // the fresh snapshot keeps its move
  assert.equal(out[3].markets[1].price, null); // only the stale one is dropped
  assert.deepEqual(pricedMarkets(out[3]), [out[3].markets[0]]);
  // Inputs untouched.
  assert.equal(freshNoAsOf.markets[0].price, 100);
  assert.equal(unreadableAsOf.markets[0].price, 100);
  assert.equal(mixed.markets[1].price, 100);
});
