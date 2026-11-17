import type { LatestUpdate } from '@myboon/shared/latest-updates';
import type { FeedItem, FeedUpdateSource } from '@/features/feed/feed.types';
import { fetchLatestUpdates } from './latest-updates.api';
import {
  LATEST_UPDATES_MOCK,
  LATEST_UPDATE_SAMPLES,
  sortLatestUpdatesNewestFirst,
} from './latest-updates';

const MAX_SOURCE_NAME_LENGTH = 120;
const MAX_LATEST_UPDATES = 30;

export function reportSourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_SOURCE_NAME_LENGTH) return null;
  return name;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toRelativeTime(iso: string): string {
  const createdAt = new Date(iso).getTime();
  if (Number.isNaN(createdAt)) return 'now';

  const diffMs = Math.max(0, Date.now() - createdAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

export function toShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One latest update as a Today slide or an All updates row. The full text stays on the row. */
export function latestUpdateToFeedItem(update: LatestUpdate, index: number): FeedItem {
  const imageUrl = update.imageUrl ?? null;
  return {
    id: update.id,
    category: update.entityName,
    createdAt: update.publishedAt,
    headline: update.headline,
    description: update.whatHappened,
    isTop: index === 0,
    actions: [],
    imageUrl,
    imageKind: imageUrl ? 'content' : null,
    imageAttribution: null,
    sourceName: reportSourceName(update.sources[0]?.title),
    howWeGotHere: update.howWeGotHere,
    whatToWatch: update.whatToWatch,
    sources: update.sources.map((source) => ({
      itemId: source.itemId,
      title: source.title,
      link: source.link,
    })),
  };
}

/** Fields the update sheet reads. No second request: the list row already has the text. */
export function feedItemDetail(item: FeedItem): {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  imageUrl: string | null;
  imageKind: FeedItem['imageKind'];
  imageAttribution: string | null;
  howWeGotHere: string;
  whatToWatch: string;
  sources: FeedUpdateSource[];
} {
  return {
    id: item.id,
    title: item.headline,
    summary: item.description,
    createdAt: item.createdAt,
    imageUrl: item.imageUrl ?? null,
    imageKind: item.imageKind ?? null,
    imageAttribution: item.imageAttribution ?? null,
    howWeGotHere: item.howWeGotHere ?? '',
    whatToWatch: item.whatToWatch ?? '',
    sources: item.sources ?? [],
  };
}

/**
 * Today and All updates. The list route has no offset, so a later page
 * asks for a wider limit and slices. An empty live list can show the
 * sample rows when the mock flag is on. Real rows always win.
 */
export async function fetchFeedItems(limit = 20, offset = 0, options?: { signal?: AbortSignal }): Promise<FeedItem[]> {
  const page = clamp(Math.floor(limit), 1, MAX_LATEST_UPDATES);
  const start = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  if (start >= MAX_LATEST_UPDATES) return [];
  const updates = sortLatestUpdatesNewestFirst(
    await fetchLatestUpdates({ signal: options?.signal, limit: clamp(start + page, 1, MAX_LATEST_UPDATES) }),
  );
  const rows = updates.length === 0 && LATEST_UPDATES_MOCK
    ? sortLatestUpdatesNewestFirst(LATEST_UPDATE_SAMPLES)
    : updates;
  return rows.slice(start, start + page).map((update, index) => latestUpdateToFeedItem(update, start + index));
}
