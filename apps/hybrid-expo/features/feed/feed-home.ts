import { isStoryActive } from './feed-mocks';
import type { FeedItem, StorySummary } from './feed.types';

/**
 * Pure helpers for the Feed home "Today" and "Developing story" sections
 * (issue #495, markup per docs/mockups/design-language/feed-mock.html).
 */

/** The five newest reports for the Today carousel, newest first, capped at 5. */
export function todaySlides(items: FeedItem[]): FeedItem[] {
  return items
    .slice()
    // Same ordering contract as the feed list: published_at DESC, id DESC.
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 5);
}

/** Category label for a slide tag chip; the generic feed category reads "Latest". */
export function slideTag(item: FeedItem): string {
  if (item.category === 'feed') return 'Latest';
  if (!item.category) return '';
  return item.category.charAt(0).toUpperCase() + item.category.slice(1);
}

/** Paged-carousel slide index for a scroll offset, clamped into the slide range. */
export function carouselIndex(offsetX: number, slideWidth: number, count: number): number {
  if (count <= 0 || slideWidth <= 0) return 0;
  const index = Math.round(offsetX / slideWidth);
  return Math.max(0, Math.min(count - 1, index));
}

/** The still-active story updated least recently ago, or null when none qualify. */
export function developingStory(stories: StorySummary[], now: Date): StorySummary | null {
  let best: StorySummary | null = null;
  let bestMs = -Infinity;
  for (const story of stories) {
    // isStoryActive also rejects invalid dates, so Date.parse below is safe.
    if (!isStoryActive(story.updatedAt, now)) continue;
    const updatedAtMs = Date.parse(story.updatedAt);
    if (!best || updatedAtMs > bestMs) {
      best = story;
      bestMs = updatedAtMs;
    }
  }
  return best;
}

/** Header line under "Today", e.g. "Mon 26 Oct · 5 updates" / "1 update". */
export function todayLabel(now: Date, count: number): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const updates = count === 1 ? '1 update' : `${count} updates`;
  return `${weekdays[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} · ${updates}`;
}