import type { FeedItem, StorySummary } from './feed.types';

/**
 * Pure helpers for the Feed home hero carousel and "Developing story"
 * sections (issue #495). The hero card follows docs/design/feed.html
 * screen #s-home, section .hx-top, locked for issue #681.
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

export interface TodaySlideLayout {
  /** 'image' renders the full-bleed picture; 'text' uses the longer clamps. */
  variant: 'image' | 'text';
  headlineLines: number;
  summaryLines: number;
}

/**
 * Mock .hx-slide (issue #681): a card with a usable picture clamps headline
 * and summary to two lines. A card without one — no picture in the data, or
 * one that failed to load — drops the image box entirely and gives the text
 * three and six lines. Mock commit 4eefae12 dropped the Read footer.
 */
export function todaySlideLayout(source: Pick<FeedItem, 'imageUrl' | 'imageKind'>, imageFailed = false): TodaySlideLayout {
  const hasImage = source.imageKind === 'content' && Boolean(source.imageUrl) && !imageFailed;
  return hasImage
    ? { variant: 'image', headlineLines: 2, summaryLines: 2 }
    : { variant: 'text', headlineLines: 3, summaryLines: 6 };
}

/** The most recently updated story with a usable timestamp, or null when none qualify. */
export function developingStory(stories: StorySummary[], _now?: Date): StorySummary | null {
  let best: StorySummary | null = null;
  let bestMs = -Infinity;
  for (const story of stories) {
    const updatedAtMs = Date.parse(story.updatedAt);
    if (Number.isNaN(updatedAtMs)) continue;
    if (!best || updatedAtMs > bestMs) {
      best = story;
      bestMs = updatedAtMs;
    }
  }
  return best;
}
