import type { FeedItem, StorySummary } from './feed.types';

export type CalendarMode = 'day' | 'week';

export function shiftCalendarDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function calendarPeriod(date: string, mode: CalendarMode) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const from = mode === 'day' ? date : shiftCalendarDate(date, -((weekday + 6) % 7));
  return { from, to: mode === 'day' ? from : shiftCalendarDate(from, 6) };
}

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
