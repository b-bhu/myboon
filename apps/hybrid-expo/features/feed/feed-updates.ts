import type { FeedItem } from './feed.types';

/**
 * Pure helpers for the "All updates" list and the news bottom sheet
 * (issue #496, markup per docs/mockups/design-language/feed-mock.html
 * #s-todaysheet / #s-allupdates, DESIGN.md sections 7, 12, 15).
 *
 * Deliberately react-free and side-effect free so plain-node tooling
 * (node:test) can exercise every branch, mirroring feed-home.ts.
 */

/** The news sheet fills 90% of the screen height (DESIGN.md 12 / mock). */
export const NEWS_SHEET_RATIO = 0.9;

/** Rounded sheet height for a given screen height. */
export function newsSheetHeight(screenHeight: number): number {
  return Math.round(screenHeight * NEWS_SHEET_RATIO);
}

/**
 * Sheet dismiss decision for a drag release: dismisses over a quarter of the
 * sheet or on a short downward flick, never while dragging upwards.
 */
export function shouldDismissSheet(dy: number, vy: number, sheetHeight: number): boolean {
  if (dy <= 0) return false;
  if (dy > sheetHeight * 0.25) return true;
  return dy > 24 && vy > 0.8;
}

// Same local week/month abbreviations as todayLabel in feed-home.ts.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar-day distance in whole days (negative when the update is ahead of now). */
function calendarDayDistance(iso: string, now: Date): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(now) - startOf(date)) / 86_400_000);
}

/** Group header label for an update timestamp, e.g. 'Today' / 'Yesterday' / 'Mon 26 Oct'. */
export function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = calendarDayDistance(iso, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Mono-capital age for an update, e.g. 'NOW', '5M', '2H', 'YDA', '26 OCT'. */
export function updateAge(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const ms = now.getTime() - date.getTime();
  if (ms < 60_000) return 'NOW';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}M`;
  // Under 24h (or still inside the same local calendar day) reads as hours,
  // so late-night updates stay hour-based across midnight.
  if (calendarDayDistance(iso, now) === 0 || ms < 24 * 3_600_000) return `${Math.floor(ms / 3_600_000)}H`;
  if (calendarDayDistance(iso, now) === 1) return 'YDA';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`.toUpperCase();
}

/** '2H · MACRO' style meta line; the generic feed category reads 'LATEST'. */
export function updateMeta(item: FeedItem, now: Date): string {
  const age = updateAge(item.createdAt, now);
  const category = item.category && item.category !== 'feed' ? item.category.toUpperCase() : 'LATEST';
  return age ? `${age} · ${category}` : category;
}

/**
 * FlatList row model for the "All updates" list: input order is preserved
 * (the API already orders newest first) and a day header row is inserted
 * whenever the local calendar day changes. Unusable timestamps group under
 * an 'Earlier' header at their position.
 */
export type UpdateRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'item'; key: string; item: FeedItem };

const PAD2 = (value: number) => String(value).padStart(2, '0');

function dayRowOf(iso: string, now: Date): UpdateRow & { kind: 'day' } {
  const label = dayLabel(iso, now);
  if (!label) return { kind: 'day', key: 'day-unknown', label: 'Earlier' };
  const date = new Date(iso);
  return {
    kind: 'day',
    key: `day-${date.getFullYear()}-${PAD2(date.getMonth() + 1)}-${PAD2(date.getDate())}`,
    label,
  };
}

export function groupUpdatesByDay(items: FeedItem[], now: Date): UpdateRow[] {
  const rows: UpdateRow[] = [];
  let currentKey: string | null = null;
  for (const item of items) {
    // New header whenever the local calendar day (or 'unknown') changes.
    const header = dayRowOf(item.createdAt, now);
    if (header.key !== currentKey) {
      currentKey = header.key;
      rows.push(header);
    }
    rows.push({ kind: 'item', key: item.id, item });
  }
  return rows;
}