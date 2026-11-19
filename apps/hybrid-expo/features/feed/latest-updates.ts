import type { LatestUpdate, LatestUpdateSource } from '@myboon/shared/latest-updates';
import { isFeedMocksEnabled } from './feed-mocks';

/** Sample card image. A public https URL, the same hosts the live rows use. */
export const SAMPLE_UPDATE_IMAGE_URL = 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png';

/**
 * Mock switch for the latest-updates feed rows (issue #636).
 * Same rules as EXPO_PUBLIC_FEED_MOCKS: only "1", "true" and "on" turn it on.
 * The literal env read is what Expo inlines. Default is off, so an empty
 * live route stays hidden.
 */
export const LATEST_UPDATES_MOCK_ENV_KEY = 'EXPO_PUBLIC_LATEST_UPDATES_MOCK';

export const LATEST_UPDATES_MOCK = isFeedMocksEnabled(process.env.EXPO_PUBLIC_LATEST_UPDATES_MOCK);

export function isLatestUpdatesMockEnabled(value: string | undefined): boolean {
  return isFeedMocksEnabled(value);
}

const sampleSource = (
  itemId: string,
  title: string,
  link: string,
  occurredAt: string,
): LatestUpdateSource => ({ itemId, title, link, occurredAt });

/**
 * Sample rows for the mock flag. The older row is first on purpose, so a
 * newest-first sort is visible when the flag fills an empty route.
 */
export const LATEST_UPDATE_SAMPLES: readonly LatestUpdate[] = [
  {
    id: 'sample-federal-reserve',
    entitySlug: 'federal-reserve',
    entityName: 'Federal Reserve',
    entityType: 'organization',
    headline: 'Fed minutes leave a December cut on the table',
    whatHappened: 'The latest minutes say most officials still expect another cut this year if inflation keeps easing.',
    howWeGotHere: 'The Fed has already cut twice this year and has been waiting on slower services inflation before moving again.',
    whatToWatch: 'The December meeting, and whether the next CPI print stays under 3 percent.',
    imageUrl: null,
    sources: [
      sampleSource(
        'sample-fed-minutes',
        'FOMC minutes (sample)',
        'https://example.com/fomc-minutes',
        '2026-11-13T18:00:00.000Z',
      ),
    ],
    publishedAt: '2026-11-13T19:00:00.000Z',
  },
  {
    id: 'sample-bitcoin',
    entitySlug: 'bitcoin',
    entityName: 'Bitcoin',
    entityType: 'asset',
    headline: 'Bitcoin holds above $100,000 after a third day of ETF inflows',
    whatHappened: 'US spot bitcoin ETFs took in about $640 million on Thursday, the third straight day of net inflows.',
    howWeGotHere: 'Flows had turned negative in late October, then flipped back after the price found support near $96,000.',
    whatToWatch: 'Whether inflows hold through Friday and the price stays above $100,000.',
    imageUrl: SAMPLE_UPDATE_IMAGE_URL,
    sources: [
      sampleSource(
        'sample-btc-flows',
        'ETF flow desk (sample)',
        'https://example.com/bitcoin-etf-flows',
        '2026-11-14T14:00:00.000Z',
      ),
      sampleSource(
        'sample-btc-price',
        'Price recap (sample)',
        'https://example.com/bitcoin-price',
        '2026-11-14T15:00:00.000Z',
      ),
    ],
    publishedAt: '2026-11-14T16:00:00.000Z',
  },
];

function publishedAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Newest publishedAt first. A tie falls back to id, matching the Feed's stable order. */
export function sortLatestUpdatesNewestFirst<T extends LatestUpdate>(updates: readonly T[]): T[] {
  return [...updates].sort((a, b) => (
    publishedAtMs(b.publishedAt) - publishedAtMs(a.publishedAt) || b.id.localeCompare(a.id)
  ));
}
