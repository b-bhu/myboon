import type { FeedItem, StorySummary } from './feed.types';

export function selectedStorySlug(stories: StorySummary[], slug: string | null): string | null {
  return stories.find((story) => story.storySlug === slug)?.storySlug ?? stories[0]?.storySlug ?? null;
}

// Incoming rows replace the same report, while already-read older rows stay usable.
// Offset advances by raw page length, not the deduplicated visible count.
export function mergeReports(current: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const rows = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => rows.set(item.id, item));
  return [...rows.values()]
    // Match the API's published_at DESC, id DESC ordering across pages.
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
    .map((item, index) => ({ ...item, isTop: index === 0 }));
}

export function hasChanged(current: unknown, next: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}

export function selectedToken<T extends { identity: { key: string } }>(items: T[], key: string | null): T | undefined {
  return key === null ? items[0] : items.find((item) => item.identity.key === key);
}
