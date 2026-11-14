import type { LatestUpdate, LatestUpdateSource } from '@myboon/shared/latest-updates';
import { isFeedMocksEnabled } from './feed-mocks';

/**
 * Mock switch for the Feed latest-update segment (issue #636).
 * Same rules as EXPO_PUBLIC_FEED_MOCKS: only "1", "true" and "on" turn it on.
 * The literal env read is what Expo inlines. Default is off, so an empty
 * live route stays hidden.
 */
export const LATEST_UPDATES_MOCK_ENV_KEY = 'EXPO_PUBLIC_LATEST_UPDATES_MOCK';

export const LATEST_UPDATES_MOCK = isFeedMocksEnabled(process.env.EXPO_PUBLIC_LATEST_UPDATES_MOCK);

export function isLatestUpdatesMockEnabled(value: string | undefined): boolean {
  return isFeedMocksEnabled(value);
}

/** How long the home Feed waits before the loading skeleton opens the layout. */
export const LATEST_UPDATE_LOADING_GRACE_MS = 400;

export interface LatestUpdatesPresentation {
  status: 'loading' | 'empty' | 'unavailable' | 'ready';
  updates: LatestUpdate[];
  message: string | null;
  sample: boolean;
}

export const EMPTY_LATEST_UPDATES: LatestUpdatesPresentation = {
  status: 'empty',
  updates: [],
  message: null,
  sample: false,
};

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
export function sortLatestUpdatesNewestFirst(updates: readonly LatestUpdate[]): LatestUpdate[] {
  return [...updates].sort((a, b) => (
    publishedAtMs(b.publishedAt) - publishedAtMs(a.publishedAt) || b.id.localeCompare(a.id)
  ));
}

/**
 * Same buckets as toRelativeTime in feed.api.ts ("5m ago", "2h ago", "3d ago"),
 * with an explicit clock so the segment and its tests share one instant.
 */
export function latestUpdateTime(iso: string, now: Date): string {
  const publishedAt = Date.parse(iso);
  if (!Number.isFinite(publishedAt)) return 'now';
  const diffMs = Math.max(0, now.getTime() - publishedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

/**
 * Map a section payload to what the segment renders.
 * Null data is still loading. A failure with no rows is unavailable.
 * An empty list hides, unless the mock flag is on, in which case the
 * sample rows stand in so the populated layout can be reviewed.
 * Real rows always win over the sample.
 */
export function presentLatestUpdates(
  data: readonly LatestUpdate[] | null,
  error: string | null,
  mocksEnabled: boolean,
): LatestUpdatesPresentation {
  if (data === null) {
    if (error) return { status: 'unavailable', updates: [], message: error, sample: false };
    return { status: 'loading', updates: [], message: null, sample: false };
  }
  const updates = sortLatestUpdatesNewestFirst(data);
  if (updates.length === 0) {
    if (error) return { status: 'unavailable', updates: [], message: error, sample: false };
    if (mocksEnabled) {
      return {
        status: 'ready',
        updates: sortLatestUpdatesNewestFirst(LATEST_UPDATE_SAMPLES),
        message: null,
        sample: true,
      };
    }
    return { status: 'empty', updates: [], message: null, sample: false };
  }
  return { status: 'ready', updates, message: error, sample: false };
}
